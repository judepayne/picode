import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
} from "../subagent-mode/types.ts";
import type { createStateStore } from "./state.ts";
import type { OrchestratorChildSessionRecord, OrchestratorNodeLogRecord } from "./types.ts";

export const SUBAGENT_STREAM_TOPIC_PREFIX = "picode:subagent-stream:";

const STREAM_SUMMARY_LIMIT = 500;

export interface SubagentStreamEvent {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	agent?: string;
	cursor: string;
	eventType: string;
	event: Record<string, unknown>;
	replay: boolean;
}

export interface OpenSubagentStreamOptions {
	includeThinking?: boolean;
	replay?: "all" | "none" | { afterCursor: string };
}

export type SubagentStreamHandler = (event: SubagentStreamEvent) => void | Promise<void>;

type StateStore = ReturnType<typeof createStateStore>;
type EventBusUnsubscribe = (() => void) | void;

type ActiveStreamService = {
	open(childSessionId: string, handler: SubagentStreamHandler, options?: OpenSubagentStreamOptions): () => void;
};

let activeStreamService: ActiveStreamService | undefined;

export function subagentStreamTopic(childSessionId: string): string {
	return `${SUBAGENT_STREAM_TOPIC_PREFIX}${childSessionId}`;
}

export function setActiveSubagentStreamService(service: ActiveStreamService | undefined): void {
	activeStreamService = service;
}

export function openSubagentStream(childSessionId: string, handler: SubagentStreamHandler, options?: OpenSubagentStreamOptions): () => void {
	if (!activeStreamService) throw new Error("subagent-orchestrator stream service is not active.");
	return activeStreamService.open(childSessionId, handler, options);
}

export function createSubagentStreamService(pi: ExtensionAPI, state: StateStore): ActiveStreamService {
	function open(childSessionId: string, handler: SubagentStreamHandler, options: OpenSubagentStreamOptions = {}): () => void {
		const child = state.getChildSession(childSessionId);
		if (!child) throw new Error(`Child session ${childSessionId} was not found.`);

		let closed = false;
		let replaying = true;
		let handlerQueue = Promise.resolve();
		const seenCursors = new Set<string>();
		const bufferedLive: SubagentStreamEvent[] = [];

		const deliver = (event: SubagentStreamEvent): void => {
			if (closed || seenCursors.has(event.cursor)) return;
			seenCursors.add(event.cursor);
			handlerQueue = handlerQueue.then(async () => {
				if (closed) return;
				try {
					await handler(event);
				} catch (error) {
					warnStreamHandlerError(error);
				}
			});
		};

		const liveHandler = (data: unknown): void => {
			const event = data as SubagentStreamEvent;
			if (!shouldIncludeStreamEvent(event, options)) return;
			if (replaying) {
				bufferedLive.push(event);
				return;
			}
			deliver(event);
		};

		const unsubscribe = pi.events.on(subagentStreamTopic(childSessionId), liveHandler) as EventBusUnsubscribe;

		try {
			for (const record of replayRecords(state, childSessionId, options)) {
				const event = sanitizeNodeLogRecord(record, child, { replay: true });
				if (event && shouldIncludeStreamEvent(event, options)) deliver(event);
			}
		} catch (error) {
			if (typeof unsubscribe === "function") unsubscribe();
			throw error;
		}

		replaying = false;
		for (const event of bufferedLive.sort((a, b) => Number(a.cursor) - Number(b.cursor))) deliver(event);
		bufferedLive.length = 0;

		return () => {
			closed = true;
			if (typeof unsubscribe === "function") unsubscribe();
		};
	}

	return { open };
}

export function emitSubagentStreamRecord(pi: ExtensionAPI, record: OrchestratorNodeLogRecord, child: OrchestratorChildSessionRecord): void {
	const event = sanitizeNodeLogRecord(record, child, { replay: false });
	if (!event) return;
	pi.events.emit(subagentStreamTopic(record.childSessionId), event);
}

function replayRecords(state: StateStore, childSessionId: string, options: OpenSubagentStreamOptions): OrchestratorNodeLogRecord[] {
	const replay = options.replay ?? "all";
	if (replay === "none") return [];
	if (typeof replay === "object") {
		return state.readNodeLogSince(childSessionId, replay.afterCursor).records
			.filter((record) => record.cursor !== replay.afterCursor);
	}
	return state.readNodeLog(childSessionId);
}

function shouldIncludeStreamEvent(event: SubagentStreamEvent, options: OpenSubagentStreamOptions): boolean {
	if (options.includeThinking === true) return true;
	return event.eventType !== EVENT_CHILD_THINKING_START && event.eventType !== EVENT_CHILD_THINKING_END;
}

function sanitizeNodeLogRecord(record: OrchestratorNodeLogRecord, child: OrchestratorChildSessionRecord | undefined, options: { replay: boolean }): SubagentStreamEvent | null {
	return {
		childSessionId: record.childSessionId,
		runId: record.runId,
		...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
		agent: stringField(record.event.agent) ?? child?.agent,
		cursor: record.cursor,
		eventType: record.eventType,
		event: sanitizeEventPayload(record.eventType, record.event),
		replay: options.replay,
	};
}

function sanitizeEventPayload(eventType: string, event: Record<string, unknown>): Record<string, unknown> {
	switch (eventType) {
		case EVENT_CHILD_TOOL_START:
			return compactRecord({
				type: event.type,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				argsElided: event.args !== undefined,
				command: summarizeToolCommand(stringField(event.toolName), event.args),
				argsSummary: summarizeArgumentShape(event.args),
			});
		case EVENT_CHILD_TOOL_END:
			return compactRecord({
				type: event.type,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				ok: event.ok,
				resultElided: true,
				resultSummary: summarizeResultShape(event.resultSummary),
			});
		case EVENT_CHILD_TEXT_FINAL: {
			const text = stringField(event.text) ?? "";
			return compactRecord({
				type: event.type,
				textElided: true,
				charCount: text.length,
			});
		}
		case EVENT_CHILD_PROGRESS:
			return compactRecord({
				type: event.type,
				currentTool: event.currentTool,
				toolCount: event.toolCount,
				recentOutputElided: event.recentOutput !== undefined,
				recentOutputSummary: summarizeResultShape(event.recentOutput),
			});
		case EVENT_CHILD_COMPLETE: {
			const result = asRecord(event.result);
			return compactRecord({
				type: event.type,
				status: result?.status,
				error: truncateString(stringField(result?.error), STREAM_SUMMARY_LIMIT),
				finalTextElided: typeof result?.finalText === "string",
				finalTextCharCount: typeof result?.finalText === "string" ? result.finalText.length : undefined,
				sessionFile: result?.sessionFile,
				usage: result?.usage,
			});
		}
		case EVENT_CHILD_THINKING_END:
			return compactRecord({
				type: event.type,
				summary: truncateString(stringField(event.summary), STREAM_SUMMARY_LIMIT),
			});
		default:
			return sanitizeDefaultEvent(event);
	}
}

function sanitizeDefaultEvent(event: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event)) {
		if (key === "args" || key === "result" || key === "text") {
			sanitized[`${key}Elided`] = true;
			continue;
		}
		if (typeof value === "string") sanitized[key] = truncateString(value, STREAM_SUMMARY_LIMIT);
		else sanitized[key] = value;
	}
	return sanitized;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function summarizeToolCommand(toolName: string | undefined, args: unknown): string | undefined {
	const record = asRecord(args);
	if (!toolName || !record) return undefined;
	switch (toolName) {
		case "bash":
			return truncateString(stringField(record.command), STREAM_SUMMARY_LIMIT);
		case "read":
			return formatToolCommand("read", compactRecord({ path: record.path, offset: record.offset, limit: record.limit }));
		case "ls":
			return formatToolCommand("ls", compactRecord({ path: record.path, limit: record.limit }));
		case "grep":
			return formatToolCommand("grep", compactRecord({ pattern: record.pattern, path: record.path, glob: record.glob, ignoreCase: record.ignoreCase, literal: record.literal, context: record.context, limit: record.limit }));
		case "find":
			return formatToolCommand("find", compactRecord({ pattern: record.pattern, path: record.path, limit: record.limit }));
		case "edit":
			return formatToolCommand("edit", compactRecord({ path: record.path, edits: Array.isArray(record.edits) ? record.edits.length : undefined }));
		case "write":
			return formatToolCommand("write", compactRecord({ path: record.path, contentElided: record.content !== undefined }));
		default:
			return formatToolCommand(toolName, shapeRecord(record));
	}
}

function formatToolCommand(toolName: string, args: Record<string, unknown>): string {
	return `${toolName} ${JSON.stringify(args)}`;
}

function shapeRecord(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Array.isArray(entry) ? "array" : typeof entry]));
}

function summarizeResultShape(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return summarizeArgumentShape(value);
	try {
		const parsed = JSON.parse(value) as unknown;
		return summarizeArgumentShape(parsed);
	} catch {
		return "string";
	}
}

function summarizeArgumentShape(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) return `array(${value.length})`;
	if (typeof value !== "object") return typeof value;
	const entries = Object.entries(value as Record<string, unknown>)
		.slice(0, 10)
		.map(([key, entry]) => `${key}:${Array.isArray(entry) ? "array" : typeof entry}`);
	const suffix = Object.keys(value as Record<string, unknown>).length > entries.length ? ",…" : "";
	return `{${entries.join(",")}${suffix}}`;
}

function truncateString(value: string | undefined, limit: number): string | undefined {
	if (value === undefined) return undefined;
	if (value.length <= limit) return value;
	return `${value.slice(0, limit - 1)}…`;
}

function warnStreamHandlerError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[subagent-orchestrator] stream handler failed: ${message}`);
}

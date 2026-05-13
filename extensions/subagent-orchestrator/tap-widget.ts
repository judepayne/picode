import {
	EVENT_CHILD_CANCELLED,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
} from "../subagent-mode/types.ts";
import type { SubagentStreamEvent } from "./stream.ts";

export const TAP_WIDGET_KEY = "subagent-orchestrator-tap";
export const TAP_STATUS_KEY = "subagent-orchestrator-tap";
export const TAP_WIDGET_MAX_LINES = 16;

const MAX_ROWS = 80;
const LINE_LIMIT = 140;
const MAX_PENDING_TEXT_CHARS = 4000;
const TAP_WIDGET_RULE = "─".repeat(96);

export interface TapWidgetState {
	crumb?: string;
	selectedChildSessionId?: string;
	rows: string[];
	pendingText?: string;
	pendingTextRowIndex?: number;
}

function truncate(text: string, limit = LINE_LIMIT): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
	return typeof record[key] === "boolean" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

export function formatTapStreamEvent(event: SubagentStreamEvent): string | undefined {
	const payload = event.event;
	switch (event.eventType) {
		case EVENT_CHILD_STARTED:
			return `started ${event.agent ?? stringField(payload, "agent") ?? "subagent"}`;
		case EVENT_CHILD_TOOL_START: {
			const command = stringField(payload, "command");
			const toolName = stringField(payload, "toolName") ?? "tool";
			return `▶ ${truncate(command ?? toolName)}`;
		}
		case EVENT_CHILD_TOOL_END: {
			const toolName = stringField(payload, "toolName") ?? "tool";
			return `${booleanField(payload, "ok") === false ? "✗" : "✓"} ${toolName}`;
		}
		case EVENT_CHILD_TEXT_DELTA: {
			const delta = rawStringField(payload, "delta") ?? rawStringField(payload, "text") ?? rawStringField(payload, "summary");
			return delta ? truncate(delta) : undefined;
		}
		case EVENT_CHILD_TEXT_FINAL: {
			const count = numberField(payload, "charCount");
			return count === undefined ? "final text" : `final text (${count} chars)`;
		}
		case EVENT_CHILD_PROGRESS: {
			const currentTool = stringField(payload, "currentTool") ?? stringField(payload, "toolName");
			const status = stringField(payload, "status");
			return `… ${truncate(currentTool ?? status ?? "progress")}`;
		}
		case EVENT_CHILD_COMPLETE:
			return "complete";
		case EVENT_CHILD_ERROR:
			return `error: ${truncate(stringField(payload, "message") ?? stringField(payload, "error") ?? "subagent failed")}`;
		case EVENT_CHILD_CANCELLED:
			return `cancelled${stringField(payload, "reason") ? `: ${truncate(stringField(payload, "reason")!)}` : ""}`;
		default:
			return truncate(event.eventType);
	}
}

export function createTapWidgetState(): TapWidgetState {
	return { rows: [] };
}

export function resetTapWidget(state: TapWidgetState, input: { crumb?: string; selectedChildSessionId?: string }): void {
	state.crumb = input.crumb;
	state.selectedChildSessionId = input.selectedChildSessionId;
	state.rows = [];
	state.pendingText = undefined;
	state.pendingTextRowIndex = undefined;
}

function wrapText(text: string, width = 96, maxLines = 8): string {
	const lines: string[] = [];
	for (const rawLine of text.replace(/\r/g, "").split("\n")) {
		let line = rawLine;
		while (line.length > width) {
			lines.push(line.slice(0, width));
			line = line.slice(width);
		}
		if (line || rawLine === "") lines.push(line);
	}
	return lines.slice(-maxLines).join("\n");
}

function pushRow(state: TapWidgetState, row: string): void {
	state.pendingText = undefined;
	state.pendingTextRowIndex = undefined;
	state.rows.push(row);
	if (state.rows.length > MAX_ROWS) state.rows.splice(0, state.rows.length - MAX_ROWS);
}

export function appendTapWidgetEvent(state: TapWidgetState, event: SubagentStreamEvent): void {
	if (event.eventType === EVENT_CHILD_TEXT_DELTA) {
		const delta = rawStringField(event.event, "delta") ?? rawStringField(event.event, "text") ?? rawStringField(event.event, "summary");
		if (!delta) return;
		if (state.pendingTextRowIndex === undefined || state.pendingTextRowIndex < 0 || state.pendingTextRowIndex >= state.rows.length) {
			state.pendingTextRowIndex = state.rows.length;
			state.rows.push("");
		}
		state.pendingText = `${state.pendingText ?? ""}${delta}`;
		if (state.pendingText.length > MAX_PENDING_TEXT_CHARS) state.pendingText = state.pendingText.slice(-MAX_PENDING_TEXT_CHARS);
		state.rows[state.pendingTextRowIndex] = wrapText(state.pendingText);
		if (state.rows.length > MAX_ROWS) {
			const removed = state.rows.length - MAX_ROWS;
			state.rows.splice(0, removed);
			state.pendingTextRowIndex = Math.max(0, state.pendingTextRowIndex - removed);
		}
		return;
	}
	const row = formatTapStreamEvent(event);
	if (!row) return;
	pushRow(state, row);
}

function padWidgetLines(lines: string[]): string[] {
	const padded = lines.slice(0, TAP_WIDGET_MAX_LINES);
	while (padded.length < TAP_WIDGET_MAX_LINES) padded.push("");
	return padded;
}

export function renderTapWidgetLines(state: TapWidgetState): string[] {
	if (!state.selectedChildSessionId) return padWidgetLines([TAP_WIDGET_RULE]);
	const body = state.rows.length > 0
		? state.rows.flatMap((row) => row.split("\n")).filter((line) => line.length > 0).slice(-(TAP_WIDGET_MAX_LINES - 1))
		: [];
	return padWidgetLines([TAP_WIDGET_RULE, ...body]);
}

import * as fs from "node:fs";
import * as path from "node:path";

import {
	EVENT_CHILD_CANCELLED as SUBAGENT_MODE_CHILD_CANCELLED_EVENT,
	EVENT_CHILD_COMPLETE as SUBAGENT_MODE_CHILD_COMPLETE_EVENT,
	EVENT_CHILD_ERROR as SUBAGENT_MODE_CHILD_ERROR_EVENT,
	EVENT_CHILD_PROGRESS as SUBAGENT_MODE_CHILD_PROGRESS_EVENT,
	EVENT_CHILD_STARTED as SUBAGENT_MODE_CHILD_STARTED_EVENT,
	EVENT_CHILD_TEXT_DELTA as SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT,
	EVENT_CHILD_TEXT_FINAL as SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT,
	EVENT_CHILD_THINKING_END as SUBAGENT_MODE_CHILD_THINKING_END_EVENT,
	EVENT_CHILD_THINKING_START as SUBAGENT_MODE_CHILD_THINKING_START_EVENT,
	EVENT_CHILD_TOOL_END as SUBAGENT_MODE_CHILD_TOOL_END_EVENT,
	EVENT_CHILD_TOOL_START as SUBAGENT_MODE_CHILD_TOOL_START_EVENT,
	EVENT_SUBAGENT_EXPANDED_TASK,
} from "../subagent-mode/types.ts";
import { shortenDisplayPath } from "./run-ui.ts";
import type { LoggedChildEvent } from "./event-handlers.ts";
import type {
	OrchestratorChildSessionRecord,
	OrchestratorHandbackRecord,
	OrchestratorNodeLogRecord,
	OrchestratorRunRecord,
	OrchestratorTreeDetails,
	OrchestratorTreeNodeDetails,
	RunOrigin,
} from "./types.ts";

export const STATUS_LIST_LIMIT = 10;
const STATUS_LIST_TEXT_LIMIT = 300;

function normalizeRunOrigin(value: unknown): RunOrigin {
	return value === "user" ? "user" : "agent";
}

function isRunning(status: string): boolean {
	return status === "running";
}

function truncateDisplayText(text: string | undefined, limit = STATUS_LIST_TEXT_LIMIT): string | undefined {
	if (typeof text !== "string" || !text.trim()) return undefined;
	const normalized = text.trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function childOutputLogPath(child: Pick<OrchestratorChildSessionRecord, "asyncDir" | "childIndex">): string | undefined {
	if (!child.asyncDir) return undefined;
	const outputPath = path.join(child.asyncDir, `output-${child.childIndex}.log`);
	return fs.existsSync(outputPath) ? outputPath : undefined;
}

function childOpenCommand(child: Pick<OrchestratorChildSessionRecord, "sessionFile">): string | undefined {
	return child.sessionFile ? `pi --session ${quoteShellArg(child.sessionFile)}` : undefined;
}

function childViewCommand(child: Pick<OrchestratorChildSessionRecord, "asyncDir" | "childIndex">): string | undefined {
	const outputPath = childOutputLogPath(child);
	return outputPath ? `tail -f ${quoteShellArg(outputPath)}` : undefined;
}

function resolveSelectedChildIndex(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[]): number | undefined {
	if (children.length === 0) return undefined;
	if (typeof run.selectedChildIndex === "number" && children.some((child) => child.childIndex === run.selectedChildIndex)) {
		return run.selectedChildIndex;
	}
	const active = children.find((child) => isRunning(child.status)) ?? children.find((child) => child.status !== "complete" && child.status !== "failed" && child.status !== "cancelled");
	return active?.childIndex ?? children[0]?.childIndex;
}

export function selectRunChild(stateStore: {
	getRun(runId: string): OrchestratorRunRecord | undefined;
	listChildSessionsByRun(runId: string): OrchestratorChildSessionRecord[];
	updateRun(runId: string, patch: Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
}, runId: string, direction: "next" | "prev" | "select", childIndex?: number): { run?: OrchestratorRunRecord; child?: OrchestratorChildSessionRecord; error?: string } {
	const run = stateStore.getRun(runId);
	if (!run) return { error: `Run ${runId} was not found.` };
	const children = stateStore.listChildSessionsByRun(runId);
	if (children.length === 0) return { error: `Run ${runId} has no child sessions.` };
	const ordered = [...children].sort((a, b) => a.childIndex - b.childIndex);
	const current = resolveSelectedChildIndex(run, ordered) ?? ordered[0]!.childIndex;
	let nextIndex = current;
	if (direction === "select") {
		if (typeof childIndex !== "number" || !Number.isInteger(childIndex)) return { error: "childIndex must be an integer for action: \"select\"." };
		if (!ordered.some((child) => child.childIndex === childIndex)) return { error: `Run ${runId} has no child with index ${childIndex}.` };
		nextIndex = childIndex;
	} else {
		const currentPos = Math.max(0, ordered.findIndex((child) => child.childIndex === current));
		const delta = direction === "next" ? 1 : -1;
		const nextPos = (currentPos + delta + ordered.length) % ordered.length;
		nextIndex = ordered[nextPos]!.childIndex;
	}
	const updated = stateStore.updateRun(runId, { selectedChildIndex: nextIndex, updatedAt: Date.now() }) ?? run;
	const selectedChild = ordered.find((child) => child.childIndex === nextIndex);
	return { run: updated, child: selectedChild };
}

export function formatRunList(
	runs: OrchestratorRunRecord[],
	ownerModeId: string,
	childLookup?: (runId: string) => OrchestratorChildSessionRecord[],
): string {
	if (runs.length === 0) return `No subagent orchestrator runs found for mode ${ownerModeId}.`;
	const visibleRuns = runs.slice(0, STATUS_LIST_LIMIT);
	const lines = [`Subagent orchestrator runs for mode ${ownerModeId}:`, ""];
	if (runs.length > visibleRuns.length) {
		lines.push(`Showing ${visibleRuns.length} of ${runs.length} runs. Use action: "get" with a runId for full details.`);
		lines.push("");
	}
	for (const run of visibleRuns) {
		lines.push(`- ${run.orchestratorRunId} | ${run.status} | ${run.requestShape} | async=${run.async} | context=${run.context} | origin=${normalizeRunOrigin(run.origin)}${run.agent ? ` | agent=${run.agent}` : ""}`);
		lines.push(`  task: ${truncateDisplayText(run.taskSummary) ?? run.taskSummary}`);
		lines.push(`  children: ${run.activeChildCount ?? 0}/${run.childSessionCount ?? 0} running | queued handbacks: ${run.queuedHandbackCount ?? 0}`);
		if (run.selectedChildIndex !== undefined) lines.push(`  focused child: [${run.selectedChildIndex}]`);
		const children = childLookup?.(run.orchestratorRunId) ?? [];
		const activeChildren = children.filter((child) => isRunning(child.status));
		if (activeChildren.length > 0) {
			lines.push("  running child sessions:");
			for (const child of activeChildren) {
				const childBits = [`[${child.childIndex}]`, child.status, child.taskSummary];
				if (child.currentTool) childBits.push(`tool=${child.currentTool}${child.toolCount !== undefined ? `(${child.toolCount})` : ""}`);
				lines.push(`    - ${childBits.join(" | ")}`);
				if (child.sessionFile) lines.push(`      session: ${shortenDisplayPath(child.sessionFile)}`);
				const open = childOpenCommand(child);
				if (open) lines.push(`      open: ${open}`);
				const view = childViewCommand(child);
				if (view) lines.push(`      view: ${view}`);
			}
		}
		const resultSummary = truncateDisplayText(run.resultSummary);
		const error = truncateDisplayText(run.error);
		if (resultSummary) lines.push(`  result: ${resultSummary}`);
		if (error) lines.push(`  error: ${error}`);
	}
	return lines.join("\n");
}

export function summarizeRunForListDetails(run: OrchestratorRunRecord): Record<string, unknown> {
	return {
		orchestratorRunId: run.orchestratorRunId,
		status: run.status,
		requestShape: run.requestShape,
		async: run.async,
		context: run.context,
		origin: normalizeRunOrigin(run.origin),
		...(run.agent ? { agent: run.agent } : {}),
		taskSummary: truncateDisplayText(run.taskSummary) ?? run.taskSummary,
		childSessionCount: run.childSessionCount ?? 0,
		activeChildCount: run.activeChildCount ?? 0,
		queuedHandbackCount: run.queuedHandbackCount ?? 0,
		...(run.selectedChildIndex !== undefined ? { selectedChildIndex: run.selectedChildIndex } : {}),
		...(truncateDisplayText(run.resultSummary) ? { resultSummary: truncateDisplayText(run.resultSummary) } : {}),
		...(truncateDisplayText(run.error) ? { error: truncateDisplayText(run.error) } : {}),
	};
}

export function formatRunDetails(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[], handbacks: OrchestratorHandbackRecord[]): string {
	const lines = [
		`runId: ${run.orchestratorRunId}`,
		`ownerModeId: ${run.ownerModeId}`,
		`status: ${run.status}`,
		`shape: ${run.requestShape}`,
		`async: ${run.async}`,
		`context: ${run.context}`,
		`origin: ${normalizeRunOrigin(run.origin)}`,
		run.agent ? `agent: ${run.agent}` : undefined,
		`taskSummary: ${run.taskSummary}`,
		run.underlyingRequestId ? `underlyingRequestId: ${run.underlyingRequestId}` : undefined,
		run.underlyingRunId ? `underlyingRunId: ${run.underlyingRunId}` : undefined,
		run.pid !== undefined ? `pid: ${run.pid}` : undefined,
		run.asyncDir ? `asyncDir: ${run.asyncDir}` : undefined,
		run.resultSummary ? `resultSummary: ${run.resultSummary}` : undefined,
		run.error ? `error: ${run.error}` : undefined,
		`childSessions: ${children.length}`,
		`queuedHandbacks: ${handbacks.filter((entry) => entry.status === "queued").length}`,
		run.selectedChildIndex !== undefined ? `selectedChildIndex: ${run.selectedChildIndex}` : undefined,
	].filter(Boolean);
	if (children.length > 0) {
		lines.push("", "Child sessions:");
		for (const child of children) {
			lines.push(`- [${child.childIndex}] ${child.status} | ${child.taskSummary}`);
			if (child.currentTool) lines.push(`  tool: ${child.currentTool}${child.toolCount !== undefined ? ` (${child.toolCount})` : ""}`);
			if (child.sessionFile) lines.push(`  session: ${shortenDisplayPath(child.sessionFile)}`);
			const open = childOpenCommand(child);
			if (open) lines.push(`  open: ${open}`);
			const view = childViewCommand(child);
			if (view) lines.push(`  view: ${view}`);
			if (child.recentOutput && child.recentOutput.length > 0) {
				lines.push("  recentOutput:");
				for (const line of child.recentOutput.slice(-4)) lines.push(`    ${line}`);
			}
			if (child.resultSummary) lines.push(`  result: ${child.resultSummary}`);
			if (child.error) lines.push(`  error: ${child.error}`);
		}
	}
	if (handbacks.length > 0) {
		lines.push("", "Handbacks:");
		for (const handback of handbacks) {
			lines.push(`- ${handback.handbackId} | ${handback.status} | ${handback.summary}`);
		}
	}
	return lines.join("\n");
}

function isThinkingEventType(type: string | undefined): boolean {
	return type === SUBAGENT_MODE_CHILD_THINKING_START_EVENT || type === SUBAGENT_MODE_CHILD_THINKING_END_EVENT;
}

export function filterNodeLogRecords(records: OrchestratorNodeLogRecord[], includeThinking: boolean): OrchestratorNodeLogRecord[] {
	return includeThinking ? records : records.filter((record) => !isThinkingEventType(record.eventType));
}

export function formatNodeLogLines(records: OrchestratorNodeLogRecord[]): string {
	if (records.length === 0) return "No log records found.";
	const lines: string[] = [];
	let textBuffer = "";

	const flushTextBuffer = (): void => {
		if (!textBuffer) return;
		lines.push(`assistant: ${textBuffer}`);
		textBuffer = "";
	};

	for (const record of records) {
		const event = record.event as LoggedChildEvent;
		switch (record.eventType) {
			case SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT:
				textBuffer += typeof event.delta === "string" ? event.delta : "";
				continue;
			case SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT:
				if (typeof event.text === "string") textBuffer = event.text;
				flushTextBuffer();
				continue;
			default:
				flushTextBuffer();
		}

		switch (record.eventType) {
			case EVENT_SUBAGENT_EXPANDED_TASK:
				lines.push(`expanded task: ${typeof event.task === "string" ? event.task : ""}`);
				break;
			case SUBAGENT_MODE_CHILD_STARTED_EVENT:
				lines.push(`started ${event.agent ?? "child"}`);
				break;
			case SUBAGENT_MODE_CHILD_THINKING_START_EVENT:
				lines.push("thinking started");
				break;
			case SUBAGENT_MODE_CHILD_THINKING_END_EVENT:
				lines.push(typeof event.summary === "string" && event.summary.trim() ? `thinking ended: ${event.summary}` : "thinking ended");
				break;
			case SUBAGENT_MODE_CHILD_TOOL_START_EVENT:
				lines.push(`tool start: ${typeof event.toolName === "string" ? event.toolName : "unknown"}`);
				break;
			case SUBAGENT_MODE_CHILD_TOOL_END_EVENT:
				lines.push(`tool end: ${typeof event.toolName === "string" ? event.toolName : "unknown"}${event.ok === false ? " (error)" : ""}${typeof event.resultSummary === "string" && event.resultSummary.trim() ? ` — ${event.resultSummary}` : ""}`);
				break;
			case SUBAGENT_MODE_CHILD_PROGRESS_EVENT:
				lines.push(`progress: ${typeof event.currentTool === "string" ? event.currentTool : "running"}${typeof event.recentOutput === "string" && event.recentOutput.trim() ? ` — ${event.recentOutput}` : ""}`);
				break;
			case SUBAGENT_MODE_CHILD_ERROR_EVENT:
				lines.push(`error: ${typeof event.message === "string" ? event.message : "child error"}`);
				break;
			case SUBAGENT_MODE_CHILD_CANCELLED_EVENT:
				lines.push(typeof event.reason === "string" && event.reason.trim() ? `cancelled: ${event.reason}` : "cancelled");
				break;
			case SUBAGENT_MODE_CHILD_COMPLETE_EVENT: {
				const result = event.result;
				const status = typeof result?.status === "string" ? result.status : "complete";
				const finalText = typeof result?.finalText === "string" ? result.finalText.trim() : "";
				lines.push(finalText ? `complete: ${status} — ${finalText}` : `complete: ${status}`);
				break;
			}
		}
	}

	flushTextBuffer();
	return lines.join("\n");
}

export function buildTreeNodes(children: OrchestratorTreeNodeDetails[]): OrchestratorTreeNodeDetails[] {
	const byParent = new Map<string | undefined, OrchestratorTreeNodeDetails[]>();
	for (const child of children) {
		const key = child.parentChildSessionId;
		const bucket = byParent.get(key) ?? [];
		bucket.push(child);
		byParent.set(key, bucket);
	}
	const sortChildren = (items: OrchestratorTreeNodeDetails[]): OrchestratorTreeNodeDetails[] => items.sort((a, b) => a.childIndex - b.childIndex || (a.taskIndex ?? a.stepIndex ?? 0) - (b.taskIndex ?? b.stepIndex ?? 0));
	const attach = (parentId?: string): OrchestratorTreeNodeDetails[] => sortChildren([...(byParent.get(parentId) ?? [])]).map((child) => ({ ...child, children: attach(child.childSessionId) }));
	return attach(undefined);
}

export function formatTree(details: OrchestratorTreeDetails): string {
	const lines = [
		`rootRunId: ${details.rootRunId}`,
		`ownerModeId: ${details.ownerModeId}`,
		`status: ${details.status}`,
		`shape: ${details.async ? "async" : "sync"} ${details.context}`,
		`taskSummary: ${details.taskSummary}`,
		"",
		"Tree:",
	];
	if (details.nodes.length === 0) {
		lines.push("(no child nodes)");
		return lines.join("\n");
	}
	const visit = (nodes: OrchestratorTreeNodeDetails[], prefix: string): void => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index]!;
			const branch = index === nodes.length - 1 ? "└─" : "├─";
			const nextPrefix = `${prefix}${index === nodes.length - 1 ? "  " : "│ "}`;
			const parts = [`[${node.childIndex}]`, node.agent, node.status, node.taskSummary];
			if (node.currentTool) parts.push(`tool=${node.currentTool}${node.toolCount !== undefined ? `(${node.toolCount})` : ""}`);
			lines.push(`${prefix}${branch} ${parts.join(" | ")}`);
			lines.push(`${nextPrefix}childSessionId: ${node.childSessionId}`);
			if (node.resultSummary) lines.push(`${nextPrefix}result: ${node.resultSummary}`);
			if (node.error) lines.push(`${nextPrefix}error: ${node.error}`);
			visit(node.children, nextPrefix);
		}
	};
	visit(details.nodes, "");
	return lines.join("\n");
}

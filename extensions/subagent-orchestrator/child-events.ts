import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	EVENT_CHILD_CANCELLED as SUBAGENT_MODE_CHILD_CANCELLED_EVENT,
	EVENT_CHILD_COMPLETE as SUBAGENT_MODE_CHILD_COMPLETE_EVENT,
	EVENT_CHILD_ERROR as SUBAGENT_MODE_CHILD_ERROR_EVENT,
	EVENT_CHILD_PROGRESS as SUBAGENT_MODE_CHILD_PROGRESS_EVENT,
	EVENT_CHILD_STARTED as SUBAGENT_MODE_CHILD_STARTED_EVENT,
	EVENT_CHILD_TEXT_DELTA as SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT,
	EVENT_CHILD_TEXT_FINAL as SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT,
	EVENT_CHILD_TOOL_END as SUBAGENT_MODE_CHILD_TOOL_END_EVENT,
	EVENT_CHILD_TOOL_START as SUBAGENT_MODE_CHILD_TOOL_START_EVENT,
} from "../subagent-mode/types.ts";
import type { LoggedChildEvent } from "./event-handlers.ts";
import { summarizeHandbackText } from "./handbacks.ts";
import { emitSubagentStreamRecord } from "./stream.ts";
import type { OrchestratorChildSessionRecord, OrchestratorNodeLogRecord, RunStatus } from "./types.ts";

const TEXT_DELTA_STATE_FLUSH_INTERVAL_MS = 500;
const RUN_AGGREGATE_REFRESH_INTERVAL_MS = 100;

export interface ChildEventState {
	listChildSessionsByRun(runId: string): OrchestratorChildSessionRecord[];
	findChildSessionByRunAndExecutionChildId(runId: string, executionChildId: string): OrchestratorChildSessionRecord | undefined;
	getChildSession(childSessionId: string): OrchestratorChildSessionRecord | undefined;
	updateChildSession(childSessionId: string, patch: Partial<OrchestratorChildSessionRecord>): OrchestratorChildSessionRecord | undefined;
	appendNodeLogRecord(childSessionId: string, record: Omit<OrchestratorNodeLogRecord, "cursor">): OrchestratorNodeLogRecord;
}

export interface ChildEventControllerInput {
	pi: ExtensionAPI;
	state: ChildEventState;
	isTerminal(status: RunStatus): boolean;
	appendChildEntry(child: OrchestratorChildSessionRecord, event: "created" | "updated" | "completed" | "cancelled"): void;
	refreshRunAggregates(runId: string): void;
	refreshRunMessageSnapshot(runId: string): void;
	bindStickyUserSubagentSessionToRun(runId: string, sticky: { sessionFile: string; childSessionId: string; lastUsedAt: number }): void;
}

export interface ChildEventController {
	appendNodeLogForChild(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): OrchestratorNodeLogRecord;
	handleChildEvent(runId: string, event: LoggedChildEvent, appendEntryOnUpdate?: boolean): void;
	warnDroppedChildEvent(runId: string, event: LoggedChildEvent, reason: string): void;
	clearPendingTextDeltaFlushes(): void;
}

function boundedRecentOutput(lines: string[] | undefined, limit = 6): string[] | undefined {
	if (!Array.isArray(lines)) return undefined;
	const normalized = lines.map((line) => line.trim()).filter(Boolean).slice(-limit);
	return normalized.length > 0 ? normalized : undefined;
}

function finalAnswerRecentOutput(text: string | undefined, limit = 4): string[] | undefined {
	if (typeof text !== "string") return undefined;
	return boundedRecentOutput(text.split(/\r?\n/), limit);
}

export function createChildEventController(input: ChildEventControllerInput): ChildEventController {
	const pendingTextDeltaFlushes = new Map<string, { runId: string; chunks: string[]; timer: ReturnType<typeof setTimeout> | null }>();
	const pendingAggregateRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

	function findEventChildByIndex(runId: string, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		const children = input.state.listChildSessionsByRun(runId);
		if (children.length === 0) return undefined;
		if (typeof event.stepIndex === "number" && typeof event.taskIndex === "number") {
			const matches = children.filter((child) => child.stepIndex === event.stepIndex && child.taskIndex === event.taskIndex);
			if (matches.length === 1) return matches[0];
		}
		if (typeof event.stepIndex === "number") {
			const stepMatches = children.filter((child) => child.stepIndex === event.stepIndex && child.taskIndex === undefined);
			if (stepMatches.length === 1) return stepMatches[0];
		}
		if (typeof event.taskIndex === "number") {
			const taskMatches = children.filter((child) => child.stepIndex === undefined && child.taskIndex === event.taskIndex);
			if (taskMatches.length === 1) return taskMatches[0];
		}
		return children.length === 1 ? children[0] : undefined;
	}

	function resolveChildSessionForEvent(runId: string, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		if (typeof event.childId === "string") {
			const existing = input.state.findChildSessionByRunAndExecutionChildId(runId, event.childId);
			if (existing) return existing;
		}
		return findEventChildByIndex(runId, event);
	}

	function warnDroppedChildEvent(runId: string, event: LoggedChildEvent, reason: string): void {
		if (process.env.PI_DEBUG_SUBAGENT_ORCHESTRATOR !== "1") return;
		const eventType = typeof event.type === "string" ? event.type : "unknown";
		console.warn(`[subagent-orchestrator] dropped child event for run ${runId}: ${eventType} (${reason})`);
	}

	function appendNodeLogForChild(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): OrchestratorNodeLogRecord {
		const record = input.state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
			timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
			eventType: typeof event.type === "string" ? event.type : "unknown",
			event,
		});
		emitSubagentStreamRecord(input.pi, record, child);
		return record;
	}

	function clearPendingTextDeltaState(childSessionId: string): void {
		const pendingFlush = pendingTextDeltaFlushes.get(childSessionId);
		if (!pendingFlush) return;
		if (pendingFlush.timer) clearTimeout(pendingFlush.timer);
		pendingTextDeltaFlushes.delete(childSessionId);
	}

	function flushPendingTextDeltaState(childSessionId: string): void {
		const pendingFlush = pendingTextDeltaFlushes.get(childSessionId);
		if (!pendingFlush) return;
		if (pendingFlush.timer) {
			clearTimeout(pendingFlush.timer);
			pendingFlush.timer = null;
		}
		const text = pendingFlush.chunks.join("");
		pendingFlush.chunks = [];
		if (!text) {
			pendingTextDeltaFlushes.delete(childSessionId);
			return;
		}
		const child = input.state.getChildSession(childSessionId);
		if (!child || input.isTerminal(child.status)) {
			pendingTextDeltaFlushes.delete(childSessionId);
			return;
		}
		input.state.updateChildSession(childSessionId, {
			status: child.status === "cancelled" ? child.status : "running",
			updatedAt: Date.now(),
			recentOutput: boundedRecentOutput([...(child.recentOutput ?? []), text]),
		});
		input.refreshRunMessageSnapshot(pendingFlush.runId);
	}

	function scheduleTextDeltaStateFlush(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): void {
		const delta = typeof event.delta === "string" ? event.delta : "";
		if (!delta) return;
		const pendingFlush = pendingTextDeltaFlushes.get(child.childSessionId) ?? { runId: child.runId, chunks: [], timer: null };
		pendingFlush.chunks.push(delta);
		pendingFlush.runId = child.runId;
		if (!pendingFlush.timer) {
			pendingFlush.timer = setTimeout(() => flushPendingTextDeltaState(child.childSessionId), TEXT_DELTA_STATE_FLUSH_INTERVAL_MS);
			pendingFlush.timer.unref?.();
		}
		pendingTextDeltaFlushes.set(child.childSessionId, pendingFlush);
	}

	function scheduleRunAggregateRefresh(runId: string): void {
		if (pendingAggregateRefreshes.has(runId)) return;
		const timer = setTimeout(() => {
			pendingAggregateRefreshes.delete(runId);
			input.refreshRunAggregates(runId);
		}, RUN_AGGREGATE_REFRESH_INTERVAL_MS);
		timer.unref?.();
		pendingAggregateRefreshes.set(runId, timer);
	}

	function refreshRunAggregatesNow(runId: string): void {
		const timer = pendingAggregateRefreshes.get(runId);
		if (timer) {
			clearTimeout(timer);
			pendingAggregateRefreshes.delete(runId);
		}
		input.refreshRunAggregates(runId);
	}

	function updateChildSessionFromEvent(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		if (child.status === "cancelled" && event.type !== SUBAGENT_MODE_CHILD_CANCELLED_EVENT) return undefined;
		const now = typeof event.timestamp === "number" ? event.timestamp : Date.now();
		const runningStatus = input.isTerminal(child.status) ? child.status : "running";
		switch (event.type) {
			case SUBAGENT_MODE_CHILD_STARTED_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: runningStatus,
					updatedAt: now,
					...(typeof event.childId === "string" ? { executionChildId: event.childId } : {}),
					...(typeof event.sessionFile === "string" ? { sessionFile: event.sessionFile } : {}),
				});
			case SUBAGENT_MODE_CHILD_TOOL_START_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: runningStatus,
					updatedAt: now,
					...(typeof event.toolName === "string" ? { currentTool: event.toolName } : {}),
					toolCount: (child.toolCount ?? 0) + 1,
				});
			case SUBAGENT_MODE_CHILD_TOOL_END_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					updatedAt: now,
					...(typeof event.toolName === "string" ? { currentTool: event.toolName } : {}),
					...(event.ok === false ? { failedToolCount: (child.failedToolCount ?? 0) + 1 } : {}),
				});
			case SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: runningStatus,
					updatedAt: now,
					recentOutput: boundedRecentOutput([...(child.recentOutput ?? []), typeof event.delta === "string" ? event.delta : ""]),
				});
			case SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: runningStatus,
					updatedAt: now,
					...(typeof event.text === "string" ? { recentOutput: finalAnswerRecentOutput(event.text) } : {}),
				});
			case SUBAGENT_MODE_CHILD_PROGRESS_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: runningStatus,
					updatedAt: now,
					...(typeof event.currentTool === "string" ? { currentTool: event.currentTool } : {}),
					...(typeof event.toolCount === "number" ? { toolCount: event.toolCount } : {}),
					...(typeof event.recentOutput === "string" ? { recentOutput: boundedRecentOutput([...(child.recentOutput ?? []), event.recentOutput]) } : {}),
				});
			case SUBAGENT_MODE_CHILD_ERROR_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "failed",
					updatedAt: now,
					...(typeof event.message === "string" ? { error: event.message } : {}),
				});
			case SUBAGENT_MODE_CHILD_CANCELLED_EVENT:
				return input.state.updateChildSession(child.childSessionId, {
					status: "cancelled",
					updatedAt: now,
					completedAt: now,
					...(typeof event.reason === "string" ? { resultSummary: event.reason } : {}),
				});
			case SUBAGENT_MODE_CHILD_COMPLETE_EVENT: {
				const result = event.result as Record<string, unknown> | undefined;
				const status = typeof result?.status === "string" ? result.status : "complete";
				const finalText = typeof result?.finalText === "string" ? result.finalText : undefined;
				const error = typeof result?.error === "string" ? result.error : undefined;
				const sessionFile = typeof result?.sessionFile === "string" ? result.sessionFile : undefined;
				return input.state.updateChildSession(child.childSessionId, {
					status: status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "complete",
					updatedAt: now,
					completedAt: now,
					...(sessionFile ? { sessionFile } : {}),
					...(finalText ? { finalAnswer: finalText, resultSummary: summarizeHandbackText(finalText, 120), recentOutput: finalAnswerRecentOutput(finalText) } : {}),
					...(error ? { error } : {}),
				});
			}
			default:
				return undefined;
		}
	}

	function handleChildEvent(runId: string, event: LoggedChildEvent, appendEntryOnUpdate = true): void {
		const child = resolveChildSessionForEvent(runId, event);
		if (!child) {
			warnDroppedChildEvent(runId, event, "could not correlate to a child session");
			return;
		}
		const workerLogMatchesChild = event.nodeLogWritten === true && event.childId === child.childSessionId;
		if (!workerLogMatchesChild) appendNodeLogForChild(child, event);
		if (event.type === SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT) {
			scheduleTextDeltaStateFlush(child, event);
			return;
		}
		if (event.type === SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT || event.type === SUBAGENT_MODE_CHILD_COMPLETE_EVENT || event.type === SUBAGENT_MODE_CHILD_CANCELLED_EVENT || event.type === SUBAGENT_MODE_CHILD_ERROR_EVENT) {
			flushPendingTextDeltaState(child.childSessionId);
			clearPendingTextDeltaState(child.childSessionId);
		}
		const updated = updateChildSessionFromEvent(child, event);
		if (updated?.sessionFile) {
			input.bindStickyUserSubagentSessionToRun(runId, {
				sessionFile: updated.sessionFile,
				childSessionId: updated.childSessionId,
				lastUsedAt: updated.updatedAt,
			});
		}
		if (updated && appendEntryOnUpdate && event.type && event.type !== SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT) {
			input.appendChildEntry(updated, input.isTerminal(updated.status) ? (updated.status === "cancelled" ? "cancelled" : "completed") : "updated");
		}
		if (updated && input.isTerminal(updated.status)) refreshRunAggregatesNow(runId);
		else scheduleRunAggregateRefresh(runId);
	}

	function clearPendingTextDeltaFlushes(): void {
		for (const pendingFlush of pendingTextDeltaFlushes.values()) {
			if (pendingFlush.timer) clearTimeout(pendingFlush.timer);
		}
		pendingTextDeltaFlushes.clear();
		for (const timer of pendingAggregateRefreshes.values()) clearTimeout(timer);
		pendingAggregateRefreshes.clear();
	}

	return {
		appendNodeLogForChild,
		handleChildEvent,
		warnDroppedChildEvent,
		clearPendingTextDeltaFlushes,
	};
}

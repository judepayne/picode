import type {
	ChildSessionEntryPayload,
	ContinuationEntryPayload,
	HandbackEntryPayload,
	OrchestratorChildSessionRecord,
	OrchestratorContinuationRecord,
	OrchestratorHandbackRecord,
} from "./types.ts";

export const ORCHESTRATOR_COMPLETE_ENTRY_TYPE = "subagent-orchestrator-complete";
export const ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE = "subagent-orchestrator-child-session";
export const ORCHESTRATOR_HANDBACK_ENTRY_TYPE = "subagent-orchestrator-handback";
export const ORCHESTRATOR_CONTINUATION_ENTRY_TYPE = "subagent-orchestrator-continuation";
export const ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE = "subagent-orchestrator-continuation-message";

export function buildChildSessionEntry(record: OrchestratorChildSessionRecord, event: ChildSessionEntryPayload["event"]): ChildSessionEntryPayload {
	return {
		runId: record.runId,
		childSessionId: record.childSessionId,
		ownerModeId: record.ownerModeId,
		status: record.status,
		taskSummary: record.taskSummary,
		childIndex: record.childIndex,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.currentTool ? { currentTool: record.currentTool } : {}),
		...(record.resultSummary ? { resultSummary: record.resultSummary } : {}),
		...(record.error ? { error: record.error } : {}),
		event,
	};
}

export function buildHandbackEntry(record: OrchestratorHandbackRecord): HandbackEntryPayload {
	return {
		handbackId: record.handbackId,
		runId: record.runId,
		ownerModeId: record.ownerModeId,
		parentSessionId: record.parentSessionId,
		childSessionIds: [...record.childSessionIds],
		...(record.consumer ? { consumer: record.consumer } : {}),
		...(record.agent ? { agent: record.agent } : {}),
		status: record.status,
		summary: record.summary,
		...(record.batchId ? { batchId: record.batchId } : {}),
	};
}

export function buildContinuationEntry(record: OrchestratorContinuationRecord): ContinuationEntryPayload {
	return {
		continuationId: record.continuationId,
		parentSessionId: record.parentSessionId,
		ownerModeId: record.ownerModeId,
		handbackIds: [...record.handbackIds],
		...(record.consumer ? { consumer: record.consumer } : {}),
		...(record.agent ? { agent: record.agent } : {}),
		status: record.status,
		...(record.error ? { error: record.error } : {}),
	};
}

export function formatContinuationTitle(childCount: number, consumer: "agent" | "user" = "agent", agent?: string): string {
	if (consumer === "user") return `From ${agent ?? "subagent"}`;
	return childCount > 1 ? "Background scouts completed" : "Background scout completed";
}

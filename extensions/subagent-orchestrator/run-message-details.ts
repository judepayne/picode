import type { OrchestratorChildSessionRecord, OrchestratorRunMessageDetails, OrchestratorRunRecord } from "./types.ts";
import { isRunning, isTerminal } from "./run-status.ts";
import { normalizeRunOrigin } from "./delegation-context.ts";

function resolveSelectedChildIndex(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[]): number | undefined {
	if (children.length === 0) return undefined;
	if (typeof run.selectedChildIndex === "number" && children.some((child) => child.childIndex === run.selectedChildIndex)) {
		return run.selectedChildIndex;
	}
	const active = children.find((child) => isRunning(child.status)) ?? children.find((child) => !isTerminal(child.status));
	return active?.childIndex ?? children[0]?.childIndex;
}

export function buildRunMessageDetails(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[]): OrchestratorRunMessageDetails {
	const selectedChildIndex = resolveSelectedChildIndex(run, children);
	return {
		runId: run.orchestratorRunId,
		ownerModeId: run.ownerModeId,
		...(run.parentSessionId ? { parentSessionId: run.parentSessionId } : {}),
		requestShape: run.requestShape,
		async: run.async,
		context: run.context,
		origin: normalizeRunOrigin(run.origin),
		...(run.agent ? { agent: run.agent } : {}),
		status: run.status,
		taskSummary: run.taskSummary,
		updatedAt: run.updatedAt,
		...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
		...(run.error ? { error: run.error } : {}),
		childSessionCount: run.childSessionCount ?? children.length,
		activeChildCount: run.activeChildCount ?? children.filter((child) => isRunning(child.status)).length,
		queuedHandbackCount: run.queuedHandbackCount ?? 0,
		consumedHandbackCount: run.consumedHandbackCount ?? 0,
		...(selectedChildIndex !== undefined ? { selectedChildIndex } : {}),
		children: children.map((child) => ({
			childSessionId: child.childSessionId,
			childIndex: child.childIndex,
			status: child.status,
			taskSummary: child.taskSummary,
			...(child.currentTool ? { currentTool: child.currentTool } : {}),
			...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
			...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
			...(child.asyncDir ? { asyncDir: child.asyncDir } : {}),
			...(child.recentOutput?.length ? { recentOutput: child.recentOutput } : {}),
			...(child.resultSummary ? { resultSummary: child.resultSummary } : {}),
			...(child.error ? { error: child.error } : {}),
		})),
	};
}

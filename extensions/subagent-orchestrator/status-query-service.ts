import { normalizeRunOrigin } from "./delegation-context.ts";
import { buildTreeNodes } from "./status-tools.ts";
import type { StateStore } from "./state.ts";
import type { OrchestratorChildSessionRecord, OrchestratorRunRecord, OrchestratorTreeDetails, OrchestratorTreeNodeDetails } from "./types.ts";

export function createStatusQueryService(state: StateStore) {
	function resolveTreeRootRun(ownerModeId: string, runId?: string): { rootRun: OrchestratorRunRecord; selectedRunId?: string } | { error: string } {
		if (typeof runId === "string" && runId.trim()) {
			const run = state.getRun(runId.trim());
			if (!run) return { error: `Subagent orchestrator run ${runId.trim()} was not found.` };
			const rootRunId = run.rootRunId ?? run.orchestratorRunId;
			const rootRun = state.getRun(rootRunId);
			if (!rootRun || rootRun.ownerModeId !== ownerModeId) {
				return { error: `Subagent orchestrator tree ${runId.trim()} is not available for mode ${ownerModeId}.` };
			}
			return { rootRun, selectedRunId: run.orchestratorRunId };
		}
		const rootRun = state.getLatestTopLevelRunForMode(ownerModeId);
		if (!rootRun) return { error: `No subagent orchestrator runs found for mode ${ownerModeId}.` };
		return { rootRun };
	}

	function buildTreeDetails(rootRun: OrchestratorRunRecord, selectedRunId?: string): OrchestratorTreeDetails {
		const children = state.listChildSessionsByRootRunId(rootRun.orchestratorRunId)
			.map((child) => ({
				childSessionId: child.childSessionId,
				runId: child.runId,
				...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
				...(child.parentChildSessionId ? { parentChildSessionId: child.parentChildSessionId } : {}),
				agent: child.agent,
				childIndex: child.childIndex,
				...(child.stepIndex !== undefined ? { stepIndex: child.stepIndex } : {}),
				...(child.taskIndex !== undefined ? { taskIndex: child.taskIndex } : {}),
				status: child.status,
				taskSummary: child.taskSummary,
				...(child.currentTool ? { currentTool: child.currentTool } : {}),
				...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
				...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
				...(child.recentOutput ? { recentOutput: child.recentOutput } : {}),
				...(child.resultSummary ? { resultSummary: child.resultSummary } : {}),
				...(child.error ? { error: child.error } : {}),
				children: [],
			})) satisfies OrchestratorTreeNodeDetails[];
		return {
			rootRunId: rootRun.orchestratorRunId,
			ownerModeId: rootRun.ownerModeId,
			status: rootRun.status,
			async: rootRun.async,
			context: rootRun.context,
			origin: normalizeRunOrigin(rootRun.origin),
			...(rootRun.agent ? { agent: rootRun.agent } : {}),
			taskSummary: rootRun.taskSummary,
			...(selectedRunId ? { selectedRunId } : {}),
			nodes: buildTreeNodes(children),
		};
	}

	function resolveCurrentTreeChild(ownerModeId: string, childSessionId: string): { child: OrchestratorChildSessionRecord; rootRun: OrchestratorRunRecord } | { error: string } {
		const child = state.getChildSession(childSessionId);
		if (!child) return { error: `Child session ${childSessionId} was not found.` };
		const currentRoot = state.getLatestTopLevelRunForMode(ownerModeId);
		if (!currentRoot) return { error: `No subagent orchestrator runs found for mode ${ownerModeId}.` };
		const childRootRunId = child.rootRunId ?? child.runId;
		if (childRootRunId !== currentRoot.orchestratorRunId) {
			return { error: `Child session ${childSessionId} is not part of the current or last delegated tree for mode ${ownerModeId}.` };
		}
		return { child, rootRun: currentRoot };
	}

	return { resolveTreeRootRun, buildTreeDetails, resolveCurrentTreeChild };
}

export type StatusQueryService = ReturnType<typeof createStatusQueryService>;

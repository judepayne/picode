import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractChildResultPayloads, summarizeHandbackText } from "./handbacks.ts";
import { buildRunMessageDetails } from "./run-message-details.ts";
import type { RunMessageSnapshotStore } from "./run-live-state.ts";
import { ORCHESTRATOR_RUN_MESSAGE_TYPE } from "./run-live-state.ts";
import { buildChildSessionEntry, ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE } from "./session-entries.ts";
import type { StateStore } from "./state.ts";
import { finalAnswerRecentOutput, isTerminal } from "./run-status.ts";
import type {
	OrchestratorChildSessionRecord,
	OrchestratorRunMessageDetails,
	OrchestratorRunRecord,
	ProgrammaticResultEntry,
	RunStatus,
} from "./types.ts";

export interface RunStateServiceOptions {
	pi?: ExtensionAPI;
	state: StateStore;
	snapshots?: RunMessageSnapshotStore;
	getLatestCtx?: () => ExtensionContext | null;
	currentSessionLineage?: (ctx: ExtensionContext) => unknown;
	runMatchesSessionLineage?: (run: OrchestratorRunRecord, lineage: unknown) => boolean;
	refreshTap?: () => void;
	updateFooter?: () => void;
	bindContinuation?: (runId: string, patch: { sessionFile: string; childSessionId: string; lastUsedAt: number }) => void;
	releaseContinuation?: (runId: string, updatedAt: number) => void;
	onChildFinalized?: (child: OrchestratorChildSessionRecord) => void;
	onRunFinalized?: (run: OrchestratorRunRecord) => void;
}

export function createRunStateService(options: RunStateServiceOptions) {
	const { state } = options;

	function tryFinalizeChild(
		childSessionId: string,
		patch: { status: RunStatus } & Partial<OrchestratorChildSessionRecord>,
	): OrchestratorChildSessionRecord | undefined {
		if (!isTerminal(patch.status)) return undefined;
		const current = state.getChildSession(childSessionId);
		if (!current || isTerminal(current.status)) return undefined;
		const updated = state.updateChildSession(childSessionId, {
			...patch,
			updatedAt: patch.updatedAt ?? Date.now(),
			completedAt: patch.completedAt ?? Date.now(),
		});
		if (updated) options.onChildFinalized?.(updated);
		return updated;
	}

	function tryFinalizeRun(
		runId: string,
		patch: { status: RunStatus } & Partial<OrchestratorRunRecord>,
	): OrchestratorRunRecord | undefined {
		if (!isTerminal(patch.status)) return undefined;
		const current = state.getRun(runId);
		if (!current || isTerminal(current.status)) return undefined;
		const updated = state.updateRun(runId, {
			...patch,
			updatedAt: patch.updatedAt ?? Date.now(),
			completedAt: patch.completedAt ?? Date.now(),
		});
		if (updated) options.onRunFinalized?.(updated);
		return updated;
	}

	function refreshRunMessageSnapshot(runId: string): OrchestratorRunMessageDetails | undefined {
		const run = state.getRun(runId);
		if (!run) return undefined;
		const details = buildRunMessageDetails(run, state.listChildSessionsByRun(runId));
		return options.snapshots?.remember(details) ?? details;
	}

	function refreshAggregates(runId: string): OrchestratorRunRecord | undefined {
		const current = state.getRun(runId);
		if (!current) return undefined;
		const children = state.listChildSessionsByRun(runId);
		const handbacks = state.listHandbacksByRun(runId);
		const updated = state.updateRun(runId, {
			childSessionCount: children.length,
			activeChildCount: children.filter((child) => child.status === "running").length,
			queuedHandbackCount: handbacks.filter((item) => item.status === "queued").length,
			consumedHandbackCount: handbacks.filter((item) => item.status === "consumed").length,
			updatedAt: Date.now(),
		});
		refreshRunMessageSnapshot(runId);
		options.refreshTap?.();
		options.updateFooter?.();
		return updated;
	}

	function appendChildEntry(child: OrchestratorChildSessionRecord, event: "created" | "updated" | "completed" | "cancelled"): void {
		options.pi?.appendEntry(ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, buildChildSessionEntry(child, event));
	}

	function publishRunMessage(runId: string, display: boolean, ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? options.getLatestCtx?.();
		if (!options.pi || !runtimeCtx?.hasUI) return;
		const run = state.getRun(runId);
		if (!run || (!run.async && !display)) return;
		const details = refreshRunMessageSnapshot(runId);
		if (!display) return;
		const lineage = options.currentSessionLineage?.(runtimeCtx);
		if (lineage !== undefined && options.runMatchesSessionLineage && !options.runMatchesSessionLineage(run, lineage)) return;
		options.pi.sendMessage({
			customType: ORCHESTRATOR_RUN_MESSAGE_TYPE,
			content: `Orchestrator status update (system-generated, not user input): delegated run ${runId} is ${run.status}.`,
			display,
			details,
		}, { triggerTurn: false });
	}

	function finalizeChildrenFromResults(
		runId: string,
		results: ProgrammaticResultEntry[] | undefined,
		fallbackText: string | undefined,
		status: RunStatus,
		now: number,
	): void {
		const children = state.listChildSessionsByRun(runId);
		const extracted = extractChildResultPayloads(results);
		for (const child of children) {
			const result = extracted[child.childIndex];
			const finalAnswer = status === "cancelled"
				? undefined
				: result?.output ?? result?.finalOutput ?? (children.length === 1 ? fallbackText : undefined);
			const nextStatus: RunStatus = (() => {
				if (child.status === "cancelled" || status === "cancelled") return "cancelled";
				if (result?.success === true) return "complete";
				if (result?.success === false) return "failed";
				if (!result && child.requestShape === "chain" && child.status === "queued") return "queued";
				return status;
			})();
			const nextResultSummary = finalAnswer
				? summarizeHandbackText(finalAnswer, 120)
				: status === "cancelled" && fallbackText ? fallbackText : child.resultSummary;
			const nextError = result?.success === false && finalAnswer
				? finalAnswer
				: status === "failed" && !result && finalAnswer ? finalAnswer : child.error;
			if (isTerminal(child.status)) continue;
			const childPatch = {
				status: nextStatus,
				updatedAt: now,
				...(isTerminal(nextStatus) ? { completedAt: now } : {}),
				...(result?.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(finalAnswer ? { finalAnswer, resultSummary: nextResultSummary, recentOutput: finalAnswerRecentOutput(finalAnswer) } : {}),
				...(nextError ? { error: nextError } : {}),
			};
			const updated = isTerminal(nextStatus)
				? tryFinalizeChild(child.childSessionId, childPatch)
				: state.updateChildSession(child.childSessionId, childPatch);
			if (updated?.sessionFile) {
				options.bindContinuation?.(runId, { sessionFile: updated.sessionFile, childSessionId: updated.childSessionId, lastUsedAt: now });
			}
			if (updated) appendChildEntry(updated, nextStatus === "cancelled" ? "cancelled" : isTerminal(nextStatus) ? "completed" : "updated");
		}
		options.releaseContinuation?.(runId, now);
		refreshAggregates(runId);
	}

	return {
		tryFinalizeChild,
		tryFinalizeRun,
		refreshAggregates,
		refreshRunMessageSnapshot,
		appendChildEntry,
		publishRunMessage,
		finalizeChildrenFromResults,
	};
}

export type RunStateService = ReturnType<typeof createRunStateService>;

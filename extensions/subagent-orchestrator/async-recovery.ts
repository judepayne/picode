import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_ORCHESTRATOR_CHILD_AGENT } from "./policy.ts";
import type { createAsyncEventManager } from "./async-events.ts";
import type { StateStore } from "./state.ts";
import type { AsyncCompleteEvent, OrchestratorRunRecord, ProgrammaticResultEntry, RunStatus } from "./types.ts";
import { isTerminal, toRunStatus } from "./run-status.ts";
import { formatUnknownError, lastNonEmptyLine } from "./runtime-helpers.ts";

export interface AsyncRecoveryOptions {
	state: StateStore;
	asyncEvents: ReturnType<typeof createAsyncEventManager>;
	findCurrentOwnerModeId(ctx: ExtensionContext): string | undefined;
	tryFinalizeRun(runId: string, patch: { status: RunStatus } & Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
	finalizeChildrenFromResults(runId: string, results: ProgrammaticResultEntry[] | undefined, fallbackText: string | undefined, status: RunStatus, now: number): void;
	appendCompleteEntry(run: OrchestratorRunRecord, status: RunStatus, summary: string, underlyingRunId?: string): void;
	queueHandback(run: OrchestratorRunRecord, event: AsyncCompleteEvent): void;
	warn(message: string, error?: unknown): void;
}

export function createAsyncRecoveryService(options: AsyncRecoveryOptions) {
	const { state, asyncEvents } = options;
	const warnings = new Set<string>();

	function warnOnce(filePath: string, error: unknown): void {
		const key = `${filePath}:${formatUnknownError(error)}`;
		if (warnings.has(key)) return;
		warnings.add(key);
		options.warn(`could not read async completion artifact ${filePath}`, error);
	}

	function readCompletionFallback(run: OrchestratorRunRecord): AsyncCompleteEvent | undefined {
		if (!run.asyncDir) return undefined;
		const resultPath = path.join(run.asyncDir, "result.json");
		if (fs.existsSync(resultPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
					endedAt?: number;
					result?: {
						status?: RunStatus;
						results?: Array<{ agent?: string; status?: string; finalText?: string; error?: string; sessionFile?: string }>;
					};
				};
				const result = parsed.result;
				if (result && isTerminal(result.status ?? "queued")) {
					const textSummary = (result.results ?? []).map((entry) => entry.finalText ?? entry.error ?? "").filter(Boolean).join("\n\n---\n\n");
					return {
						id: run.underlyingRunId,
						agent: result.results?.[0]?.agent ?? state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT,
						status: result.status,
						cancelled: result.status === "cancelled",
						success: result.status === "complete",
						summary: lastNonEmptyLine(textSummary) ?? `${run.taskSummary} ${result.status}`,
						results: (result.results ?? []).map((entry) => ({
							agent: entry.agent,
							output: entry.finalText,
							finalOutput: entry.finalText,
							success: entry.status === "complete",
							sessionFile: entry.sessionFile,
						})),
						timestamp: typeof parsed.endedAt === "number" ? parsed.endedAt : Date.now(),
						asyncDir: run.asyncDir,
						sessionFile: result.results?.[0]?.sessionFile,
					};
				}
			} catch (error) {
				warnOnce(resultPath, error);
			}
		}

		const statusPath = path.join(run.asyncDir, "status.json");
		if (!fs.existsSync(statusPath)) return undefined;
		try {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
				state?: string;
				endedAt?: number;
				sessionFile?: string;
				outputFile?: string;
				steps?: Array<{ agent?: string; status?: string }>;
			};
			const finalStatus = status.state;
			if (finalStatus !== "complete" && finalStatus !== "failed" && finalStatus !== "cancelled") return undefined;
			let output: string | undefined;
			if (typeof status.outputFile === "string" && fs.existsSync(status.outputFile)) {
				output = fs.readFileSync(status.outputFile, "utf8").trim() || undefined;
			}
			const childAgent = state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT;
			const summary = lastNonEmptyLine(output) ?? `${childAgent} ${finalStatus}`;
			return {
				id: run.underlyingRunId,
				agent: status.steps?.[0]?.agent ?? childAgent,
				status: finalStatus,
				cancelled: finalStatus === "cancelled",
				success: finalStatus === "complete",
				summary,
				results: [{ agent: status.steps?.[0]?.agent ?? childAgent, output, success: finalStatus === "complete", sessionFile: status.sessionFile }],
				timestamp: typeof status.endedAt === "number" ? status.endedAt : Date.now(),
				asyncDir: run.asyncDir,
				sessionFile: status.sessionFile,
			};
		} catch (error) {
			warnOnce(statusPath, error);
			return undefined;
		}
	}

	function reconcileFromArtifacts(runId: string): OrchestratorRunRecord | undefined {
		const run = state.getRun(runId);
		if (!run || isTerminal(run.status) || !run.async) return run;
		const fallback = readCompletionFallback(run);
		if (!fallback) return run;
		const status = toRunStatus(fallback.status, fallback.success, fallback.cancelled);
		const now = typeof fallback.timestamp === "number" ? fallback.timestamp : Date.now();
		const latest = state.getRun(runId);
		if (!latest || isTerminal(latest.status)) return latest;
		const updated = options.tryFinalizeRun(runId, {
			status,
			updatedAt: Date.now(),
			completedAt: now,
			resultSummary: fallback.summary,
			...(status === "failed" ? { error: fallback.summary } : {}),
		});
		if (!updated) return state.getRun(runId);
		options.finalizeChildrenFromResults(runId, fallback.results, fallback.summary, status, now);
		options.appendCompleteEntry(updated, status, fallback.summary ?? `${run.taskSummary} ${status}`, fallback.id);
		if (status !== "cancelled") options.queueHandback(updated, fallback);
		return state.getRun(runId) ?? updated;
	}

	function refreshRunState(run: OrchestratorRunRecord, refreshOptions?: { ingestEvents?: boolean }): OrchestratorRunRecord | undefined {
		if (refreshOptions?.ingestEvents !== false) asyncEvents.ingestAsyncEventLines(run);
		const latest = state.getRun(run.orchestratorRunId) ?? run;
		return isTerminal(latest.status) ? latest : reconcileFromArtifacts(latest.orchestratorRunId);
	}

	function reconcileOwned(ctx: ExtensionContext, reconcileOptions?: { ingestEvents?: boolean }): void {
		const ownerModeId = options.findCurrentOwnerModeId(ctx);
		if (!ownerModeId) return;
		for (const run of state.listOwnedRuns(ownerModeId)) {
			if (!run.async) continue;
			asyncEvents.startAsyncEventTailer(run);
			refreshRunState(run, { ingestEvents: reconcileOptions?.ingestEvents ?? !asyncEvents.hasAsyncEventTailer(run.orchestratorRunId) });
		}
	}

	function reconcileTap(ctx: ExtensionContext, selectedChildSessionId?: string): void {
		const ownerModeId = options.findCurrentOwnerModeId(ctx);
		if (!ownerModeId) return;
		if (!selectedChildSessionId) return reconcileOwned(ctx);
		const child = state.getChildSession(selectedChildSessionId);
		if (!child || child.ownerModeId !== ownerModeId) return;
		const rootRunId = child.rootRunId ?? child.runId;
		for (const run of state.listRunsByRootRunId(rootRunId)) {
			if (!run.async) continue;
			asyncEvents.startAsyncEventTailer(run);
			refreshRunState(run, { ingestEvents: !asyncEvents.hasAsyncEventTailer(run.orchestratorRunId) });
		}
	}

	return { refreshRunState, reconcileOwned, reconcileTap, readCompletionFallback };
}

export type AsyncRecoveryService = ReturnType<typeof createAsyncRecoveryService>;

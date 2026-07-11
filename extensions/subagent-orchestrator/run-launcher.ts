import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentParentChildId, currentSubagentDepth } from "../subagent-mode/depth.ts";
import { currentSessionKey } from "./delegation-context.ts";
import { buildChildSessionRecords } from "./session-model.ts";
import { DEFAULT_SYNC_TIMEOUT_SECONDS, formatSyncIdleTimeoutMessage, MAX_SYNC_TIMEOUT_SECONDS, nextSyncIdleTimeoutDelayMs } from "./timeout.ts";
import { EVENT_SUBAGENT_TASK } from "./stream.ts";
import type { createAsyncEventManager } from "./async-events.ts";
import type { createChildEventController } from "./child-events.ts";
import type { PendingRequest } from "./event-handlers.ts";
import type { StateStore } from "./state.ts";
import type { NormalizedDelegationRequest, OrchestratorChildSessionRecord, OrchestratorRunRecord, ProgrammaticSubagentResponse, RunOrigin, RunStatus } from "./types.ts";
import { asRecord, firstTextContent } from "./tool-results.ts";
import { buildChildSessionDetails, getRequestedModeLabel, summarizeTasks } from "./runtime-helpers.ts";
import { isTerminal, shouldMarkChildRunningAtLaunch } from "./run-status.ts";

interface ContinuePreparation { response?: ProgrammaticSubagentResponse; sessionFiles?: string[] }

export interface RunLauncherOptions {
 pi: ExtensionAPI;
 state: StateStore;
 pending: Map<string, PendingRequest>;
 childEvents: ReturnType<typeof createChildEventController>;
 asyncEvents: ReturnType<typeof createAsyncEventManager>;
 cancelEvent: string;
 requestEvent: string;
 notifySuppressEvent: string;
 widgetSuppressEvent: string;
 prepareUserContinueSessionFiles(ctx: ExtensionContext, request: NormalizedDelegationRequest, origin: RunOrigin, runId: string, now: number, childSessionId?: string): ContinuePreparation;
 prepareAgentContinueSessionFiles(ctx: ExtensionContext, request: NormalizedDelegationRequest, origin: RunOrigin, runId: string): ContinuePreparation;
 precomputeAsyncForkSessionFiles(ctx: ExtensionContext, request: NormalizedDelegationRequest, count: number): string[] | undefined;
 buildSubagentModeRunSpec(ctx: ExtensionContext, modeId: string, request: NormalizedDelegationRequest, thinking?: string, childIds?: string[], sessionFiles?: string[], nodeLog?: { nodeLogsDir: string; runId: string; rootRunId?: string }): unknown;
 appendChildEntry(child: OrchestratorChildSessionRecord, event: "created" | "updated" | "completed" | "cancelled"): void;
 updateFooter(ctx: ExtensionContext): void;
 tryFinalizeRun(runId: string, patch: { status: RunStatus } & Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
 finalizeChildrenFromResults(runId: string, results: any[] | undefined, fallbackText: string | undefined, status: RunStatus, now: number): void;
 publishRunMessage(runId: string, display: boolean, ctx?: ExtensionContext | null): void;
 refreshRunAggregates(runId: string): void;
 refreshAsyncRunState(run: OrchestratorRunRecord, options?: { ingestEvents?: boolean }): OrchestratorRunRecord | undefined;
}

export function createRunLauncher(options: RunLauncherOptions) {
 const { pi, state, pending, childEvents, asyncEvents, prepareUserContinueSessionFiles, prepareAgentContinueSessionFiles, precomputeAsyncForkSessionFiles, buildSubagentModeRunSpec, appendChildEntry, tryFinalizeRun, finalizeChildrenFromResults, publishRunMessage, refreshRunAggregates, refreshAsyncRunState } = options;
 const SUBAGENT_MODE_CANCEL_EVENT = options.cancelEvent;
 const SUBAGENT_MODE_REQUEST_EVENT = options.requestEvent;
 const SUBAGENT_NOTIFY_SUPPRESS_EVENT = options.notifySuppressEvent;
 const SUBAGENT_WIDGET_SUPPRESS_EVENT = options.widgetSuppressEvent;
 const footerLifecycle = { updateUiStatus: (ctx: ExtensionContext) => options.updateFooter(ctx) };
	async function launchDelegatedRun(
	ctx: ExtensionContext,
		currentModeId: string,
		request: NormalizedDelegationRequest,
		options: {
			origin: RunOrigin;
			onUpdate?: AgentToolUpdateCallback<unknown>;
			signal?: AbortSignal;
		},
	): Promise<{ orchestratorRunId: string; response: ProgrammaticSubagentResponse }> {
		const orchestratorRunId = randomUUID();
		const now = Date.now();
		const parentSessionId = currentSessionKey(ctx) ?? orchestratorRunId;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const parentExecutionChildId = currentParentChildId();
		const directParentChild = parentExecutionChildId
			? state.getChildSession(parentExecutionChildId) ?? state.findChildSessionByExecutionChildId(parentExecutionChildId)
			: undefined;
		const directParentChildSessionId = directParentChild?.childSessionId;
		const rootRunId = directParentChild?.rootRunId ?? directParentChild?.runId ?? orchestratorRunId;
		const parentRunId = directParentChild?.runId;
		const effectiveOwnerModeId = directParentChild?.ownerModeId ?? currentModeId;
		const depth = currentSubagentDepth();
		const baseChildSessions = buildChildSessionRecords({
			runId: orchestratorRunId,
			rootRunId,
			parentChildSessionId: directParentChildSessionId,
			ownerModeId: effectiveOwnerModeId,
			parentSessionId,
			parentSessionFile,
			agent: request.agent,
			request,
			now,
		});
		const continuePreparation = options.origin === "user"
			? prepareUserContinueSessionFiles(
				ctx,
				request,
				options.origin,
				orchestratorRunId,
				now,
				baseChildSessions[0]?.childSessionId,
			)
			: prepareAgentContinueSessionFiles(
				ctx,
				request,
				options.origin,
				orchestratorRunId,
			);
		if (continuePreparation.response) {
			return { orchestratorRunId, response: continuePreparation.response };
		}
		const sessionFiles = continuePreparation.sessionFiles ?? precomputeAsyncForkSessionFiles(ctx, request, baseChildSessions.length);
		const childSessions = sessionFiles && sessionFiles.length > 0
			? baseChildSessions.map((child, index) => ({
				...child,
				...(typeof sessionFiles[index] === "string" ? { sessionFile: sessionFiles[index] } : {}),
			}))
			: baseChildSessions;
		const launchChildSessions = childSessions.map((child) => ({
			...child,
			...(request.async && shouldMarkChildRunningAtLaunch(request, child) ? { status: "running" as RunStatus } : {}),
		}));
		const initialRunStatus: RunStatus = request.async ? "running" : "queued";

		state.createRun({
			orchestratorRunId,
			ownerModeId: effectiveOwnerModeId,
			parentSessionId,
			parentSessionFile,
			rootRunId,
			...(parentRunId ? { parentRunId } : {}),
			...(directParentChildSessionId ? { parentChildSessionId: directParentChildSessionId } : {}),
			depth,
			launchedAt: now,
			updatedAt: now,
			requestShape: request.shape,
			async: request.async,
			context: request.context,
			origin: options.origin,
			agent: request.agent,
			status: initialRunStatus,
			taskSummary: summarizeTasks(request),
			underlyingRequestId: orchestratorRunId,
			childSessionCount: launchChildSessions.length,
			activeChildCount: launchChildSessions.filter((child) => child.status === "running").length,
			queuedHandbackCount: 0,
			consumedHandbackCount: 0,
			selectedChildIndex: launchChildSessions[0]?.childIndex,
		} satisfies OrchestratorRunRecord);
		for (const child of launchChildSessions) {
			const created = state.createChildSession(child);
			childEvents.appendNodeLogForChild(created, {
				type: EVENT_SUBAGENT_TASK,
				agent: created.agent,
				timestamp: created.createdAt,
				task: created.taskSummary,
			});
			appendChildEntry(created, "created");
		}
		footerLifecycle.updateUiStatus(ctx);

		let settled = false;
		const settleResponse = (response: ProgrammaticSubagentResponse): void => {
			if (settled) return;
			settled = true;
			pending.delete(orchestratorRunId);
			resolveResponse(response);
		};
		let resolveResponse!: (response: ProgrammaticSubagentResponse) => void;
		const responsePromise = new Promise<ProgrammaticSubagentResponse>((resolve) => {
			resolveResponse = resolve;
			pending.set(orchestratorRunId, { orchestratorRunId, onUpdate: options.onUpdate, resolve: settleResponse });
		});
		const syncTimeoutSeconds = Math.min(request.timeoutSeconds ?? DEFAULT_SYNC_TIMEOUT_SECONDS, MAX_SYNC_TIMEOUT_SECONDS);
		const timeoutMessage = formatSyncIdleTimeoutMessage(syncTimeoutSeconds);
		let syncTimeout: ReturnType<typeof setTimeout> | undefined;
		const scheduleSyncIdleTimeout = (): void => {
			if (settled) return;
			const run = state.getRun(orchestratorRunId);
			if (run && isTerminal(run.status)) return;
			const lastActivityAt = typeof run?.updatedAt === "number" ? run.updatedAt : now;
			const delayMs = nextSyncIdleTimeoutDelayMs(lastActivityAt, Date.now(), syncTimeoutSeconds);
			if (delayMs === undefined) {
				settleResponse({
					requestId: orchestratorRunId,
					isError: true,
					errorText: timeoutMessage,
					result: {
						content: [{ type: "text", text: timeoutMessage }],
						isError: true,
						details: { mode: getRequestedModeLabel(request), results: [] },
					},
				});
				pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: orchestratorRunId });
				return;
			}
			syncTimeout = setTimeout(scheduleSyncIdleTimeout, delayMs);
			syncTimeout.unref?.();
		};
		if (!request.async) scheduleSyncIdleTimeout();

		const cancelRequest = () => {
			pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: orchestratorRunId });
			settleResponse({
				requestId: orchestratorRunId,
				isError: true,
				errorText: "delegated subagent cancelled",
				result: {
					content: [{ type: "text", text: "delegated subagent cancelled" }],
					isError: true,
					details: { mode: getRequestedModeLabel(request), results: [] },
				},
			});
		};
		if (options.signal?.aborted) {
			cancelRequest();
		} else {
			options.signal?.addEventListener("abort", cancelRequest, { once: true });
			pi.events.emit(SUBAGENT_MODE_REQUEST_EVENT, {
				requestId: orchestratorRunId,
				spec: buildSubagentModeRunSpec(
					ctx,
					currentModeId,
					request,
					pi.getThinkingLevel(),
					launchChildSessions.map((child) => child.childSessionId),
					sessionFiles,
					{
						nodeLogsDir: state.nodeLogsDir,
						runId: orchestratorRunId,
						...(rootRunId ? { rootRunId } : {}),
					},
				),
			});
		}

		const response = await responsePromise;
		options.signal?.removeEventListener("abort", cancelRequest);
		if (syncTimeout) clearTimeout(syncTimeout);

		response.result.details = {
			...(asRecord(response.result.details) ?? {}),
			childSessions: buildChildSessionDetails(state.listChildSessionsByRun(orchestratorRunId).length > 0
				? state.listChildSessionsByRun(orchestratorRunId)
				: launchChildSessions),
		};

		const responseText = firstTextContent(response.result.content);
		if (!request.async) {
			const finalStatus: RunStatus = response.isError ? (options.signal?.aborted ? "cancelled" : "failed") : "complete";
			tryFinalizeRun(orchestratorRunId, {
				status: finalStatus,
				updatedAt: Date.now(),
				completedAt: Date.now(),
				...(responseText ? { resultSummary: responseText } : {}),
				...(response.isError ? { error: response.errorText ?? responseText ?? "Delegated subagent failed." } : {}),
			});
			finalizeChildrenFromResults(orchestratorRunId, response.result.details?.results, responseText, finalStatus, Date.now());
			return { orchestratorRunId, response };
		}

		if (response.isError) {
			const finalStatus: RunStatus = options.signal?.aborted ? "cancelled" : "failed";
			tryFinalizeRun(orchestratorRunId, {
				status: finalStatus,
				updatedAt: Date.now(),
				completedAt: Date.now(),
				...(responseText ? { resultSummary: responseText } : {}),
				...(response.errorText ? { error: response.errorText } : {}),
			});
			finalizeChildrenFromResults(orchestratorRunId, response.result.details?.results, responseText, finalStatus, Date.now());
			return { orchestratorRunId, response };
		}

		const details = response.result.details ?? {};
		const existing = state.getRun(orchestratorRunId);
		state.updateRun(orchestratorRunId, {
			status: existing?.status === "cancelled" ? existing.status : "running",
			updatedAt: Date.now(),
			...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
			...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
			...(typeof details.pid === "number" ? { pid: details.pid } : {}),
			...(responseText ? { resultSummary: responseText } : {}),
		});
		if (typeof details.asyncId === "string") {
			pi.events.emit(SUBAGENT_NOTIFY_SUPPRESS_EVENT, { asyncId: details.asyncId });
			pi.events.emit(SUBAGENT_WIDGET_SUPPRESS_EVENT, { asyncId: details.asyncId });
		}
		for (const child of state.listChildSessionsByRun(orchestratorRunId)) {
			state.updateChildSession(child.childSessionId, {
				updatedAt: Date.now(),
				...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
				...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
			});
		}
		publishRunMessage(orchestratorRunId, request.showRunCard, ctx);
		refreshRunAggregates(orchestratorRunId);
		const launchedRun = state.getRun(orchestratorRunId);
		asyncEvents.startAsyncEventTailer(launchedRun);
		if (launchedRun) refreshAsyncRunState(launchedRun, { ingestEvents: true });

		return { orchestratorRunId, response };
	}

 return { launchDelegatedRun };
}

export type RunLauncher = ReturnType<typeof createRunLauncher>;

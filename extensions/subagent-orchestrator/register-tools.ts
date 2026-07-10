import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { cancelAsyncRun } from "../subagent-mode/async-executor.ts";
import { normalizeDelegateInput } from "./delegate-input.ts";
import type { createHandbackDeliveryController } from "./handback-delivery.ts";
import { normalizeRunOrigin } from "./delegation-context.ts";
import type { DelegationContextResolver } from "./delegation-context.ts";
import type { AsyncRecoveryService } from "./async-recovery.ts";
import type { RunLauncher } from "./run-launcher.ts";
import { formatOrchestratorRetentionSummary, type OrchestratorRetentionSummary } from "./retention.ts";
import type { StatusQueryService } from "./status-query-service.ts";
import type { StateStore } from "./state.ts";
import { filterNodeLogRecords, formatNodeLogLines, formatRunDetails, formatRunList, formatTree, selectRunChild, STATUS_LIST_LIMIT, summarizeRunForListDetails } from "./status-tools.ts";
import { createJsonlFileSubagentStreamHandler } from "./stream-handlers.ts";
import { openSubagentStream, subagentStreamTopic } from "./stream.ts";
import { DelegateSubagentParams, DelegateSubagentStatusParams, DevSubagentStreamToFileParams } from "./tool-schemas.ts";
import { renderDelegateToolResult, renderStatusToolResult } from "./tool-renderers.ts";
import { asRecord, errorResult, firstTextContent, successText } from "./tool-results.ts";
import { getRequestedModeLabel } from "./runtime-helpers.ts";
import { isTerminal } from "./run-status.ts";
import type { NormalizedDelegationRequest, OrchestratorLogCursorDetails, OrchestratorLogDetails, OrchestratorLogNextDetails, OrchestratorRunRecord, ProgrammaticResultEntry, RunStatus } from "./types.ts";

const DEV_STREAM_TO_FILE_ENV = "PICODE_ENABLE_DEV_STREAM_TO_FILE";
function isEnvEnabled(value: string | undefined): boolean { return value === "1" || value?.toLowerCase() === "true"; }

export interface RegisterOrchestratorToolsOptions {
 pi: ExtensionAPI;
 state: StateStore;
 delegationContext: DelegationContextResolver;
 launcher: RunLauncher;
 recovery: AsyncRecoveryService;
 statusQueries: StatusQueryService;
 handbackDelivery: ReturnType<typeof createHandbackDeliveryController>;
 devStreamFileClosers: Map<string, () => void>;
 cancelEvent: string;
 setLatestCtx(ctx: ExtensionContext): void;
 hydrateDelegationRequest(ctx: ExtensionContext, request: NormalizedDelegationRequest, thinking?: string): NormalizedDelegationRequest;
 tryFinalizeRun(runId: string, patch: { status: RunStatus } & Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
 finalizeChildrenFromResults(runId: string, results: ProgrammaticResultEntry[] | undefined, fallbackText: string | undefined, status: RunStatus, now: number): void;
 getRetentionSummary(): OrchestratorRetentionSummary | undefined;
}

export function registerOrchestratorTools(options: RegisterOrchestratorToolsOptions): void {
 const { pi, state, devStreamFileClosers } = options;
 const findCurrentDelegationContext = options.delegationContext.findCurrent;
 const findCurrentOwnerModeId = options.delegationContext.findOwnerModeId;
 const hydrateDelegationRequest = (_pi: ExtensionAPI, ctx: ExtensionContext, request: NormalizedDelegationRequest, thinking?: string) => options.hydrateDelegationRequest(ctx, request, thinking);
 const launchDelegatedRun = options.launcher.launchDelegatedRun;
 const reconcileOwnedAsyncRuns = options.recovery.reconcileOwned;
 const refreshAsyncRunState = options.recovery.refreshRunState;
 const { resolveTreeRootRun, buildTreeDetails, resolveCurrentTreeChild } = options.statusQueries;
 const handbackDelivery = options.handbackDelivery;
 const finalizeChildrenFromResults = options.finalizeChildrenFromResults;
 const tryFinalizeRun = options.tryFinalizeRun;
 const SUBAGENT_MODE_CANCEL_EVENT = options.cancelEvent;
	pi.registerTool({
		name: "delegate_subagent",
		label: "Delegate Subagent",
		description: "Use the subagent orchestrator to run one or more scout subagents under mediated policy.",
		promptSnippet: "delegate_subagent({ task } | { tasks } | { chain }, async?, context?, childSessionId?, showRunCard?)",
		promptGuidelines: [
			"After a successful sync delegated run, answer the user directly with the child result once.",
			"For async delegated runs, do not add any assistant launch acknowledgment after the tool call when the tool result already shows the start state and run id.",
			"For async delegated runs, the preferred behavior is silence after the tool call until the completion payload arrives.",
			"Keep showRunCard false unless the user explicitly wants a visible subagent orchestrator run card.",
			"When an async completion payload arrives, use it the same way you would use sync delegated results: answer the original request naturally instead of echoing orchestration metadata.",
			"If async completion becomes available before any launch acknowledgment would be sent, skip the launch acknowledgment entirely.",
			"Do not call delegate_subagent_status unless the user asks or completion information is otherwise unavailable.",
			"Do not treat orchestrator status updates as user-authored input.",
			"Do not repeat the same delegated result multiple times.",
		],
		parameters: DelegateSubagentParams,
		renderResult(result, { expanded }, theme, context) {
			return renderDelegateToolResult(asRecord(context.args) ?? {}, result, expanded, theme);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			options.setLatestCtx(ctx);
			const currentMode = findCurrentDelegationContext(ctx);
			const currentModeId = currentMode.modeId;
			if (!currentModeId) {
				return errorResult("Subagent orchestrator could not determine the current agent mode from session state.");
			}

			const normalized = normalizeDelegateInput(params as Record<string, unknown>);
			if (!normalized.request) {
				return errorResult(normalized.error ?? "Invalid subagent orchestrator request.");
			}

			const request = hydrateDelegationRequest(pi, ctx, normalized.request, pi.getThinkingLevel());
			if (!currentMode.knownSubagents.includes(request.agent)) {
				return errorResult(`Unknown subagent type ${request.agent}. Known subagents: ${currentMode.knownSubagents.join(", ") || "none"}.`);
			}
			if (currentMode.bannedSubagents.includes(request.agent)) {
				return errorResult(`Mode ${currentModeId} is banned from delegating to subagent type ${request.agent}.`);
			}
			const launched = await launchDelegatedRun(ctx, currentModeId, request, {
				origin: "agent",
				onUpdate,
				signal,
			});
			const responseText = firstTextContent(launched.response.result.content);
			if (!request.async || launched.response.isError) {
				return launched.response.result;
			}
			const details = launched.response.result.details ?? {};
			const existing = state.getRun(launched.orchestratorRunId);
			return successText(
				`Background scout orchestration started [${launched.orchestratorRunId}]. Use delegate_subagent_status to inspect it later.`,
				{
					orchestratorRunId: launched.orchestratorRunId,
					status: existing?.status === "cancelled" ? "cancelled" : "running",
					requestShape: request.shape,
					context: request.context,
					origin: normalizeRunOrigin(existing?.origin),
					childSessions: state.listChildSessionsByRun(launched.orchestratorRunId),
					...(responseText ? { resultSummary: responseText } : {}),
					...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
					...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
					...(typeof details.pid === "number" ? { pid: details.pid } : {}),
				},
			);
		},
	});

	if (isEnvEnabled(process.env[DEV_STREAM_TO_FILE_ENV])) {
		pi.registerTool({
			name: "dev_subagent_stream_to_file",
			label: "Dev Subagent Stream To File",
			description: `Development helper enabled by ${DEV_STREAM_TO_FILE_ENV}: open a sanitized subagent stream and append events to a JSONL file.`,
			parameters: DevSubagentStreamToFileParams,
			async execute(_toolCallId, params) {
				if (typeof params.childSessionId !== "string" || !params.childSessionId.trim()) return errorResult("childSessionId is required.");
				if (typeof params.filePath !== "string" || !params.filePath.trim()) return errorResult("filePath is required.");
				const childSessionId = params.childSessionId.trim();
				const filePath = path.resolve(process.cwd(), params.filePath.trim());
				devStreamFileClosers.get(childSessionId)?.();
				const close = openSubagentStream(
					childSessionId,
					createJsonlFileSubagentStreamHandler(filePath),
					{ includeThinking: params.includeThinking === true },
				);
				devStreamFileClosers.set(childSessionId, close);
				return successText(`Opened subagent stream ${childSessionId} to ${filePath}.`, {
					childSessionId,
					filePath,
					topic: subagentStreamTopic(childSessionId),
				});
			},
		});
	}

	pi.registerTool({
		name: "delegate_subagent_status",
		label: "Delegated Subagent Status",
		description: "List, inspect, focus, cancel, or inspect trees/logs for orchestrated scout runs owned by the current mode.",
		promptSnippet: 'delegate_subagent_status({ action: "list" | "get" | "cancel" | "next" | "prev" | "select" | "tree" | "log" | "log_cursor" | "log_next", runId?, childIndex?, childSessionId?, cursor?, includeThinking? })',
		promptGuidelines: [
			"Use this only when the user explicitly asks to inspect, focus, or cancel a delegated run, or when completion information is otherwise unavailable.",
			"Do not poll this tool immediately after an orchestrator handback or visible completion result unless you need extra metadata.",
		],
		parameters: DelegateSubagentStatusParams,
		renderResult(result, options, theme, context) {
			return renderStatusToolResult(asRecord(context.args) ?? {}, result, options.expanded, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			options.setLatestCtx(ctx);
			const currentModeId = findCurrentOwnerModeId(ctx);
			if (!currentModeId) {
				return errorResult("Subagent orchestrator status could not determine the current agent mode from session state.");
			}
			const action = params.action;
			if (
				action !== "list"
				&& action !== "get"
				&& action !== "cancel"
				&& action !== "next"
				&& action !== "prev"
				&& action !== "select"
				&& action !== "tree"
				&& action !== "log"
				&& action !== "log_cursor"
				&& action !== "log_next"
			) {
				return errorResult('action must be one of "list", "get", "cancel", "next", "prev", "select", "tree", "log", "log_cursor", or "log_next".');
			}
			reconcileOwnedAsyncRuns(ctx);
			if (action === "list") {
				const runs = state.listOwnedRuns(currentModeId);
				const retention = options.getRetentionSummary();
				const runList = formatRunList(runs, currentModeId, (runId) => state.listChildSessionsByRun(runId));
				return successText(
					retention ? `${runList}\n${formatOrchestratorRetentionSummary(retention)}` : runList,
					{
						totalRuns: runs.length,
						runs: runs.slice(0, STATUS_LIST_LIMIT).map(summarizeRunForListDetails),
						...(retention ? { retention } : {}),
					},
				);
			}
			if (action === "tree") {
				const resolved = resolveTreeRootRun(currentModeId, typeof params.runId === "string" ? params.runId : undefined);
				if ("error" in resolved) return errorResult(resolved.error);
				const details = buildTreeDetails(resolved.rootRun, resolved.selectedRunId);
				return {
					content: [{ type: "text", text: formatTree(details) }],
					details,
				};
			}
			if (action === "log" || action === "log_cursor" || action === "log_next") {
				if (typeof params.childSessionId !== "string" || !params.childSessionId.trim()) {
					return errorResult(`childSessionId is required for ${action}.`);
				}
				const includeThinking = params.includeThinking === true;
				const resolved = resolveCurrentTreeChild(currentModeId, params.childSessionId.trim());
				if ("error" in resolved) return errorResult(resolved.error);
				const { child } = resolved;
				if (action === "log") {
					const details: OrchestratorLogDetails = {
						childSessionId: child.childSessionId,
						runId: child.runId,
						...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
						status: child.status,
						includeThinking,
						records: filterNodeLogRecords(state.readNodeLog(child.childSessionId), includeThinking),
					};
					return {
						content: [{ type: "text", text: formatNodeLogLines(details.records) }],
						details,
					};
				}
				if (action === "log_cursor") {
					if (isTerminal(child.status)) {
						const details: OrchestratorLogCursorDetails = {
							childSessionId: child.childSessionId,
							runId: child.runId,
							...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
							status: child.status,
							includeThinking,
							terminal: true,
							cursor: null,
						};
						return {
							content: [{ type: "text", text: "null" }],
							details,
						};
					}
					const currentCursor = state.readNodeLogSince(child.childSessionId).cursor;
					const details: OrchestratorLogCursorDetails = {
						childSessionId: child.childSessionId,
						runId: child.runId,
						...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
						status: child.status,
						includeThinking,
						terminal: false,
						cursor: currentCursor,
					};
					return {
						content: [{ type: "text", text: `cursor: ${details.cursor}` }],
						details,
					};
				}
				let next;
				try {
					next = state.readNodeLogSince(child.childSessionId, typeof params.cursor === "string" ? params.cursor : undefined);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return errorResult(message);
				}
				const details: OrchestratorLogNextDetails = {
					childSessionId: child.childSessionId,
					runId: child.runId,
					...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
					status: child.status,
					includeThinking,
					terminal: isTerminal(child.status),
					cursor: next.cursor,
					records: filterNodeLogRecords(next.records, includeThinking),
				};
				return {
					content: [{ type: "text", text: formatNodeLogLines(details.records) }],
					details,
				};
			}
			if (typeof params.runId !== "string" || !params.runId.trim()) {
				return errorResult("runId is required for get, cancel, next, prev, and select.");
			}
			const runId = params.runId.trim();
			const run = state.getOwnedRun(currentModeId, runId);
			if (!run) {
				return errorResult(`Subagent orchestrator run ${runId} was not found for mode ${currentModeId}.`);
			}
			if (action === "get") {
				if (run.async && isTerminal(run.status)) {
					handbackDelivery.consumeQueuedHandbacksForRun(run.orchestratorRunId);
				}
				const refreshedRun = state.getOwnedRun(currentModeId, runId) ?? run;
				const children = state.listChildSessionsByRun(refreshedRun.orchestratorRunId);
				const handbacks = state.listHandbacksByRun(refreshedRun.orchestratorRunId);
				return successText(formatRunDetails(refreshedRun, children, handbacks), { run: refreshedRun, children, handbacks });
			}

			if (action === "next" || action === "prev" || action === "select") {
				const selection = selectRunChild(state, runId, action, typeof params.childIndex === "number" ? params.childIndex : undefined);
				if (selection.error) return errorResult(selection.error);
				return successText(
					selection.child
						? `Focused child [${selection.child.childIndex}] for run ${runId}.`
						: `Updated child focus for run ${runId}.`,
					{ run: selection.run, child: selection.child },
				);
			}

			if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
				return successText(`Run ${runId} is already ${run.status}.`, { run });
			}

			let cancelMessage = `Cancellation requested for run ${runId}.`;
			if (run.async) {
				const asyncRunId = run.underlyingRunId;
				if (!asyncRunId) {
					return errorResult(`Run ${runId} cannot be cancelled because no async run id is available.`, getRequestedModeLabel({ shape: run.requestShape, async: run.async, context: run.context } as NormalizedDelegationRequest));
				}
				if (run.underlyingRequestId) pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: run.underlyingRequestId });
				const cancelled = cancelAsyncRun(asyncRunId, { pid: run.pid, allowUnverifiedPid: true });
				if (!cancelled.ok) return errorResult(`Run ${runId} cancellation failed: ${cancelled.message ?? "unknown error"}`);
				if (cancelled.alreadyFinished) {
					const refreshed = refreshAsyncRunState(run, { ingestEvents: true });
					return successText(`Run ${runId} ${cancelled.message ?? "already finished"}.`, { run: refreshed });
				}
				cancelMessage = `Cancellation requested for run ${runId}. ${cancelled.message ?? ""}`.trim();
			} else {
				// underlyingRequestId is the orchestrator-run-id that the bridge's
				// `active` map is keyed by. It exists for live sync runs.
				if (!run.underlyingRequestId) {
					return errorResult(`Run ${runId} cannot be cancelled because no live cancellation handle is available.`, getRequestedModeLabel({ shape: run.requestShape, async: run.async, context: run.context } as NormalizedDelegationRequest));
				}
				pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: run.underlyingRequestId });
			}

			const now = Date.now();
			const cancellationSummary = "Cancelled by delegate_subagent_status.";
			const updated = tryFinalizeRun(runId, {
				status: "cancelled",
				updatedAt: now,
				completedAt: now,
				resultSummary: cancellationSummary,
			});
			finalizeChildrenFromResults(runId, undefined, cancellationSummary, "cancelled", now);
			return successText(cancelMessage ?? `Cancelled run ${runId}.`, { run: updated ?? run });
		},
	});
}

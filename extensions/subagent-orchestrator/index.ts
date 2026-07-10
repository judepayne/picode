import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createAsyncEventManager } from "./async-events.ts";
import { createAsyncRecoveryService } from "./async-recovery.ts";
import { createChildEventController } from "./child-events.ts";
import { createFooterLifecycleController } from "./footer-lifecycle.ts";
import { createHandbackDeliveryController } from "./handback-delivery.ts";
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
 EVENT_MODE_CANCEL as SUBAGENT_MODE_CANCEL_EVENT,
 EVENT_MODE_REQUEST as SUBAGENT_MODE_REQUEST_EVENT,
 EVENT_MODE_REQUEST_RESPONSE as SUBAGENT_MODE_REQUEST_RESPONSE_EVENT,
 EVENT_MODE_REQUEST_STARTED as SUBAGENT_MODE_REQUEST_STARTED_EVENT,
 EVENT_RUN_COMPLETE as SUBAGENT_MODE_RUN_COMPLETE_EVENT,
} from "../subagent-mode/types.ts";
import {
 activateRunMessageSnapshotStore,
 clearRunMessageSnapshots,
 createRunMessageSnapshotStore,
 ORCHESTRATOR_RUN_MESSAGE_TYPE,
 resolveRunMessageDetails,
 restoreRunMessageSnapshots,
} from "./run-live-state.ts";
import { ORCHESTRATOR_COMPLETE_ENTRY_TYPE, ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE } from "./session-entries.ts";
import { createStateStore } from "./state.ts";
import { createContinuationMessageComponent, createRunMessageComponent } from "./message-renderers.ts";
import { createSubagentCardConfigResolver } from "./card-config-resolver.ts";
import { createContinuationController } from "./continuation-controller.ts";
import {
 childSessionMatchesSessionLineage,
 createDelegationContextResolver,
 currentSessionLineage,
 handbackMatchesSessionLineage,
 normalizeHandbackConsumer,
 normalizeRunOrigin,
 runMatchesSessionLineage,
} from "./delegation-context.ts";
import { createRunSpecBuilder } from "./run-spec.ts";
import { createRunStateService } from "./run-state-service.ts";
import { createRunLauncher } from "./run-launcher.ts";
import { registerOrchestratorTools } from "./register-tools.ts";
import { registerOrchestratorLifecycle } from "./lifecycle.ts";
import { isTerminal, toRunStatus, truncateDisplayText } from "./run-status.ts";
import { adaptSubagentModeResponse } from "./subagent-mode-adapter.ts";
import { createStatusQueryService } from "./status-query-service.ts";
import { summarizeAsyncFailure, warnOrchestratorDiagnostic } from "./runtime-helpers.ts";
import {
 activateSubagentStreamService,
 createSubagentStreamService,
 openSubagentStream,
 subagentStreamTopic,
 type OpenSubagentStreamOptions,
 type SubagentStreamEvent,
 type SubagentStreamHandler,
} from "./stream.ts";
import { createJsonlFileSubagentStreamHandler } from "./stream-handlers.ts";
import { createTapController } from "./tap-controller.ts";
import { registerSubagentEventHandlers, settlePendingRequests, type PendingRequest } from "./event-handlers.ts";
import type { OrchestratorRunMessageDetails } from "./types.ts";

const SUBAGENT_NOTIFY_SUPPRESS_EVENT = "subagent:notify:suppress";
const SUBAGENT_WIDGET_SUPPRESS_EVENT = "subagent:widget:suppress";
const SUBAGENT_STARTED_EVENT = "subagent:started";
const SUBAGENT_COMPLETE_EVENT = "subagent:complete";
const ASYNC_ERROR_SUMMARY_LIMIT = 1000;

export { openSubagentStream, subagentStreamTopic, createJsonlFileSubagentStreamHandler, type OpenSubagentStreamOptions, type SubagentStreamEvent, type SubagentStreamHandler };

export default function subagentOrchestratorExtension(pi: ExtensionAPI) {
	const state = createStateStore(path.join(process.cwd(), ".pi", "state", "subagent-orchestrator"));
	state.ensureReady();
	let runState!: ReturnType<typeof createRunStateService>;
	const disposeStreamActivation = activateSubagentStreamService(createSubagentStreamService(pi, state));
	const runMessageSnapshots = createRunMessageSnapshotStore();
	const disposeRunMessageSnapshots = activateRunMessageSnapshotStore(runMessageSnapshots);
	const cardResolver = createSubagentCardConfigResolver(pi);
	const continuationController = createContinuationController(state);
	const delegationContext = createDelegationContextResolver(state, cardResolver.subagentCards);
	const runSpecBuilder = createRunSpecBuilder(cardResolver);
	const statusQueries = createStatusQueryService(state);
	const findCurrentModeId = delegationContext.findModeId;
	const findCurrentOwnerModeId = delegationContext.findOwnerModeId;
	const clearStickyUserSubagentRun = continuationController.releaseRun;
	const bindStickyUserSubagentSessionToRun = continuationController.bindRun;
	const prepareUserContinueSessionFiles = continuationController.prepareUser;
	const prepareAgentContinueSessionFiles = continuationController.prepareAgent;
	const precomputeAsyncForkSessionFiles = runSpecBuilder.precomputeForkSessionFiles;
	const buildSubagentModeRunSpec = runSpecBuilder.build;

	pi.registerMessageRenderer<OrchestratorRunMessageDetails>(ORCHESTRATOR_RUN_MESSAGE_TYPE, (message, _options, theme) => {
		const details = resolveRunMessageDetails(message.details);
		if (!details) return undefined;
		return createRunMessageComponent(details, theme);
	});

	pi.registerMessageRenderer(ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE, (message, options, theme) => {
		return createContinuationMessageComponent(message, options, theme);
	});

	const pending = new Map<string, PendingRequest>();
	const asyncFallbackWarnings = new Set<string>();
	const uiStatusKey = "subagent-orchestrator";
	let latestCtx: ExtensionContext | null = null;
	const devStreamFileClosers = new Map<string, () => void>();
	let asyncEvents!: ReturnType<typeof createAsyncEventManager>;
	let asyncRecovery!: ReturnType<typeof createAsyncRecoveryService>;
	let childEvents!: ReturnType<typeof createChildEventController>;
	let eventHandlersDisposer: (() => void) | undefined;
	let footerLifecycle!: ReturnType<typeof createFooterLifecycleController<ReturnType<typeof currentSessionLineage>>>;
	let handbackDelivery!: ReturnType<typeof createHandbackDeliveryController<ReturnType<typeof currentSessionLineage>>>;
	const tapController = createTapController({
		getRoots: (ctx) => footerLifecycle.buildVisibleTapRoots(ctx, { includeUserRuns: true }),
		openStream: (childSessionId, handler) => openSubagentStream(childSessionId, handler),
		onPoll: (ctx, selectedChildSessionId) => {
			asyncRecovery.reconcileTap(ctx, selectedChildSessionId);
			handbackDelivery.flushQueuedHandbacks(ctx, { forceAgentDelivery: false });
		},
		pollIntervalMs: 2_000,
		warn: warnOrchestratorDiagnostic,
		onClose: () => {
			footerLifecycle.resetLastUiStatusText();
			footerLifecycle.updateUiStatus(latestCtx, true);
		},
	});

	childEvents = createChildEventController({
		pi,
		state,
		isTerminal,
		appendChildEntry: (child, event) => runState.appendChildEntry(child, event),
		refreshRunAggregates: (runId) => { runState.refreshAggregates(runId); },
		refreshRunMessageSnapshot: (runId) => { runState.refreshRunMessageSnapshot(runId); },
		bindStickyUserSubagentSessionToRun,
	});
	asyncEvents = createAsyncEventManager({
		state,
		handleChildEvent: childEvents.handleChildEvent,
		warnDroppedChildEvent: childEvents.warnDroppedChildEvent,
		warnDiagnostic: warnOrchestratorDiagnostic,
		isTerminal,
	});
	footerLifecycle = createFooterLifecycleController({
		state,
		getLatestCtx: () => latestCtx,
		findCurrentModeId,
		currentSessionLineage,
		runMatchesSessionLineage,
		childSessionMatchesSessionLineage,
		handbackMatchesSessionLineage,
		normalizeRunOrigin,
		normalizeHandbackConsumer,
		isTerminal,
		tapController,
		uiStatusKey,
	});
	runState = createRunStateService({
		pi,
		state,
		snapshots: runMessageSnapshots,
		getLatestCtx: () => latestCtx,
		currentSessionLineage,
		runMatchesSessionLineage: runMatchesSessionLineage as never,
		refreshTap: tapController.refresh,
		updateFooter: () => footerLifecycle.updateUiStatus(),
		bindContinuation: bindStickyUserSubagentSessionToRun as never,
		releaseContinuation: clearStickyUserSubagentRun,
	});
	const {
		appendChildEntry,
		finalizeChildrenFromResults,
		publishRunMessage,
		refreshAggregates: refreshRunAggregates,
		refreshRunMessageSnapshot,
		tryFinalizeRun,
	} = runState;
	handbackDelivery = createHandbackDeliveryController({
		pi,
		state,
		getLatestCtx: () => latestCtx,
		findCurrentModeId,
		currentSessionLineage,
		handbackMatchesSessionLineage,
		normalizeHandbackConsumer,
		refreshRunAggregates: (runId) => { refreshRunAggregates(runId); },
	});
	asyncRecovery = createAsyncRecoveryService({
		state,
		asyncEvents,
		findCurrentOwnerModeId,
		tryFinalizeRun: tryFinalizeRun,
		finalizeChildrenFromResults,
		appendCompleteEntry: (run, status, summary, underlyingRunId) => pi.appendEntry(ORCHESTRATOR_COMPLETE_ENTRY_TYPE, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary,
			underlyingRunId,
		}),
		queueHandback: (run, event) => { handbackDelivery.queueHandback(run, event); },
		warn: warnOrchestratorDiagnostic,
	});
	const refreshAsyncRunState = asyncRecovery.refreshRunState;
	const reconcileOwnedAsyncRuns = asyncRecovery.reconcileOwned;
	const runLauncher = createRunLauncher({
		pi,
		state,
		pending,
		childEvents,
		asyncEvents,
		cancelEvent: SUBAGENT_MODE_CANCEL_EVENT,
		requestEvent: SUBAGENT_MODE_REQUEST_EVENT,
		notifySuppressEvent: SUBAGENT_NOTIFY_SUPPRESS_EVENT,
		widgetSuppressEvent: SUBAGENT_WIDGET_SUPPRESS_EVENT,
		prepareUserContinueSessionFiles,
		prepareAgentContinueSessionFiles,
		precomputeAsyncForkSessionFiles,
		buildSubagentModeRunSpec,
		appendChildEntry,
		updateFooter: (ctx) => footerLifecycle.updateUiStatus(ctx, true),
		tryFinalizeRun: tryFinalizeRun,
		finalizeChildrenFromResults,
		publishRunMessage,
		refreshRunAggregates,
		refreshAsyncRunState,
	});
	const { launchDelegatedRun } = runLauncher;



	eventHandlersDisposer = registerSubagentEventHandlers(pi, {
		events: {
			requestStarted: SUBAGENT_MODE_REQUEST_STARTED_EVENT,
			requestResponse: SUBAGENT_MODE_REQUEST_RESPONSE_EVENT,
			runComplete: SUBAGENT_MODE_RUN_COMPLETE_EVENT,
			childStarted: SUBAGENT_MODE_CHILD_STARTED_EVENT,
			childThinkingStart: SUBAGENT_MODE_CHILD_THINKING_START_EVENT,
			childThinkingEnd: SUBAGENT_MODE_CHILD_THINKING_END_EVENT,
			childTextDelta: SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT,
			childTextFinal: SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT,
			childToolStart: SUBAGENT_MODE_CHILD_TOOL_START_EVENT,
			childToolEnd: SUBAGENT_MODE_CHILD_TOOL_END_EVENT,
			childProgress: SUBAGENT_MODE_CHILD_PROGRESS_EVENT,
			childError: SUBAGENT_MODE_CHILD_ERROR_EVENT,
			childComplete: SUBAGENT_MODE_CHILD_COMPLETE_EVENT,
			childCancelled: SUBAGENT_MODE_CHILD_CANCELLED_EVENT,
			legacyStarted: SUBAGENT_STARTED_EVENT,
			legacyComplete: SUBAGENT_COMPLETE_EVENT,
			notifySuppress: SUBAGENT_NOTIFY_SUPPRESS_EVENT,
			widgetSuppress: SUBAGENT_WIDGET_SUPPRESS_EVENT,
		},
		state,
		pending,
		getLatestCtx: () => latestCtx,
		handleChildEvent: childEvents.handleChildEvent,
		refreshRunAggregates,
		adaptSubagentModeResponse,
		toRunStatus,
		summarizeAsyncFailure,
		truncateDisplayText,
		tryFinalizeRun: tryFinalizeRun,
		finalizeChildrenFromResults,
		queueHandback: handbackDelivery.queueHandback,
		flushQueuedHandbacks: handbackDelivery.flushQueuedHandbacks,
		asyncErrorSummaryLimit: ASYNC_ERROR_SUMMARY_LIMIT,
		completeEntryType: ORCHESTRATOR_COMPLETE_ENTRY_TYPE,
	});

	registerOrchestratorLifecycle({
		pi,
		delegationContext,
		getLatestCtx: () => latestCtx,
		setLatestCtx: (ctx) => { latestCtx = ctx; },
		hydrate: (ctx, request, thinking) => cardResolver.hydrate(ctx, request, thinking),
		launch: (ctx, modeId, request) => launchDelegatedRun(ctx, modeId, request, { origin: "user" }),
		acknowledgeVisibleTerminalRuns: footerLifecycle.acknowledgeVisibleTerminalRuns,
		updateFooter: (ctx, force) => footerLifecycle.updateUiStatus(ctx, force),
		handleTapContext: tapController.handleCtx,
		ensureStateReady: state.ensureReady,
		restoreSnapshots: restoreRunMessageSnapshots,
		reconcileOwned: reconcileOwnedAsyncRuns,
		reconcileDuplicateHandbacks: handbackDelivery.reconcileDuplicateHandbacks,
		flushQueuedHandbacks: (ctx) => handbackDelivery.flushQueuedHandbacks(ctx, { forceAgentDelivery: true }),
		scheduleHandbackFlush: handbackDelivery.scheduleQueuedHandbackFlush,
		shutdown: async () => {
			eventHandlersDisposer?.();
			eventHandlersDisposer = undefined;
			tapController.dispose();
			latestCtx?.ui.setStatus(uiStatusKey, undefined);
			latestCtx?.ui.setEditorComponent(undefined);
			latestCtx = null;
			for (const request of pending.values()) pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: request.orchestratorRunId });
			settlePendingRequests(pending, "Subagent orchestrator runtime was replaced before the delegated response completed.");
			childEvents.clearPendingTextDeltaFlushes();
			for (const close of devStreamFileClosers.values()) close();
			devStreamFileClosers.clear();
			asyncEvents.stopAllAsyncEventTailers();
			handbackDelivery.clearQueuedHandbackFlushTimer();
			footerLifecycle.clearUiStatusTimer();
			clearRunMessageSnapshots();
			disposeRunMessageSnapshots();
			disposeStreamActivation();
			continuationController.dispose();
			cardResolver.dispose();
		},
	});

	registerOrchestratorTools({
		pi,
		state,
		delegationContext,
		launcher: runLauncher,
		recovery: asyncRecovery,
		statusQueries,
		handbackDelivery,
		devStreamFileClosers,
		cancelEvent: SUBAGENT_MODE_CANCEL_EVENT,
		setLatestCtx: (ctx) => { latestCtx = ctx; },
		hydrateDelegationRequest: (ctx, request, thinking) => cardResolver.hydrate(ctx, request, thinking),
		tryFinalizeRun: tryFinalizeRun,
		finalizeChildrenFromResults,
	});
}

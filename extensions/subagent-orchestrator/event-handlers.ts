import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_ORCHESTRATOR_CHILD_AGENT } from "./policy.ts";
import { formatBackgroundFailureNotification } from "./footer-status.ts";
import { buildChildSessionEntry, ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE } from "./session-entries.ts";
import { createStateStore } from "./state.ts";
import type {
	AsyncCompleteEvent,
	AsyncStartedEvent,
	OrchestratorChildSessionRecord,
	OrchestratorHandbackRecord,
	OrchestratorRunRecord,
	ProgrammaticResultEntry,
	ProgrammaticSubagentResponse,
	RunStatus,
} from "./types.ts";

export interface PendingRequest {
	orchestratorRunId: string;
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void;
	resolve: (response: ProgrammaticSubagentResponse) => void;
}

export interface SubagentModeChildResult {
	childId: string;
	agent: string;
	status: "complete" | "failed" | "cancelled";
	finalText?: string;
	error?: string;
	sessionFile?: string;
	usage?: { input?: number; output?: number; total?: number };
}

export interface SubagentModeRunResult {
	runId: string;
	mode: "single" | "parallel" | "chain";
	status: "queued" | "running" | "complete" | "failed" | "cancelled";
	results: SubagentModeChildResult[];
}

export interface LoggedChildEvent extends Record<string, unknown> {
	type?: string;
	runId?: string;
	childId?: string;
	agent?: string;
	stepIndex?: number;
	taskIndex?: number;
	sessionFile?: string;
	timestamp?: number;
	text?: string;
	delta?: string;
	message?: string;
	fatal?: boolean;
	toolName?: string;
	toolCallId?: string;
	ok?: boolean;
	resultSummary?: string;
	currentTool?: string;
	toolCount?: number;
	recentOutput?: string;
	result?: { status?: string; finalText?: string; error?: string; sessionFile?: string };
	/** Internal marker: subagent-mode data plane already persisted this event. */
	nodeLogWritten?: boolean;
}

export interface SubagentEventNames {
	requestStarted: string;
	requestResponse: string;
	runComplete: string;
	childStarted: string;
	childThinkingStart: string;
	childThinkingEnd: string;
	childTextDelta: string;
	childTextFinal: string;
	childToolStart: string;
	childToolEnd: string;
	childProgress: string;
	childError: string;
	childComplete: string;
	childCancelled: string;
	legacyStarted: string;
	legacyComplete: string;
	notifySuppress: string;
	widgetSuppress: string;
}

export interface RegisterSubagentEventHandlersInput {
	events: SubagentEventNames;
	state: ReturnType<typeof createStateStore>;
	pending: Map<string, PendingRequest>;
	getLatestCtx: () => ExtensionContext | null;
	handleChildEvent: (runId: string, event: LoggedChildEvent) => void;
	refreshRunAggregates: (runId: string) => void;
	adaptSubagentModeResponse: (
		requestId: string,
		result: SubagentModeRunResult | null,
		ok: boolean,
		errorText?: string,
		asyncDetails?: { asyncDir?: string; asyncId?: string; pid?: number },
	) => ProgrammaticSubagentResponse;
	toRunStatus: (status: string | undefined, success: boolean | undefined, cancelled: boolean | undefined) => RunStatus;
	summarizeAsyncFailure: (result: SubagentModeRunResult, fallback: string) => string;
	truncateDisplayText: (text: string | undefined, limit?: number) => string | undefined;
	finalizeChildrenFromResults: (runId: string, results: ProgrammaticResultEntry[] | undefined, fallbackText: string | undefined, status: RunStatus, now: number) => void;
	queueHandback: (run: OrchestratorRunRecord, event: AsyncCompleteEvent) => OrchestratorHandbackRecord | undefined;
	flushQueuedHandbacks: (ctx?: ExtensionContext | null) => void;
	asyncErrorSummaryLimit: number;
	completeEntryType: string;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warnOrchestratorDiagnostic(message: string, error?: unknown): void {
	const suffix = error === undefined ? "" : `: ${formatUnknownError(error)}`;
	console.warn(`[subagent-orchestrator] ${message}${suffix}`);
}

function safeEventHandler(eventName: string, handler: (data: unknown) => void): (data: unknown) => void {
	return (data: unknown): void => {
		try {
			handler(data);
		} catch (error) {
			warnOrchestratorDiagnostic(`event handler ${eventName} failed`, error);
		}
	};
}

type EventBusUnsubscribe = (() => void) | { dispose?: () => void; unsubscribe?: () => void } | void;
type EventBusWithHandlerState = ExtensionAPI["events"] & Record<symbol, unknown> & { off?: (event: string, handler: (data: unknown) => void) => void };
interface ActiveEventHandlersState {
	token: symbol;
	dispose: () => void;
}

const EVENT_HANDLERS_STATE_KEY = Symbol.for("picode.subagent-orchestrator.event-handlers");

export function registerSubagentEventHandlers(pi: ExtensionAPI, input: RegisterSubagentEventHandlersInput): () => void {
	const { events, state, pending } = input;
	const eventBus = pi.events as EventBusWithHandlerState;
	const previousState = eventBus[EVENT_HANDLERS_STATE_KEY] as ActiveEventHandlersState | undefined;
	const token = Symbol("subagent-orchestrator-event-handlers");
	const disposers: Array<() => void> = [];
	const isCurrent = (): boolean => (eventBus[EVENT_HANDLERS_STATE_KEY] as ActiveEventHandlersState | undefined)?.token === token;
	const dispose = (): void => {
		for (const disposeOne of disposers.splice(0)) disposeOne();
		if (isCurrent()) delete eventBus[EVENT_HANDLERS_STATE_KEY];
	};
	const on = (event: string, handler: (data: unknown) => void): void => {
		const guarded = (data: unknown): void => {
			if (!isCurrent()) return;
			handler(data);
		};
		const registered = pi.events.on(event, guarded) as EventBusUnsubscribe;
		disposers.push(() => {
			if (typeof registered === "function") {
				registered();
				return;
			}
			if (registered && typeof registered === "object") {
				if (typeof registered.unsubscribe === "function") {
					registered.unsubscribe();
					return;
				}
				if (typeof registered.dispose === "function") {
					registered.dispose();
					return;
				}
			}
			eventBus.off?.(event, guarded);
		});
	};

	eventBus[EVENT_HANDLERS_STATE_KEY] = { token, dispose } satisfies ActiveEventHandlersState;
	previousState?.dispose();

	on(events.requestStarted, safeEventHandler(events.requestStarted, (data) => {
		const requestId = (data as { requestId?: unknown })?.requestId;
		if (typeof requestId !== "string") return;
		const existingRun = state.getRun(requestId);
		if (!existingRun || !isTerminal(existingRun.status)) {
			state.updateRun(requestId, { status: "running", updatedAt: Date.now() });
		}
		input.refreshRunAggregates(requestId);
		const pendingRequest = pending.get(requestId);
		const agentLabel = existingRun?.agent?.trim() || "subagent";
		pendingRequest?.onUpdate?.({
			content: [{ type: "text", text: `Delegated ${agentLabel} run started.` }],
			details: { status: "running" },
		});
	}));

	const forwardLoggedChildEvent = safeEventHandler("subagent:mode:child.*", (data: unknown): void => {
		const event = data as LoggedChildEvent & { requestId?: unknown };
		if (typeof event.requestId !== "string") return;
		if (event.type !== events.childTextDelta) {
			state.updateRun(event.requestId, { updatedAt: Date.now() });
		}
		input.handleChildEvent(event.requestId, event);
	});

	on(events.childStarted, forwardLoggedChildEvent);
	on(events.childThinkingStart, forwardLoggedChildEvent);
	on(events.childThinkingEnd, forwardLoggedChildEvent);
	on(events.childTextDelta, forwardLoggedChildEvent);
	on(events.childTextFinal, forwardLoggedChildEvent);
	on(events.childToolStart, forwardLoggedChildEvent);
	on(events.childToolEnd, forwardLoggedChildEvent);
	on(events.childError, forwardLoggedChildEvent);
	on(events.childComplete, forwardLoggedChildEvent);
	on(events.childCancelled, forwardLoggedChildEvent);

	on(events.childProgress, safeEventHandler(events.childProgress, (data) => {
		const evt = data as LoggedChildEvent & {
			requestId?: unknown;
			currentTool?: unknown;
			toolCount?: unknown;
			recentOutput?: unknown;
			taskIndex?: unknown;
		};
		if (typeof evt.requestId !== "string") return;
		state.updateRun(evt.requestId, { updatedAt: Date.now() });
		input.handleChildEvent(evt.requestId, evt);
		const pendingRequest = pending.get(evt.requestId);
		const agentLabel = evt.agent?.trim() || state.getRun(evt.requestId)?.agent?.trim() || "subagent";
		pendingRequest?.onUpdate?.({
			content: [{
				type: "text",
				text: typeof evt.currentTool === "string"
					? `Delegated ${agentLabel} update: current tool ${evt.currentTool}${typeof evt.toolCount === "number" ? ` (${evt.toolCount})` : ""}.`
					: `Delegated ${agentLabel} progress update.`,
			}],
			details: { status: "running" },
		});
	}));

	on(events.requestResponse, safeEventHandler(events.requestResponse, (data) => {
		const payload = data as {
			requestId?: unknown;
			result?: SubagentModeRunResult | null;
			ok?: boolean;
			errorText?: string;
			async?: boolean;
			asyncDir?: string;
			asyncId?: string;
			pid?: number;
		};
		if (typeof payload.requestId !== "string") return;
		const pendingRequest = pending.get(payload.requestId);
		if (!pendingRequest) return;
		pending.delete(payload.requestId);
		pendingRequest.resolve(
			input.adaptSubagentModeResponse(
				payload.requestId,
				payload.result ?? null,
				payload.ok ?? false,
				payload.errorText,
				payload.async
					? { asyncDir: payload.asyncDir, asyncId: payload.asyncId, pid: payload.pid }
					: undefined,
			),
		);
	}));

	on(events.runComplete, safeEventHandler(events.runComplete, (data) => {
		const payload = data as {
			requestId?: unknown;
			runId?: unknown;
			result?: SubagentModeRunResult;
			async?: boolean;
		};
		// Sync runs resolve via request.response; run.complete during sync is
		// informational only. Async runs rely on run.complete for the terminal
		// transition — correlate by underlyingRunId.
		if (!payload.async) return;
		if (typeof payload.runId !== "string") return;
		const result = payload.result;
		if (!result) return;
		const run = state.findRunByUnderlyingId(payload.runId);
		if (!run || run.status === "cancelled") return;
		const status = input.toRunStatus(result.status, result.status === "complete", result.status === "cancelled");
		const summary = result.results
			.map((r) => r.finalText ?? "")
			.filter(Boolean)
			.join("\n\n---\n\n")
			|| `${result.mode} ${status}`;
		const errorSummary = status === "failed" ? input.summarizeAsyncFailure(result, summary) : undefined;
		const displaySummary = errorSummary ?? input.truncateDisplayText(summary, input.asyncErrorSummaryLimit) ?? summary;
		state.updateRun(run.orchestratorRunId, {
			status,
			updatedAt: Date.now(),
			completedAt: Date.now(),
			resultSummary: summary,
			...(errorSummary ? { error: errorSummary } : {}),
		});
		input.finalizeChildrenFromResults(
			run.orchestratorRunId,
			result.results.map((r) => ({
				agent: r.agent,
				output: r.finalText,
				finalOutput: r.finalText,
				success: r.status === "complete",
				sessionFile: r.sessionFile,
			})),
			summary,
			status,
			Date.now(),
		);
		pi.appendEntry(input.completeEntryType, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary: displaySummary,
			underlyingRunId: payload.runId,
		});
		if (status !== "cancelled") {
			const updated = state.getRun(run.orchestratorRunId) ?? run;
			input.queueHandback(updated, {
				id: payload.runId,
				status,
				success: status === "complete",
				cancelled: status === "cancelled",
				summary: displaySummary,
				results: result.results.map((r) => ({
					agent: r.agent,
					output: r.finalText,
					finalOutput: r.finalText,
					success: r.status === "complete",
					sessionFile: r.sessionFile,
				})),
				timestamp: Date.now(),
			} as AsyncCompleteEvent);
			input.flushQueuedHandbacks(input.getLatestCtx());
		}
	}));

	on(events.legacyStarted, safeEventHandler(events.legacyStarted, (data) => {
		const event = data as AsyncStartedEvent;
		if (typeof event.id !== "string") return;
		pi.events.emit(events.notifySuppress, { asyncId: event.id });
		pi.events.emit(events.widgetSuppress, { asyncId: event.id });
		const run = state.findRunByUnderlyingId(event.id);
		if (!run) return;
		state.updateRun(run.orchestratorRunId, {
			underlyingRunId: event.id,
			status: run.status === "cancelled" ? run.status : "running",
			updatedAt: Date.now(),
			...(typeof event.pid === "number" ? { pid: event.pid } : {}),
			...(typeof event.asyncDir === "string" ? { asyncDir: event.asyncDir } : {}),
		});
		for (const child of state.listChildSessionsByRun(run.orchestratorRunId)) {
			const updated = state.updateChildSession(child.childSessionId, {
				underlyingRunId: event.id,
				updatedAt: Date.now(),
				...(typeof event.asyncDir === "string" ? { asyncDir: event.asyncDir } : {}),
			});
			if (updated) appendChildEntry(pi, updated, "updated");
		}
		input.refreshRunAggregates(run.orchestratorRunId);
	}));

	on(events.legacyComplete, safeEventHandler(events.legacyComplete, (data) => {
		const event = data as AsyncCompleteEvent;
		if (typeof event.id !== "string") return;
		const run = state.findRunByUnderlyingId(event.id);
		if (!run || run.status === "cancelled") return;
		const status = input.toRunStatus(event.status, event.success, event.cancelled);
		const summary = event.summary ?? `${event.agent ?? state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT} ${status}`;
		const errorSummary = status === "failed" ? input.truncateDisplayText(summary, input.asyncErrorSummaryLimit) ?? summary : undefined;
		const displaySummary = errorSummary ?? input.truncateDisplayText(summary, input.asyncErrorSummaryLimit) ?? summary;
		state.updateRun(run.orchestratorRunId, {
			status,
			updatedAt: Date.now(),
			completedAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
			resultSummary: summary,
			...(errorSummary ? { error: errorSummary } : {}),
		});
		input.finalizeChildrenFromResults(run.orchestratorRunId, event.results, summary, status, typeof event.timestamp === "number" ? event.timestamp : Date.now());
		pi.appendEntry(input.completeEntryType, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary: displaySummary,
			underlyingRunId: event.id,
		});
		if (status !== "cancelled") {
			input.queueHandback(state.getRun(run.orchestratorRunId) ?? run, event);
			input.flushQueuedHandbacks(input.getLatestCtx());
		}
		const latestCtx = input.getLatestCtx();
		if (latestCtx?.hasUI && status === "failed") {
			latestCtx.ui.notify(
				formatBackgroundFailureNotification(run.agent ?? event.agent, displaySummary),
				"warning",
			);
		}
	}));

	return dispose;
}

function isTerminal(status: RunStatus): boolean {
	return status === "complete" || status === "failed" || status === "cancelled";
}

function appendChildEntry(pi: ExtensionAPI, child: OrchestratorChildSessionRecord, eventType: "created" | "updated"): void {
	pi.appendEntry(ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, buildChildSessionEntry(child, eventType));
}

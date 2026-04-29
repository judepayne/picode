/**
 * Bidirectional bridge between subagent-mode's executor and the pi event bus.
 *
 * Consumes:
 *   subagent:mode:request  { requestId, spec }        — start a run
 *   subagent:mode:cancel   { requestId }              — cancel an active run
 *
 * Produces:
 *   subagent:mode:request.started   { requestId }
 *   subagent:mode:child.*           — forwarded normalized child events
 *   subagent:mode:run.started / run.complete — forwarded run lifecycle events
 *   subagent:mode:request.response  { requestId, result, ok, errorText? }
 *
 * The bridge is deliberately thin: it maps bus events to `executeRun`,
 * rebroadcasts the normalized stream unchanged, and correlates requests via
 * `requestId`. It does not shape, summarize, or render events — that is the
 * orchestrator's job.
 */

import {
	cancelAsyncRun,
	isAsyncAvailable,
	launchAsyncRun,
	watchCompletion,
	type CompletionWatcher,
	type LaunchAsyncRunOutput,
} from "./async-executor.ts";
import { createForkContextResolver, type ForkableSessionManager } from "./fork-context.ts";
import {
	executeRun,
	type ExecuteRunDeps,
	type RunChildFn,
	type SyncRunCallbacks,
	type SyncRunOptions,
} from "./sync-executor.ts";
import {
	EVENT_CHILD_CANCELLED,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
	EVENT_MODE_CANCEL,
	EVENT_MODE_REQUEST,
	EVENT_MODE_REQUEST_RESPONSE,
	EVENT_MODE_REQUEST_STARTED,
	EVENT_RUN_COMPLETE,
	EVENT_RUN_STARTED,
	type DelegatedRunResult,
	type NormalizedEvent,
	type RunSpec,
} from "./types.ts";

// ============================================================================
// Public surface
// ============================================================================

export interface EventBus {
	on(event: string, handler: (data: unknown) => void): void | (() => void) | { dispose?: () => void; unsubscribe?: () => void };
	off?(event: string, handler: (data: unknown) => void): void;
	emit(event: string, data: unknown): void;
}

export interface OrchestratorBridgeDeps {
	events: EventBus;
	/** Return the current extension context's session manager, if available. */
	getSessionManager: () => ForkableSessionManager | undefined;
	/** Default cwd for child execution when the request does not override. */
	getCwd?: () => string | undefined;
	/** Test hook: override the child execution primitive (skips real spawning). */
	runChildOverride?: RunChildFn;
}

export interface OrchestratorBridge {
	dispose(): void;
	cancelAll(): void;
	/** For testing: active request ids. */
	activeRequestIds(): string[];
}

interface ActiveRun {
	requestId: string;
	runId?: string;
	controller: AbortController;
	/** Set for async runs; cleared when the completion watcher fires. */
	asyncHandle?: LaunchAsyncRunOutput;
	completionWatcher?: CompletionWatcher;
}

function registerEventListener(events: EventBus, event: string, handler: (data: unknown) => void): () => void {
	const registered = events.on(event, handler);
	return () => {
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
		events.off?.(event, handler);
	};
}

export function createOrchestratorBridge(deps: OrchestratorBridgeDeps): OrchestratorBridge {
	const active = new Map<string, ActiveRun>();

	const handleRequest = (data: unknown): void => {
		const payload = data as { requestId?: unknown; spec?: unknown };
		if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return;
		const requestId = payload.requestId.trim();
		const spec = payload.spec as RunSpec | undefined;
		if (!spec || typeof spec !== "object" || typeof spec.mode !== "string") {
			emitResponse(deps.events, requestId, null, false, "invalid spec");
			return;
		}

		// Idempotency: duplicate requests are ignored.
		if (active.has(requestId)) return;

		const controller = new AbortController();
		const entry: ActiveRun = { requestId, controller };
		active.set(requestId, entry);

		deps.events.emit(EVENT_MODE_REQUEST_STARTED, { requestId });

		if (spec.async === true) {
			handleAsyncRequest(requestId, spec, entry, deps, () => {
				active.delete(requestId);
			});
			return;
		}

		void runRequest(requestId, spec, controller.signal, deps)
			.then((result) => {
				entry.runId = result.runId;
				emitResponse(deps.events, requestId, result, true);
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				emitResponse(deps.events, requestId, null, false, message);
			})
			.finally(() => {
				active.delete(requestId);
			});
	};

	const handleCancel = (data: unknown): void => {
		const payload = data as { requestId?: unknown };
		if (typeof payload.requestId !== "string") return;
		const entry = active.get(payload.requestId);
		if (!entry) return;
		entry.controller.abort();
		// Async runs do not respond to the in-process abort signal; the
		// detached child is signaled via its persisted pid.
		if (entry.asyncHandle) {
			cancelAsyncRun(entry.asyncHandle.runId);
		}
	};

	const unsubscribeRequest = registerEventListener(deps.events, EVENT_MODE_REQUEST, handleRequest);
	const unsubscribeCancel = registerEventListener(deps.events, EVENT_MODE_CANCEL, handleCancel);

	return {
		dispose() {
			unsubscribeRequest();
			unsubscribeCancel();
			for (const entry of active.values()) {
				entry.controller.abort();
				entry.completionWatcher?.stop();
				if (entry.asyncHandle) cancelAsyncRun(entry.asyncHandle.runId);
			}
			active.clear();
		},
		cancelAll() {
			for (const entry of active.values()) {
				entry.controller.abort();
				entry.completionWatcher?.stop();
				if (entry.asyncHandle) cancelAsyncRun(entry.asyncHandle.runId);
			}
			active.clear();
		},
		activeRequestIds() {
			return Array.from(active.keys());
		},
	};
}

function handleAsyncRequest(
	requestId: string,
	spec: RunSpec,
	entry: ActiveRun,
	deps: OrchestratorBridgeDeps,
	onSettled: () => void,
): void {
	if (!isAsyncAvailable()) {
		emitResponse(deps.events, requestId, null, false, "jiti is not available; async runs cannot be launched");
		onSettled();
		return;
	}

	let handle: LaunchAsyncRunOutput;
	try {
		handle = launchAsyncRun({
			spec,
			cwd: deps.getCwd?.(),
			parentSessionFile: spec.parentSessionFile,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitResponse(deps.events, requestId, null, false, message);
		onSettled();
		return;
	}

	entry.runId = handle.runId;
	entry.asyncHandle = handle;

	// Resolve the tool call immediately with a "launched" result shape. The
	// orchestrator treats the presence of `asyncDir` as the async-mode
	// signal and keeps the run record open until run.complete fires.
	const launchedResult: DelegatedRunResult = {
		runId: handle.runId,
		mode: spec.mode,
		status: "running",
		results: [],
	};
	deps.events.emit(EVENT_MODE_REQUEST_RESPONSE, {
		requestId,
		result: launchedResult,
		ok: true,
		async: true,
		asyncDir: handle.asyncDir,
		asyncId: handle.runId,
		pid: handle.pid,
	});

	// Watch for result.json and emit run.complete when it lands. The
	// orchestrator correlates by runId via its run record's underlyingRunId.
	entry.completionWatcher = watchCompletion(handle.runId, {
		onComplete: (runId, result) => {
			deps.events.emit(EVENT_RUN_COMPLETE, {
				requestId,
				runId,
				topLevelRunId: runId,
				result,
				timestamp: Date.now(),
				async: true,
				asyncDir: handle.asyncDir,
			});
			onSettled();
		},
		onTimeout: (runId) => {
			cancelAsyncRun(runId);
			deps.events.emit(EVENT_RUN_COMPLETE, {
				requestId,
				runId,
				topLevelRunId: runId,
				result: {
					runId,
					mode: spec.mode,
					status: "failed",
					results: [{
						childId: "timeout",
						agent: spec.agent ?? spec.tasks?.[0]?.agent ?? spec.chain?.[0]?.agent ?? "unknown",
						status: "failed",
						error: "async run timed out waiting for result.json",
					}],
				},
				timestamp: Date.now(),
				async: true,
				asyncDir: handle.asyncDir,
			});
			onSettled();
		},
	});
}

async function runRequest(
	requestId: string,
	spec: RunSpec,
	signal: AbortSignal,
	deps: OrchestratorBridgeDeps,
): Promise<DelegatedRunResult> {
	const sessionManager = deps.getSessionManager();
	const forkResolver = sessionManager
		? createForkContextResolver(sessionManager, spec.context)
		: undefined;

	const callbacks: SyncRunCallbacks = {
		signal,
		onEvent: (event) => {
			// Rebroadcast the normalized event unchanged; orchestrator consumes
			// the full stream on its side.
			deps.events.emit(event.type, { requestId, ...event });
		},
	};

	const options: SyncRunOptions = {
		cwd: deps.getCwd?.(),
		thinking: spec.thinking,
		tools: spec.tools,
		extensions: spec.extensions,
		systemPrompt: spec.systemPrompt,
		forkSessionFileForIndex: forkResolver
			? (index) => forkResolver.sessionFileForIndex(index)
			: undefined,
	};

	const executeDeps: ExecuteRunDeps = deps.runChildOverride
		? { runChild: deps.runChildOverride }
		: {};
	return executeRun(spec, callbacks, options, executeDeps);
}

function emitResponse(
	events: EventBus,
	requestId: string,
	result: DelegatedRunResult | null,
	ok: boolean,
	errorText?: string,
): void {
	events.emit(EVENT_MODE_REQUEST_RESPONSE, {
		requestId,
		result,
		ok,
		errorText,
	});
}

// ============================================================================
// Loop A/B subscription helpers
// ============================================================================

/**
 * The set of event types an agent-loop consumer receives. This is the summary
 * view: the parent agent's prompt path should see run lifecycle boundaries and
 * coalesced progress, but NOT raw text deltas or per-tool chatter from the
 * child. The child's final text lands via `run.complete` → `result.results[*]
 * .finalText`, not through `text.delta`.
 */
export const AGENT_LOOP_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
	EVENT_RUN_STARTED,
	EVENT_RUN_COMPLETE,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_CANCELLED,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_PROGRESS,
]);

export interface LoopSubscription {
	unsubscribe(): void;
}

export interface LoopSubscriptionOptions {
	/** If set, only events tagged with this requestId pass through. */
	requestId?: string;
}

/**
 * Subscribe to the agent-loop view — summary events only. Text deltas,
 * thinking events, and individual tool start/end are filtered out so the
 * parent-agent prompt does not balloon with child output. Use this for the
 * orchestrator's agent-loop consumer; use `subscribeUiLoop` for rendering.
 */
export function subscribeAgentLoop(
	events: EventBus,
	handler: (event: NormalizedEvent & { requestId?: string }) => void,
	options: LoopSubscriptionOptions = {},
): LoopSubscription {
	return subscribeFiltered(events, AGENT_LOOP_EVENT_TYPES, handler, options);
}

/**
 * Subscribe to the full normalized event stream — every child event including
 * text deltas, thinking boundaries, and tool detail. For UI rendering.
 */
export function subscribeUiLoop(
	events: EventBus,
	handler: (event: NormalizedEvent & { requestId?: string }) => void,
	options: LoopSubscriptionOptions = {},
): LoopSubscription {
	return subscribeFiltered(events, null, handler, options);
}

/** All normalized event types the bridge emits. */
const ALL_NORMALIZED_EVENT_TYPES: readonly string[] = [
	EVENT_RUN_STARTED,
	EVENT_RUN_COMPLETE,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_THINKING_START,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_TOOL_START,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_CANCELLED,
];

function subscribeFiltered(
	events: EventBus,
	allowedTypes: ReadonlySet<string> | null,
	handler: (event: NormalizedEvent & { requestId?: string }) => void,
	options: LoopSubscriptionOptions,
): LoopSubscription {
	const types = allowedTypes ? Array.from(allowedTypes) : ALL_NORMALIZED_EVENT_TYPES;

	const dispatch = (data: unknown): void => {
		const evt = data as NormalizedEvent & { requestId?: string };
		if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return;
		if (options.requestId !== undefined && evt.requestId !== options.requestId) return;
		handler(evt);
	};

	const unsubscribers = types.map((type) => registerEventListener(events, type, dispatch));

	return {
		unsubscribe() {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}

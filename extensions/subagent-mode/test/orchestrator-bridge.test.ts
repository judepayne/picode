import * as assert from "node:assert";
import { describe, test } from "node:test";

import {
	createOrchestratorBridge,
	subscribeAgentLoop,
	subscribeUiLoop,
	type EventBus,
} from "../orchestrator-bridge.ts";
import type { RunChildFn } from "../sync-executor.ts";
import {
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_MODE_CANCEL,
	EVENT_MODE_REQUEST,
	EVENT_MODE_REQUEST_RESPONSE,
	EVENT_MODE_REQUEST_STARTED,
	EVENT_RUN_COMPLETE,
	EVENT_RUN_STARTED,
} from "../types.ts";

// ============================================================================
// Minimal in-memory event bus
// ============================================================================

function createBus(options: { includeOff?: boolean } = {}): EventBus & { events: Array<{ type: string; data: unknown }> } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBus & { events: Array<{ type: string; data: unknown }> } = {
		events: [],
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(handler);
		},
		emit(event, data) {
			this.events.push({ type: event, data });
			const set = handlers.get(event);
			if (!set) return;
			for (const h of [...set]) h(data);
		},
	};
	if (options.includeOff !== false) {
		bus.off = (event, handler) => {
			handlers.get(event)?.delete(handler);
		};
	}
	return bus;
}

// ============================================================================
// Mock runChild that synthesizes the normalized event stream
// ============================================================================

function makeMockRunChild(options: { delayMs?: number; cancellable?: boolean } = {}): RunChildFn {
	return async (req, callbacks) => {
		callbacks.onEvent({
			type: EVENT_CHILD_STARTED,
			runId: req.runId,
			topLevelRunId: req.topLevelRunId,
			childId: req.childId,
			parentChildId: req.parentChildId,
			agent: req.agent,
			timestamp: Date.now(),
			stepIndex: req.stepIndex,
			taskIndex: req.taskIndex,
			depth: req.depth,
		});

		if (options.delayMs) {
			const abort = new Promise<"aborted">((resolve) => {
				callbacks.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
			});
			const sleep = new Promise<"done">((resolve) => setTimeout(() => resolve("done"), options.delayMs));
			const outcome = await Promise.race([abort, sleep]);
			if (outcome === "aborted") {
				const result = {
					childId: req.childId,
					agent: req.agent,
					status: "cancelled" as const,
					finalText: undefined,
				};
				callbacks.onEvent({
					type: EVENT_CHILD_COMPLETE,
					runId: req.runId,
					topLevelRunId: req.topLevelRunId,
					childId: req.childId,
					parentChildId: req.parentChildId,
					agent: req.agent,
					timestamp: Date.now(),
					stepIndex: req.stepIndex,
					taskIndex: req.taskIndex,
					depth: req.depth,
					result,
				});
				return result;
			}
		}

		const result = {
			childId: req.childId,
			agent: req.agent,
			status: "complete" as const,
			finalText: `mock-${req.agent}`,
			usage: { input: 1, output: 1, total: 2 },
		};
		callbacks.onEvent({
			type: EVENT_CHILD_COMPLETE,
			runId: req.runId,
			topLevelRunId: req.topLevelRunId,
			childId: req.childId,
			parentChildId: req.parentChildId,
			agent: req.agent,
			timestamp: Date.now(),
			stepIndex: req.stepIndex,
			taskIndex: req.taskIndex,
			depth: req.depth,
			result,
		});
		return result;
	};
}

async function waitForEvent(
	bus: ReturnType<typeof createBus>,
	type: string,
	timeoutMs = 3000,
): Promise<{ type: string; data: unknown } | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const match = bus.events.find((e) => e.type === type);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 5));
	}
	return undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe("orchestrator-bridge: request lifecycle", () => {
	test("request → started → forwarded events → response", async () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild(),
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-1",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "probe" },
		});

		const response = await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);
		assert.ok(response);
		const payload = response.data as { requestId: string; ok: boolean; result: { status: string } };
		assert.strictEqual(payload.requestId, "req-1");
		assert.strictEqual(payload.ok, true);
		assert.strictEqual(payload.result.status, "complete");

		const starteds = bus.events.filter((e) => e.type === EVENT_MODE_REQUEST_STARTED);
		assert.strictEqual(starteds.length, 1);
		assert.strictEqual((starteds[0]?.data as { requestId: string }).requestId, "req-1");

		bridge.dispose();
	});

	test("forwarded normalized events carry the requestId tag", async () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild(),
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-fw",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "t" },
		});

		await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);

		const runStarted = bus.events.find((e) => e.type === EVENT_RUN_STARTED);
		const runComplete = bus.events.find((e) => e.type === EVENT_RUN_COMPLETE);
		const childStarted = bus.events.find((e) => e.type === EVENT_CHILD_STARTED);
		const childComplete = bus.events.find((e) => e.type === EVENT_CHILD_COMPLETE);
		assert.ok(runStarted, "expected run.started forwarded");
		assert.ok(runComplete, "expected run.complete forwarded");
		assert.ok(childStarted, "expected child.started forwarded");
		assert.ok(childComplete, "expected child.complete forwarded");

		for (const evt of [runStarted, runComplete, childStarted, childComplete]) {
			assert.strictEqual((evt.data as { requestId: string }).requestId, "req-fw");
		}

		bridge.dispose();
	});

	test("forwards spec thinking, tools, and systemPrompt to child execution options", async () => {
		const bus = createBus();
		let observedThinking: string | undefined;
		let observedTools: string[] | undefined;
		let observedSystemPrompt: string | undefined;
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: async (req, callbacks, options) => {
				observedThinking = options?.thinking;
				observedTools = options?.tools;
				observedSystemPrompt = options?.systemPrompt;
				const result = {
					childId: req.childId,
					agent: req.agent,
					status: "complete" as const,
					finalText: "ok",
				};
				callbacks.onEvent({
					type: EVENT_CHILD_COMPLETE,
					runId: req.runId,
					topLevelRunId: req.topLevelRunId,
					childId: req.childId,
					parentChildId: req.parentChildId,
					agent: req.agent,
					timestamp: Date.now(),
					stepIndex: req.stepIndex,
					taskIndex: req.taskIndex,
					depth: req.depth,
					result,
				});
				return result;
			},
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-thinking",
			spec: {
				mode: "single",
				context: "fresh",
				agent: "scout",
				task: "t",
				thinking: "medium",
				tools: ["read", "grep"],
				systemPrompt: "You are a scout.",
			},
		});

		await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);
		assert.strictEqual(observedThinking, "medium");
		assert.deepStrictEqual(observedTools, ["read", "grep"]);
		assert.strictEqual(observedSystemPrompt, "You are a scout.");
		bridge.dispose();
	});

	test("cancel aborts the active run", async () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild({ delayMs: 1000, cancellable: true }),
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-cancel",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "slow" },
		});

		// Allow the request to start, then cancel.
		await new Promise((r) => setTimeout(r, 20));
		bus.emit(EVENT_MODE_CANCEL, { requestId: "req-cancel" });

		const response = await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);
		assert.ok(response);
		const payload = response.data as { ok: boolean; result: { status: string } };
		assert.strictEqual(payload.ok, true);
		assert.strictEqual(payload.result.status, "cancelled");

		bridge.dispose();
	});

	test("duplicate requestId is idempotent", async () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild({ delayMs: 50 }),
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-dup",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "a" },
		});
		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "req-dup",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "b" },
		});

		const starteds = bus.events.filter((e) => e.type === EVENT_MODE_REQUEST_STARTED);
		assert.strictEqual(starteds.length, 1);
		assert.strictEqual(bridge.activeRequestIds().length, 1);

		await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);
		bridge.dispose();
	});

	test("invalid spec emits a failure response immediately", () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild(),
		});

		bus.emit(EVENT_MODE_REQUEST, { requestId: "req-bad", spec: null });

		const responses = bus.events.filter((e) => e.type === EVENT_MODE_REQUEST_RESPONSE);
		assert.strictEqual(responses.length, 1);
		const payload = responses[0]?.data as { ok: boolean; errorText: string };
		assert.strictEqual(payload.ok, false);
		assert.match(payload.errorText, /invalid spec/);
		bridge.dispose();
	});

	test("subscribeAgentLoop filters out text.delta and tool events", async () => {
		const bus = createBus();
		const agentLoopEvents: Array<{ type: string }> = [];
		const sub = subscribeAgentLoop(bus, (e) => agentLoopEvents.push({ type: e.type }));

		// Emit a mix of events.
		bus.emit(EVENT_RUN_STARTED, {
			type: EVENT_RUN_STARTED, runId: "r", topLevelRunId: "r", mode: "single", agent: "a", timestamp: 0,
		});
		bus.emit(EVENT_CHILD_STARTED, {
			type: EVENT_CHILD_STARTED, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0,
		});
		bus.emit(EVENT_CHILD_TEXT_DELTA, {
			type: EVENT_CHILD_TEXT_DELTA, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0, delta: "hi",
		});
		bus.emit(EVENT_CHILD_PROGRESS, {
			type: EVENT_CHILD_PROGRESS, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0, toolCount: 1,
		});
		bus.emit(EVENT_CHILD_COMPLETE, {
			type: EVENT_CHILD_COMPLETE, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0,
			result: { childId: "c", agent: "a", status: "complete" },
		});
		bus.emit(EVENT_RUN_COMPLETE, {
			type: EVENT_RUN_COMPLETE, runId: "r", topLevelRunId: "r", timestamp: 0,
			result: { runId: "r", mode: "single", status: "complete", results: [] },
		});

		sub.unsubscribe();

		const types = agentLoopEvents.map((e) => e.type);
		assert.ok(types.includes(EVENT_RUN_STARTED));
		assert.ok(types.includes(EVENT_CHILD_STARTED));
		assert.ok(types.includes(EVENT_CHILD_PROGRESS));
		assert.ok(types.includes(EVENT_CHILD_COMPLETE));
		assert.ok(types.includes(EVENT_RUN_COMPLETE));
		assert.ok(!types.includes(EVENT_CHILD_TEXT_DELTA), "text.delta must NOT reach agent-loop");
	});

	test("subscribeUiLoop receives the full normalized stream including text.delta", async () => {
		const bus = createBus();
		const uiEvents: Array<{ type: string }> = [];
		const sub = subscribeUiLoop(bus, (e) => uiEvents.push({ type: e.type }));

		bus.emit(EVENT_CHILD_TEXT_DELTA, {
			type: EVENT_CHILD_TEXT_DELTA, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0, delta: "x",
		});
		bus.emit(EVENT_CHILD_STARTED, {
			type: EVENT_CHILD_STARTED, runId: "r", topLevelRunId: "r", childId: "c", agent: "a", timestamp: 0, depth: 0,
		});

		sub.unsubscribe();

		const types = uiEvents.map((e) => e.type);
		assert.ok(types.includes(EVENT_CHILD_TEXT_DELTA));
		assert.ok(types.includes(EVENT_CHILD_STARTED));
	});

	test("subscribeAgentLoop respects requestId filter", async () => {
		const bus = createBus();
		const got: Array<{ type: string; requestId?: string }> = [];
		const sub = subscribeAgentLoop(bus, (e) => got.push({ type: e.type, requestId: (e as { requestId?: string }).requestId }), { requestId: "req-A" });

		bus.emit(EVENT_RUN_STARTED, {
			type: EVENT_RUN_STARTED, requestId: "req-A", runId: "r1", topLevelRunId: "r1", mode: "single", agent: "a", timestamp: 0,
		});
		bus.emit(EVENT_RUN_STARTED, {
			type: EVENT_RUN_STARTED, requestId: "req-B", runId: "r2", topLevelRunId: "r2", mode: "single", agent: "a", timestamp: 0,
		});

		sub.unsubscribe();

		assert.strictEqual(got.length, 1);
		assert.strictEqual(got[0]?.requestId, "req-A");
	});

	test("dispose unhooks listeners", async () => {
		const bus = createBus();
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild({ delayMs: 10 }),
		});

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "r1",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "x" },
		});
		await waitForEvent(bus, EVENT_MODE_REQUEST_RESPONSE);

		bridge.dispose();

		bus.emit(EVENT_MODE_REQUEST, {
			requestId: "r2",
			spec: { mode: "single", context: "fresh", agent: "scout", task: "y" },
		});

		const starteds = bus.events.filter((e) => e.type === EVENT_MODE_REQUEST_STARTED);
		assert.strictEqual(starteds.length, 1, "second request after dispose should be ignored");
	});

	test("dispose is safe when the event bus does not implement off", async () => {
		const bus = createBus({ includeOff: false });
		const bridge = createOrchestratorBridge({
			events: bus,
			getSessionManager: () => undefined,
			runChildOverride: makeMockRunChild(),
		});

		assert.doesNotThrow(() => bridge.dispose());
	});
});

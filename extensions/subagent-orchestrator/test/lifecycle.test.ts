import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerOrchestratorLifecycle, type OrchestratorLifecycleOptions } from "../lifecycle.ts";

function makePi() {
	const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
	return {
		handlers,
		on(event: string, handler: (...args: never[]) => unknown) {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
		},
		getThinkingLevel: () => "off",
	} as never;
}

function options(pi: never, shutdown: () => void): OrchestratorLifecycleOptions {
	return {
		pi,
		delegationContext: { findCurrent: () => ({ knownSubagents: [], bannedSubagents: [], availableSubagents: [] }), currentAvailableSubagents: () => [] } as never,
		getLatestCtx: () => null,
		setLatestCtx: () => undefined,
		hydrate: (_ctx, request) => request,
		launch: async () => { throw new Error("not used"); },
		acknowledgeVisibleTerminalRuns: () => undefined,
		updateFooter: () => undefined,
		handleTapContext: () => undefined,
		ensureStateReady: () => undefined,
		restoreSnapshots: () => undefined,
		reconcileOwned: () => undefined,
		reconcileDuplicateHandbacks: () => undefined,
		flushQueuedHandbacks: () => undefined,
		pruneState: () => undefined,
		scheduleRetention: () => undefined,
		scheduleHandbackFlush: () => undefined,
		shutdown,
	};
}

describe("orchestrator lifecycle ownership", () => {
	it("prunes startup state after recovery and handback delivery but before footer rendering", async () => {
		const pi = makePi();
		const calls: string[] = [];
		const configured = options(pi, () => undefined);
		configured.ensureStateReady = () => { calls.push("ready"); };
		configured.restoreSnapshots = () => { calls.push("restore"); };
		configured.reconcileOwned = () => { calls.push("recover"); };
		configured.reconcileDuplicateHandbacks = () => { calls.push("dedupe"); };
		configured.flushQueuedHandbacks = () => { calls.push("handbacks"); throw new Error("delivery failed"); };
		configured.onHandbackDeliveryError = () => { calls.push("delivery-error"); };
		configured.pruneState = () => { calls.push("prune"); };
		configured.updateFooter = () => { calls.push("footer"); };
		configured.scheduleHandbackFlush = () => { calls.push("schedule"); };
		registerOrchestratorLifecycle(configured);
		const ctx = {
			hasUI: false,
			sessionManager: { getBranch: () => [] },
		} as never;
		const handler = pi.handlers.get("session_start")?.[0];
		assert.ok(handler);
		await handler({} as never, ctx);
		assert.deepEqual(calls, ["ready", "restore", "recover", "dedupe", "handbacks", "delivery-error", "prune", "footer", "schedule"]);
	});

	it("contains turn-end handback delivery failures and still refreshes and schedules", async () => {
		const pi = makePi();
		const calls: string[] = [];
		const configured = options(pi, () => undefined);
		configured.reconcileOwned = () => { calls.push("recover"); };
		configured.reconcileDuplicateHandbacks = () => { calls.push("dedupe"); };
		configured.flushQueuedHandbacks = () => { calls.push("handbacks"); throw new Error("delivery failed"); };
		configured.onHandbackDeliveryError = () => { calls.push("delivery-error"); };
		configured.updateFooter = () => { calls.push("footer"); };
		configured.scheduleHandbackFlush = () => { calls.push("schedule"); };
		registerOrchestratorLifecycle(configured);
		const handler = pi.handlers.get("turn_end")?.[0];
		assert.ok(handler);
		await handler({} as never, {} as never);
		assert.deepEqual(calls, ["recover", "dedupe", "handbacks", "delivery-error", "footer", "schedule"]);
	});

	it("disposes the previous runtime when the extension is registered again", () => {
		const pi = makePi();
		let firstShutdowns = 0;
		let secondShutdowns = 0;
		registerOrchestratorLifecycle(options(pi, () => { firstShutdowns += 1; }));
		registerOrchestratorLifecycle(options(pi, () => { secondShutdowns += 1; }));
		assert.equal(firstShutdowns, 1);
		assert.equal(secondShutdowns, 0);
	});
});

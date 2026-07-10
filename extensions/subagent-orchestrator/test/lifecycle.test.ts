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
		scheduleHandbackFlush: () => undefined,
		shutdown,
	};
}

describe("orchestrator lifecycle ownership", () => {
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

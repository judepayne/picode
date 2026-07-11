import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAgentAssetCardEntries, collectAgentAssetSnapshot, COLLECT_AGENT_ASSET_CARDS_EVENT } from "../contract.ts";

describe("agent asset card collection", () => {
	it("collects manifest entries from the event bus in descending priority order", () => {
		const handlers = new Map<string, Array<(payload: unknown) => void>>();
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				},
				emit(event: string, payload: unknown) {
					for (const handler of handlers.get(event) ?? []) handler(payload);
				},
			},
		};

		pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "base",
				priority: 0,
				agents: [{ name: "Builder", prompt: "Base builder" }],
				subagents: [{ name: "scout", prompt: "Base scout" }],
				diagnostics: [{ severity: "warning", message: "base warning" }],
			});
		});
		pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "overlay",
				priority: 100,
				agents: [{ name: "Writer", prompt: "Overlay writer" }],
				subagents: [{ name: "reviewer", prompt: "Overlay reviewer" }],
				diagnostics: [{ severity: "error", message: "overlay error" }],
			});
		});

		assert.deepEqual(collectAgentAssetCardEntries(pi), [
			{
				source: "overlay",
				priority: 100,
				agents: [{ name: "Writer", prompt: "Overlay writer" }],
				subagents: [{ name: "reviewer", prompt: "Overlay reviewer" }],
				diagnostics: [{ severity: "error", message: "overlay error" }],
			},
			{
				source: "base",
				priority: 0,
				agents: [{ name: "Builder", prompt: "Base builder" }],
				subagents: [{ name: "scout", prompt: "Base scout" }],
				diagnostics: [{ severity: "warning", message: "base warning" }],
			},
		]);
		const snapshot = collectAgentAssetSnapshot(pi);
		assert.deepEqual(snapshot.agents, [
			{ name: "Writer", prompt: "Overlay writer" },
			{ name: "Builder", prompt: "Base builder" },
		]);
		assert.deepEqual(snapshot.subagents, [
			{ name: "reviewer", prompt: "Overlay reviewer" },
			{ name: "scout", prompt: "Base scout" },
		]);
		assert.deepEqual(snapshot.diagnostics, [
			{ severity: "error", message: "overlay error" },
			{ severity: "warning", message: "base warning" },
		]);
	});

	it("dedupes cards by normalized name with higher-priority entries winning", () => {
		const handlers = new Map<string, Array<(payload: unknown) => void>>();
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				},
				emit(event: string, payload: unknown) {
					for (const handler of handlers.get(event) ?? []) handler(payload);
				},
			},
		};

		pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "base",
				priority: 0,
				agents: [{ name: "Code Writer", prompt: "base" }],
				subagents: [{ name: "scout", prompt: "base" }],
			});
		});
		pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "overlay",
				priority: 100,
				agents: [{ name: "Code Writer", prompt: "overlay" }],
				subagents: [{ name: "Scout", prompt: "overlay" }],
			});
		});

		const snapshot = collectAgentAssetSnapshot(pi);
		assert.deepEqual(snapshot.agents, [{ name: "Code Writer", prompt: "overlay" }]);
		assert.deepEqual(snapshot.subagents, [{ name: "Scout", prompt: "overlay" }]);
	});

	it("collects cards and diagnostics from one consistent snapshot emission", () => {
		let emissionCount = 0;
		const pi = {
			events: {
				emit(event: string, payload: unknown) {
					assert.equal(event, COLLECT_AGENT_ASSET_CARDS_EVENT);
					emissionCount += 1;
					(payload as { entries: unknown[] }).entries.push({
						source: `source-${emissionCount}`,
						agents: [{ name: `Agent ${emissionCount}` }],
						subagents: [{ name: `Subagent ${emissionCount}` }],
						diagnostics: [{ severity: "warning", message: `warning ${emissionCount}` }],
					});
				},
			},
		};

		const snapshot = collectAgentAssetSnapshot(pi);
		assert.equal(emissionCount, 1);
		assert.deepEqual(snapshot.agents, [{ name: "Agent 1" }]);
		assert.deepEqual(snapshot.subagents, [{ name: "Subagent 1" }]);
		assert.deepEqual(snapshot.diagnostics, [{ severity: "warning", message: "warning 1" }]);
		assert.equal(snapshot.entries[0]?.source, "source-1");
	});

	it("dedupes subagents by slugified name", () => {
		const handlers = new Map<string, Array<(payload: unknown) => void>>();
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				},
				emit(event: string, payload: unknown) {
					for (const handler of handlers.get(event) ?? []) handler(payload);
				},
			},
		};

		pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "cards",
				subagents: [
					{ name: "Research Assistant", prompt: "first" },
					{ name: "research-assistant", prompt: "second" },
				],
			});
		});

		assert.deepEqual(collectAgentAssetSnapshot(pi).subagents, [{ name: "Research Assistant", prompt: "first" }]);
	});
});

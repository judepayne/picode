import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAgentAssetDiagnostics, collectAgentAssetCardEntries, collectAgentCards, collectSubagentCards, COLLECT_AGENT_ASSET_CARDS_EVENT } from "../contract.ts";

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
		assert.deepEqual(collectAgentCards(pi), [
			{ name: "Writer", prompt: "Overlay writer" },
			{ name: "Builder", prompt: "Base builder" },
		]);
		assert.deepEqual(collectSubagentCards(pi), [
			{ name: "reviewer", prompt: "Overlay reviewer" },
			{ name: "scout", prompt: "Base scout" },
		]);
		assert.deepEqual(collectAgentAssetDiagnostics(pi), [
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

		assert.deepEqual(collectAgentCards(pi), [{ name: "Code Writer", prompt: "overlay" }]);
		assert.deepEqual(collectSubagentCards(pi), [{ name: "Scout", prompt: "overlay" }]);
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

		assert.deepEqual(collectSubagentCards(pi), [{ name: "Research Assistant", prompt: "first" }]);
	});
});

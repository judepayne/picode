import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAgentAssetDirEntries, collectAgentsDirs, collectSubagentsDirs, COLLECT_AGENT_ASSET_DIRS_EVENT } from "../contract.ts";

describe("agent asset dir collection", () => {
	it("collects entries from the event bus in descending priority order", () => {
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

		pi.events.on(COLLECT_AGENT_ASSET_DIRS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "base",
				priority: 0,
				agentsDir: "/base/agents",
				subagentsDir: "/base/subagents",
			});
		});
		pi.events.on(COLLECT_AGENT_ASSET_DIRS_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "overlay",
				priority: 100,
				agentsDir: "/overlay/agents",
				subagentsDir: "/overlay/subagents",
			});
		});

		assert.deepEqual(collectAgentAssetDirEntries(pi), [
			{
				source: "overlay",
				priority: 100,
				agentsDir: "/overlay/agents",
				subagentsDir: "/overlay/subagents",
			},
			{
				source: "base",
				priority: 0,
				agentsDir: "/base/agents",
				subagentsDir: "/base/subagents",
			},
		]);
		assert.deepEqual(collectAgentsDirs(pi), ["/overlay/agents", "/base/agents"]);
		assert.deepEqual(collectSubagentsDirs(pi), ["/overlay/subagents", "/base/subagents"]);
	});
});

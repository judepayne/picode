import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAgentAssetDiagnostics, collectAgentAssetFileEntries, collectAgentFiles, collectSubagentFiles, COLLECT_AGENT_ASSET_FILES_EVENT } from "../contract.ts";

describe("agent asset file collection", () => {
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

		pi.events.on(COLLECT_AGENT_ASSET_FILES_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "base",
				priority: 0,
				agents: [{ kind: "agent", fileName: "01-builder.md", filePath: "/base/agents/01-builder.md", origin: "native" }],
				subagents: [{ kind: "subagent", fileName: "scout.md", filePath: "/base/subagents/scout.md", origin: "native" }],
				diagnostics: [{ severity: "warning", message: "base warning" }],
			});
		});
		pi.events.on(COLLECT_AGENT_ASSET_FILES_EVENT, (payload) => {
			(payload as { entries: unknown[] }).entries.push({
				source: "overlay",
				priority: 100,
				agents: [{ kind: "agent", fileName: "05-writer.md", filePath: "/overlay/agents/05-writer.md", origin: "user" }],
				subagents: [{ kind: "subagent", fileName: "reviewer.md", filePath: "/overlay/subagents/reviewer.md", origin: "user" }],
				diagnostics: [{ severity: "error", message: "overlay error" }],
			});
		});

		assert.deepEqual(collectAgentAssetFileEntries(pi), [
			{
				source: "overlay",
				priority: 100,
				agents: [{ kind: "agent", fileName: "05-writer.md", filePath: "/overlay/agents/05-writer.md", origin: "user" }],
				subagents: [{ kind: "subagent", fileName: "reviewer.md", filePath: "/overlay/subagents/reviewer.md", origin: "user" }],
				diagnostics: [{ severity: "error", message: "overlay error" }],
			},
			{
				source: "base",
				priority: 0,
				agents: [{ kind: "agent", fileName: "01-builder.md", filePath: "/base/agents/01-builder.md", origin: "native" }],
				subagents: [{ kind: "subagent", fileName: "scout.md", filePath: "/base/subagents/scout.md", origin: "native" }],
				diagnostics: [{ severity: "warning", message: "base warning" }],
			},
		]);
		assert.deepEqual(collectAgentFiles(pi), [
			{ kind: "agent", fileName: "05-writer.md", filePath: "/overlay/agents/05-writer.md", origin: "user" },
			{ kind: "agent", fileName: "01-builder.md", filePath: "/base/agents/01-builder.md", origin: "native" },
		]);
		assert.deepEqual(collectSubagentFiles(pi), [
			{ kind: "subagent", fileName: "reviewer.md", filePath: "/overlay/subagents/reviewer.md", origin: "user" },
			{ kind: "subagent", fileName: "scout.md", filePath: "/base/subagents/scout.md", origin: "native" },
		]);
		assert.deepEqual(collectAgentAssetDiagnostics(pi), [
			{ severity: "error", message: "overlay error" },
			{ severity: "warning", message: "base warning" },
		]);
	});
});

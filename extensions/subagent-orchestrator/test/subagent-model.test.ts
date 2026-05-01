import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatModelReference, normalizeThinkingLevel, readNamedAgentExtensionPathsFromCards, readNamedAgentModelFromCards, readNamedAgentPromptFromCards, readNamedAgentThinkingFromCards, readNamedAgentToolSelectionFromCards } from "../subagent-model.ts";

describe("subagent model metadata", () => {
	it("reads model, thinking, tool selection, and prompt from the named card", () => {
		const cards = [{
			name: "Scout",
			model: '"openai-codex/gpt-5.4-mini"',
			thinking: "low",
			tools: "read, grep, find",
			prompt: "You are scouty.",
		}];
		assert.equal(readNamedAgentModelFromCards(cards, "scout"), "openai-codex/gpt-5.4-mini");
		assert.equal(readNamedAgentThinkingFromCards(cards, "scout"), "low");
		assert.deepEqual(readNamedAgentToolSelectionFromCards(cards, "scout"), {
			toolsMode: "list",
			tools: ["read", "grep", "find"],
		});
		assert.equal(readNamedAgentPromptFromCards(cards, "scout"), "You are scouty.");
	});

	it("finds entries by slugified frontmatter name", () => {
		const cards = [
			{ name: "Builder", model: "openai-codex/gpt-5.4", prompt: "Builder" },
			{ name: "Research Assistant", model: "openai-codex/gpt-5.4-mini", prompt: "Research" },
		];
		assert.equal(readNamedAgentModelFromCards(cards, "builder"), "openai-codex/gpt-5.4");
		assert.equal(readNamedAgentModelFromCards(cards, "research-assistant"), "openai-codex/gpt-5.4-mini");
	});

	it("parses tools: all and ban_tools from the card", () => {
		const cards = [{ name: "Worker", tools: "all", ban_tools: "[vars, edit]", prompt: "Worker" }];
		assert.deepEqual(readNamedAgentToolSelectionFromCards(cards, "worker"), {
			toolsMode: "all",
			banTools: ["vars", "edit"],
		});
	});

	it("returns omitted tool selection when the card does not specify tools", () => {
		const cards = [{ name: "Reviewer", ban_tools: "delegate_subagent", prompt: "Review" }];
		assert.deepEqual(readNamedAgentToolSelectionFromCards(cards, "reviewer"), {
			toolsMode: "omitted",
			banTools: ["delegate_subagent"],
		});
	});

	it("reads additional child extension paths from the card", () => {
		const cards = [{
			name: "Researcher",
			extensions: "[/abs/local-ext.ts, /home/me/.pi/agent/extensions/openai-web-search.ts]",
			prompt: "Research",
		}];
		assert.deepEqual(readNamedAgentExtensionPathsFromCards(cards, "researcher"), [
			"/abs/local-ext.ts",
			"/home/me/.pi/agent/extensions/openai-web-search.ts",
		]);
	});

	it("normalizes supported thinking levels and rejects invalid ones", () => {
		assert.equal(normalizeThinkingLevel(" HIGH "), "high");
		assert.equal(normalizeThinkingLevel("xhigh"), "xhigh");
		assert.equal(normalizeThinkingLevel("turbo"), undefined);
	});

	it("treats dash sentinel model and thinking values as omitted", () => {
		const cards = [{ name: "Scout", model: "-", thinking: "'-'", prompt: "Scout" }];
		assert.equal(readNamedAgentModelFromCards(cards, "scout"), undefined);
		assert.equal(readNamedAgentThinkingFromCards(cards, "scout"), undefined);
	});

	it("formats the live selected model as provider/id", () => {
		assert.equal(
			formatModelReference({ provider: "openai-codex", id: "gpt-5.4" }),
			"openai-codex/gpt-5.4",
		);
		assert.equal(
			formatModelReference({ provider: "openai-codex", modelID: "gpt-5.4-mini" }),
			"openai-codex/gpt-5.4-mini",
		);
		assert.equal(formatModelReference(undefined), undefined);
	});
});

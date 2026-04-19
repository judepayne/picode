import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { formatModelReference, normalizeThinkingLevel, readNamedAgentInstructions, readNamedAgentInstructionsFromDirs, readNamedAgentModel, readNamedAgentModelFromDirs, readNamedAgentThinking, readNamedAgentThinkingFromDirs, readNamedAgentTools, readNamedAgentToolsFromDirs } from "../subagent-model.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-model-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("subagent model metadata", () => {
	it("reads model, thinking, tools, and instructions from the named markdown file", () => {
		const root = makeRoot();
		fs.writeFileSync(
			path.join(root, "custom.md"),
			"---\nname: Scout\nmodel: \"openai-codex/gpt-5.4-mini\"\nthinking: low\ntools: read, grep, find\n---\nYou are scouty.\n",
			"utf8",
		);
		assert.equal(readNamedAgentModel(root, "scout"), "openai-codex/gpt-5.4-mini");
		assert.equal(readNamedAgentThinking(root, "scout"), "low");
		assert.deepEqual(readNamedAgentTools(root, "scout"), ["read", "grep", "find"]);
		assert.equal(readNamedAgentInstructions(root, "scout"), "You are scouty.");
	});

	it("prefers the first matching asset dir when searching multiple roots", () => {
		const overlay = makeRoot();
		const base = makeRoot();
		fs.writeFileSync(
			path.join(base, "scout.md"),
			"---\nname: Scout\nmodel: openai-codex/gpt-5.4\nthinking: high\ntools: read, bash\n---\nBase scout.\n",
			"utf8",
		);
		fs.writeFileSync(
			path.join(overlay, "scout.md"),
			"---\nname: Scout\nmodel: openai-codex/gpt-5.4-mini\nthinking: low\ntools: read, grep\n---\nOverlay scout.\n",
			"utf8",
		);
		assert.equal(readNamedAgentModelFromDirs([overlay, base], "scout"), "openai-codex/gpt-5.4-mini");
		assert.equal(readNamedAgentThinkingFromDirs([overlay, base], "scout"), "low");
		assert.deepEqual(readNamedAgentToolsFromDirs([overlay, base], "scout"), ["read", "grep"]);
		assert.equal(readNamedAgentInstructionsFromDirs([overlay, base], "scout"), "Overlay scout.");
	});

	it("normalizes supported thinking levels and rejects invalid ones", () => {
		assert.equal(normalizeThinkingLevel(" HIGH "), "high");
		assert.equal(normalizeThinkingLevel("xhigh"), "xhigh");
		assert.equal(normalizeThinkingLevel("turbo"), undefined);
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

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { AgentAssetFile } from "../../agent-assets/contract.ts";
import { formatModelReference, normalizeThinkingLevel, readNamedAgentInstructionsFromFiles, readNamedAgentModelFromFiles, readNamedAgentThinkingFromFiles, readNamedAgentToolsFromFiles } from "../subagent-model.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-model-"));
	tempDirs.push(root);
	return root;
}

function assetFile(filePath: string, kind: AgentAssetFile["kind"] = "subagent", origin: AgentAssetFile["origin"] = "native"): AgentAssetFile {
	return {
		kind,
		filePath,
		fileName: path.basename(filePath),
		origin,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("subagent model metadata", () => {
	it("reads model, thinking, tools, and instructions from the named markdown file", () => {
		const root = makeRoot();
		const filePath = path.join(root, "custom.md");
		fs.writeFileSync(
			filePath,
			"---\nname: Scout\nmodel: \"openai-codex/gpt-5.4-mini\"\nthinking: low\ntools: read, grep, find\n---\nYou are scouty.\n",
			"utf8",
		);
		const files = [assetFile(filePath)];
		assert.equal(readNamedAgentModelFromFiles(files, "scout"), "openai-codex/gpt-5.4-mini");
		assert.equal(readNamedAgentThinkingFromFiles(files, "scout"), "low");
		assert.deepEqual(readNamedAgentToolsFromFiles(files, "scout"), ["read", "grep", "find"]);
		assert.equal(readNamedAgentInstructionsFromFiles(files, "scout"), "You are scouty.");
	});

	it("uses the effective manifest winner when a same-filename override exists", () => {
		const root = makeRoot();
		const filePath = path.join(root, "scout.md");
		fs.writeFileSync(
			filePath,
			"---\nname: Scout\nmodel: openai-codex/gpt-5.4-mini\nthinking: low\ntools: read, grep\n---\nOverlay scout.\n",
			"utf8",
		);
		const files = [assetFile(filePath, "subagent", "user")];
		assert.equal(readNamedAgentModelFromFiles(files, "scout"), "openai-codex/gpt-5.4-mini");
		assert.equal(readNamedAgentThinkingFromFiles(files, "scout"), "low");
		assert.deepEqual(readNamedAgentToolsFromFiles(files, "scout"), ["read", "grep"]);
		assert.equal(readNamedAgentInstructionsFromFiles(files, "scout"), "Overlay scout.");
	});

	it("finds entries by numbered suffix and frontmatter name through the manifest", () => {
		const root = makeRoot();
		const numberedPath = path.join(root, "01-builder.md");
		const namedPath = path.join(root, "custom.md");
		fs.writeFileSync(numberedPath, "---\nname: Builder\nmodel: openai-codex/gpt-5.4\n---\nBuilder\n", "utf8");
		fs.writeFileSync(namedPath, "---\nname: Scout\nmodel: openai-codex/gpt-5.4-mini\n---\nScout\n", "utf8");
		const files = [assetFile(numberedPath, "agent"), assetFile(namedPath)];
		assert.equal(readNamedAgentModelFromFiles(files, "builder"), "openai-codex/gpt-5.4");
		assert.equal(readNamedAgentModelFromFiles(files, "scout"), "openai-codex/gpt-5.4-mini");
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

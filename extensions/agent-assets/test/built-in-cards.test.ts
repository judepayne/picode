import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { resolveAgentAssetManifest } from "../resolver.ts";

const extensionDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nativeAgentsDir = path.join(extensionDir, "agents");
const nativeSubagentsDir = path.join(extensionDir, "subagents");
const tempDirs: string[] = [];

function resolveBuiltIns() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "picode-built-in-cards-"));
	tempDirs.push(cwd);
	return resolveAgentAssetManifest({
		cwd,
		nativeAgentsDir,
		nativeSubagentsDir,
		env: { HOME: path.join(cwd, "home") },
	});
}

afterEach(() => {
	while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("built-in agent cards", () => {
	it("ships Partner Reviewer with read-only reviewer metadata", () => {
		const manifest = resolveBuiltIns();
		const card = manifest.subagents.find((entry) => entry.name === "partner-reviewer");
		assert.ok(card);
		assert.equal(card.tools, "read, bash, grep, find, ls");
		assert.equal(card.thinking, "medium");
		assert.equal(card.output, "false");
		assert.equal(card.defaultProgress, "true");
		assert.equal(card.maxSubagentDepth, "0");
	});

	it("defines initial and closure Partner Reviewer stages", () => {
		const manifest = resolveBuiltIns();
		const prompt = manifest.subagents.find((entry) => entry.name === "partner-reviewer")?.prompt ?? "";
		assert.match(prompt, /Initial\/full review/);
		assert.match(prompt, /Closure review/);
		assert.match(prompt, /git diff --stat/);
		assert.match(prompt, /repository evidence overrides session memory/);
		assert.match(prompt, /clean \| acceptable \| changes-required/);
		assert.match(prompt, /Do not edit files/);
	});

	it("enables Partner Reviewer from Builder at the five-file threshold", () => {
		const manifest = resolveBuiltIns();
		const builderPrompt = manifest.agents.find((entry) => entry.name === "Builder")?.prompt ?? "";
		assert.match(
			builderPrompt,
			/When the current implementation has changed five or more unique files, read and follow the `partner-reviewer` skill/,
		);
		assert.doesNotMatch(builderPrompt, /delegate to `reviewer`|review verdicts with `reviewer`/);
	});
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { AgentAssetFile } from "../../agent-assets/contract.ts";
import { ENV_MAX_DEPTH } from "../../subagent-mode/depth.ts";
import {
	findAgentAssetFile,
	readNamedAgentMaxSubagentDepthFromFiles,
	resolveDelegatedRunMaxSubagentDepth,
} from "../max-subagent-depth.ts";

let savedMaxDepth: string | undefined;
const tempDirs: string[] = [];

function makeRoot(prefix = "pi-agent-md-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

beforeEach(() => {
	savedMaxDepth = process.env[ENV_MAX_DEPTH];
	delete process.env[ENV_MAX_DEPTH];
});

afterEach(() => {
	if (savedMaxDepth === undefined) delete process.env[ENV_MAX_DEPTH];
	else process.env[ENV_MAX_DEPTH] = savedMaxDepth;
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("findAgentAssetFile", () => {
	test("finds numbered mode files by suffix", () => {
		const root = makeRoot();
		const filePath = path.join(root, "01-builder.md");
		fs.writeFileSync(filePath, "---\nname: Builder\nmaxSubagentDepth: 1\n---\n");
		assert.strictEqual(findAgentAssetFile([assetFile(filePath, "agent")], "builder")?.filePath, filePath);
	});

	test("falls back to the frontmatter name when the filename does not match", () => {
		const root = makeRoot();
		const filePath = path.join(root, "custom.md");
		fs.writeFileSync(filePath, "---\nname: Scout\nmaxSubagentDepth: 0\n---\n");
		assert.strictEqual(readNamedAgentMaxSubagentDepthFromFiles([assetFile(filePath)], "scout"), 0);
	});

	test("reads from the effective manifest winner rather than directory order", () => {
		const root = makeRoot();
		const filePath = path.join(root, "scout.md");
		fs.writeFileSync(filePath, "---\nname: Scout\nmaxSubagentDepth: 0\n---\n");
		assert.strictEqual(readNamedAgentMaxSubagentDepthFromFiles([assetFile(filePath, "subagent", "user")], "scout"), 0);
	});
});

describe("resolveDelegatedRunMaxSubagentDepth", () => {
	test("treats child max=0 as allow self but forbid further delegation", () => {
		assert.strictEqual(resolveDelegatedRunMaxSubagentDepth({ currentDepth: 0, childAgentMaxSubagentDepth: 0 }), 1);
	});

	test("lets the top-level mode cap control nested delegation", () => {
		assert.strictEqual(
			resolveDelegatedRunMaxSubagentDepth({
				currentDepth: 0,
				parentModeMaxSubagentDepth: 1,
				childAgentMaxSubagentDepth: 1,
			}),
			1,
		);
	});

	test("inherits a stricter env cap for nested subagents", () => {
		process.env[ENV_MAX_DEPTH] = "1";
		assert.strictEqual(
			resolveDelegatedRunMaxSubagentDepth({
				currentDepth: 1,
				parentModeMaxSubagentDepth: 5,
				childAgentMaxSubagentDepth: 5,
			}),
			1,
		);
	});
});

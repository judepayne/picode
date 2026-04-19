import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ENV_MAX_DEPTH } from "../../subagent-mode/depth.ts";
import {
	findAgentMarkdownPath,
	readNamedAgentMaxSubagentDepth,
	readNamedAgentMaxSubagentDepthFromDirs,
	resolveDelegatedRunMaxSubagentDepth,
} from "../max-subagent-depth.ts";

let savedMaxDepth: string | undefined;

beforeEach(() => {
	savedMaxDepth = process.env[ENV_MAX_DEPTH];
	delete process.env[ENV_MAX_DEPTH];
});

afterEach(() => {
	if (savedMaxDepth === undefined) delete process.env[ENV_MAX_DEPTH];
	else process.env[ENV_MAX_DEPTH] = savedMaxDepth;
});

describe("findAgentMarkdownPath", () => {
	test("finds numbered mode files by suffix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-md-"));
		try {
			fs.writeFileSync(path.join(root, "01-builder.md"), "---\nname: Builder\nmaxSubagentDepth: 1\n---\n");
			assert.strictEqual(findAgentMarkdownPath(root, "builder"), path.join(root, "01-builder.md"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to the frontmatter name when the filename does not match", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-md-"));
		try {
			fs.writeFileSync(path.join(root, "custom.md"), "---\nname: Scout\nmaxSubagentDepth: 0\n---\n");
			assert.strictEqual(readNamedAgentMaxSubagentDepth(root, "scout"), 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("prefers the first matching asset dir when searching multiple roots", () => {
		const overlay = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-md-overlay-"));
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-md-base-"));
		try {
			fs.writeFileSync(path.join(base, "scout.md"), "---\nname: Scout\nmaxSubagentDepth: 1\n---\n");
			fs.writeFileSync(path.join(overlay, "scout.md"), "---\nname: Scout\nmaxSubagentDepth: 0\n---\n");
			assert.strictEqual(readNamedAgentMaxSubagentDepthFromDirs([overlay, base], "scout"), 0);
		} finally {
			fs.rmSync(overlay, { recursive: true, force: true });
			fs.rmSync(base, { recursive: true, force: true });
		}
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

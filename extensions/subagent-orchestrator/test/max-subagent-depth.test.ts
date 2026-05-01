import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ENV_MAX_DEPTH } from "../../subagent-mode/depth.ts";
import {
	readNamedAgentMaxSubagentDepthFromCards,
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

describe("readNamedAgentMaxSubagentDepthFromCards", () => {
	test("finds cards by slugified name", () => {
		assert.strictEqual(
			readNamedAgentMaxSubagentDepthFromCards([{ name: "Builder", maxSubagentDepth: "1" }], "builder"),
			1,
		);
		assert.strictEqual(
			readNamedAgentMaxSubagentDepthFromCards([{ name: "Research Assistant", maxSubagentDepth: "0" }], "research-assistant"),
			0,
		);
	});

	test("returns undefined for missing or invalid depth", () => {
		assert.strictEqual(readNamedAgentMaxSubagentDepthFromCards([{ name: "Scout" }], "scout"), undefined);
		assert.strictEqual(readNamedAgentMaxSubagentDepthFromCards([{ name: "Scout", maxSubagentDepth: "nope" }], "scout"), undefined);
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

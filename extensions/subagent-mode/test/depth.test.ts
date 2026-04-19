import * as assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	buildChildDepthEnv,
	checkSubagentDepth,
	currentParentChildId,
	currentSubagentDepth,
	currentTopLevelRunId,
	DEFAULT_MAX_SUBAGENT_DEPTH,
	ENV_DEPTH,
	ENV_MAX_DEPTH,
	ENV_PARENT_CHILD_ID,
	ENV_TOP_RUN_ID,
	normalizeMaxSubagentDepth,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../depth.ts";

const DEPTH_ENVS = [ENV_DEPTH, ENV_MAX_DEPTH, ENV_TOP_RUN_ID, ENV_PARENT_CHILD_ID];

function stashEnv(): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const key of DEPTH_ENVS) out[key] = process.env[key];
	return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const key of DEPTH_ENVS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
}

describe("normalizeMaxSubagentDepth", () => {
	test("accepts non-negative integers", () => {
		assert.strictEqual(normalizeMaxSubagentDepth(0), 0);
		assert.strictEqual(normalizeMaxSubagentDepth(5), 5);
		assert.strictEqual(normalizeMaxSubagentDepth("3"), 3);
	});

	test("rejects fractions, negatives, and nonsense", () => {
		assert.strictEqual(normalizeMaxSubagentDepth(1.5), undefined);
		assert.strictEqual(normalizeMaxSubagentDepth(-1), undefined);
		assert.strictEqual(normalizeMaxSubagentDepth("abc"), undefined);
		assert.strictEqual(normalizeMaxSubagentDepth(undefined), undefined);
		assert.strictEqual(normalizeMaxSubagentDepth(null), undefined);
	});
});

describe("resolveCurrentMaxSubagentDepth", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => { saved = stashEnv(); });
	afterEach(() => { restoreEnv(saved); });

	test("env PI_SUBAGENT_MAX_DEPTH takes precedence", () => {
		process.env[ENV_MAX_DEPTH] = "4";
		assert.strictEqual(resolveCurrentMaxSubagentDepth(1), 4);
	});

	test("config falls back when env is absent", () => {
		delete process.env[ENV_MAX_DEPTH];
		assert.strictEqual(resolveCurrentMaxSubagentDepth(1), 1);
	});

	test("default is used when neither env nor config is set", () => {
		delete process.env[ENV_MAX_DEPTH];
		assert.strictEqual(resolveCurrentMaxSubagentDepth(), DEFAULT_MAX_SUBAGENT_DEPTH);
	});
});

describe("resolveChildMaxSubagentDepth", () => {
	test("takes the minimum of parent and agent caps", () => {
		assert.strictEqual(resolveChildMaxSubagentDepth(3, 1), 1);
		assert.strictEqual(resolveChildMaxSubagentDepth(2, 5), 2);
	});

	test("inherits parent when agent cap is undefined", () => {
		assert.strictEqual(resolveChildMaxSubagentDepth(3), 3);
	});
});

describe("checkSubagentDepth", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => { saved = stashEnv(); });
	afterEach(() => { restoreEnv(saved); });

	test("blocks when depth >= maxDepth", () => {
		process.env[ENV_DEPTH] = "2";
		process.env[ENV_MAX_DEPTH] = "2";
		const check = checkSubagentDepth();
		assert.strictEqual(check.blocked, true);
		assert.strictEqual(check.depth, 2);
		assert.strictEqual(check.maxDepth, 2);
	});

	test("allows when depth < maxDepth", () => {
		process.env[ENV_DEPTH] = "0";
		process.env[ENV_MAX_DEPTH] = "2";
		const check = checkSubagentDepth();
		assert.strictEqual(check.blocked, false);
	});

	test("defaults to depth=0 when env missing", () => {
		delete process.env[ENV_DEPTH];
		delete process.env[ENV_MAX_DEPTH];
		const check = checkSubagentDepth();
		assert.strictEqual(check.depth, 0);
		assert.strictEqual(check.maxDepth, DEFAULT_MAX_SUBAGENT_DEPTH);
		assert.strictEqual(check.blocked, false);
	});
});

describe("buildChildDepthEnv", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => { saved = stashEnv(); });
	afterEach(() => { restoreEnv(saved); });

	test("increments depth and stamps identity for a top-level child", () => {
		delete process.env[ENV_DEPTH];
		delete process.env[ENV_MAX_DEPTH];
		const env = buildChildDepthEnv({
			topLevelRunId: "run-root",
			parentChildId: "root",
			maxDepth: 3,
		});
		assert.strictEqual(env[ENV_DEPTH], "1");
		assert.strictEqual(env[ENV_MAX_DEPTH], "3");
		assert.strictEqual(env[ENV_TOP_RUN_ID], "run-root");
		assert.strictEqual(env[ENV_PARENT_CHILD_ID], "root");
	});

	test("propagates depth for nested children", () => {
		process.env[ENV_DEPTH] = "1";
		process.env[ENV_MAX_DEPTH] = "3";
		const env = buildChildDepthEnv({
			topLevelRunId: "run-root",
			parentChildId: "child-0",
		});
		assert.strictEqual(env[ENV_DEPTH], "2");
		assert.strictEqual(env[ENV_MAX_DEPTH], "3");
		assert.strictEqual(env[ENV_PARENT_CHILD_ID], "child-0");
	});
});

describe("current*() env readers", () => {
	let saved: Record<string, string | undefined>;
	beforeEach(() => { saved = stashEnv(); });
	afterEach(() => { restoreEnv(saved); });

	test("read-through env vars with graceful fallbacks", () => {
		process.env[ENV_DEPTH] = "2";
		process.env[ENV_TOP_RUN_ID] = "run-a";
		process.env[ENV_PARENT_CHILD_ID] = "child-a";
		assert.strictEqual(currentSubagentDepth(), 2);
		assert.strictEqual(currentTopLevelRunId(), "run-a");
		assert.strictEqual(currentParentChildId(), "child-a");

		delete process.env[ENV_DEPTH];
		delete process.env[ENV_TOP_RUN_ID];
		delete process.env[ENV_PARENT_CHILD_ID];
		assert.strictEqual(currentSubagentDepth(), 0);
		assert.strictEqual(currentTopLevelRunId(), undefined);
		assert.strictEqual(currentParentChildId(), undefined);
	});
});

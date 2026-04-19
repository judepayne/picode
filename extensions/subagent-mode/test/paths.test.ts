import * as assert from "node:assert";
import * as path from "node:path";
import { describe, test } from "node:test";

import {
	ARTIFACTS_DIR,
	ASYNC_RESULTS_DIR,
	ASYNC_RUNS_DIR,
	asyncRunDir,
	asyncRunEventsPath,
	asyncRunManifestPath,
	asyncRunResultPath,
	asyncRunResultTempPath,
	CHAIN_RUNS_DIR,
	chainRunDir,
	resolveTempScopeId,
	TEMP_ROOT_DIR,
} from "../paths.ts";

// ============================================================================
// pi-gate policy glob compatibility
// ============================================================================
//
// pi-gate/policy.json hardcodes globs that MUST continue to match the paths
// produced here. Any drift silently revokes scout-profile access.
//
//   "**/pi-subagents-*/async-subagent-runs/**"
//   "**/pi-subagents-*/async-subagent-results/**"
//   "**/pi-subagents-*/chain-runs/**"
//   "**/pi-subagents-*/artifacts/**"
//
// These assertions convert the design contract into a failing test if the
// path layout changes.

const PI_SUBAGENTS_GLOB_PARENT = /^pi-subagents-[A-Za-z0-9._-]+$/;

describe("paths: pi-gate policy compatibility", () => {
	test("TEMP_ROOT_DIR basename matches pi-subagents-<scope>", () => {
		const basename = path.basename(TEMP_ROOT_DIR);
		assert.match(basename, PI_SUBAGENTS_GLOB_PARENT);
	});

	test("ASYNC_RUNS_DIR basename is async-subagent-runs under the pi-subagents parent", () => {
		assert.strictEqual(path.basename(ASYNC_RUNS_DIR), "async-subagent-runs");
		assert.strictEqual(path.dirname(ASYNC_RUNS_DIR), TEMP_ROOT_DIR);
	});

	test("ASYNC_RESULTS_DIR basename is async-subagent-results", () => {
		assert.strictEqual(path.basename(ASYNC_RESULTS_DIR), "async-subagent-results");
		assert.strictEqual(path.dirname(ASYNC_RESULTS_DIR), TEMP_ROOT_DIR);
	});

	test("CHAIN_RUNS_DIR basename is chain-runs", () => {
		assert.strictEqual(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.strictEqual(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
	});

	test("ARTIFACTS_DIR basename is artifacts", () => {
		assert.strictEqual(path.basename(ARTIFACTS_DIR), "artifacts");
		assert.strictEqual(path.dirname(ARTIFACTS_DIR), TEMP_ROOT_DIR);
	});
});

describe("paths: per-run file layout", () => {
	const runId = "01234567-89ab-cdef-0123-456789abcdef";

	test("asyncRunDir is ASYNC_RUNS_DIR/<runId>", () => {
		assert.strictEqual(asyncRunDir(runId), path.join(ASYNC_RUNS_DIR, runId));
	});

	test("manifest, events, and result files live under the run dir", () => {
		const dir = asyncRunDir(runId);
		assert.strictEqual(asyncRunManifestPath(runId), path.join(dir, "run.json"));
		assert.strictEqual(asyncRunEventsPath(runId), path.join(dir, "events.jsonl"));
		assert.strictEqual(asyncRunResultPath(runId), path.join(dir, "result.json"));
		assert.strictEqual(asyncRunResultTempPath(runId), path.join(dir, "result.json.tmp"));
	});

	test("chainRunDir is CHAIN_RUNS_DIR/<runId>", () => {
		assert.strictEqual(chainRunDir(runId), path.join(CHAIN_RUNS_DIR, runId));
	});
});

describe("resolveTempScopeId: deterministic scoping", () => {
	test("prefers uid when available", () => {
		const id = resolveTempScopeId({ env: {}, getuid: () => 501 });
		assert.strictEqual(id, "uid-501");
	});

	test("falls back to env username when no uid", () => {
		const id = resolveTempScopeId({
			env: { USER: "alice" },
			getuid: undefined,
			userInfo: () => ({ username: null }),
			homedir: () => "/home/alice",
		});
		assert.strictEqual(id, "user-alice");
	});

	test("sanitizes unsafe segments", () => {
		const id = resolveTempScopeId({
			env: { USER: "weird / name!" },
			getuid: undefined,
			userInfo: () => ({ username: null }),
			homedir: () => "/home",
		});
		// Non-[A-Za-z0-9._-] collapses to "-", then leading/trailing dashes stripped.
		assert.strictEqual(id, "user-weird-name");
	});

	test("falls back to home-based scope when username unavailable", () => {
		const id = resolveTempScopeId({
			env: { HOME: "/home/bob" },
			getuid: undefined,
			userInfo: () => ({ username: null }),
			homedir: () => "/home/bob",
		});
		// sanitizeTempScopeSegment strips leading/trailing dashes.
		assert.strictEqual(id, "home-home-bob");
	});

	test("last-resort returns 'shared'", () => {
		const id = resolveTempScopeId({
			env: {},
			getuid: undefined,
			userInfo: () => ({ username: null }),
			homedir: () => "",
		});
		assert.strictEqual(id, "shared");
	});
});

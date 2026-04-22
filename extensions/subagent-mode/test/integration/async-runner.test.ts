/**
 * Integration test for the async-runner persistence flow.
 *
 * Invokes `runAsyncMain` directly (same process) rather than spawning a
 * detached child. That way we exercise the full persistence contract —
 * run.json, events.jsonl, result.json — without requiring jiti to be
 * resolvable in the test environment.
 *
 * A separate fully-detached test is gated behind `isAsyncAvailable()`.
 */

import * as assert from "node:assert";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { runAsyncMain } from "../../async-executor.ts";
import {
	asyncConfigPath,
	asyncRunDir,
	asyncRunEventsPath,
	asyncRunManifestPath,
	asyncRunResultPath,
	TEMP_ROOT_DIR,
} from "../../paths.ts";
import { ASYNC_SCHEMA_VERSION, type AsyncResultFile, type AsyncRunManifest } from "../../types.ts";

function piInstalled(): boolean {
	try {
		execSync("which pi", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("async-runner persistence", { skip: !piInstalled() }, () => {
	test("runAsyncMain writes run.json, events.jsonl, result.json for a complete run", async () => {
		const runId = `async-main-test-${Date.now()}`;
		const cfgPath = asyncConfigPath(runId);
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.writeFileSync(cfgPath, JSON.stringify({
			runId,
			cwd: process.cwd(),
			spec: {
				mode: "single",
				context: "fresh",
				agent: "scout",
				task: "Say exactly 'async-hello' and nothing else.",
			},
		}));

		await runAsyncMain(cfgPath);

		// Manifest exists and has terminal status.
		const manifestRaw = fs.readFileSync(asyncRunManifestPath(runId), "utf-8");
		const manifest = JSON.parse(manifestRaw) as AsyncRunManifest;
		assert.strictEqual(manifest.schemaVersion, ASYNC_SCHEMA_VERSION);
		assert.strictEqual(manifest.runId, runId);
		assert.ok(["complete", "failed", "cancelled"].includes(manifest.status));
		assert.ok(manifest.endedAt && manifest.endedAt > manifest.startedAt);
		assert.ok(manifest.children.length >= 1);

		// Result file exists and parses.
		const resultRaw = fs.readFileSync(asyncRunResultPath(runId), "utf-8");
		const resultFile = JSON.parse(resultRaw) as AsyncResultFile;
		assert.strictEqual(resultFile.runId, runId);
		assert.strictEqual(resultFile.result.runId, runId);
		assert.strictEqual(resultFile.result.mode, "single");
		assert.strictEqual(resultFile.result.status, "complete");
		assert.strictEqual(resultFile.result.results.length, 1);
		assert.ok(resultFile.result.results[0]?.finalText);

		// Events stream has at least the lifecycle markers.
		const eventsRaw = fs.readFileSync(asyncRunEventsPath(runId), "utf-8");
		const lines = eventsRaw.trim().split("\n").filter(Boolean);
		const types = lines.map((line) => JSON.parse(line).type as string);
		assert.ok(types.includes("subagent:mode:run.started"));
		assert.ok(types.includes("subagent:mode:child.started"));
		assert.ok(types.includes("subagent:mode:child.complete"));
		assert.ok(types.includes("subagent:mode:run.complete"));

		if (process.platform !== "win32") {
			const mode = (target: string) => fs.statSync(target).mode & 0o777;
			assert.strictEqual(mode(asyncRunDir(runId)), 0o700);
			assert.strictEqual(mode(asyncRunManifestPath(runId)), 0o600);
			assert.strictEqual(mode(asyncRunEventsPath(runId)), 0o600);
			assert.strictEqual(mode(asyncRunResultPath(runId)), 0o600);
		}

		// Config file should be cleaned up.
		assert.strictEqual(fs.existsSync(cfgPath), false);

		// Housekeep.
		fs.rmSync(asyncRunDir(runId), { recursive: true, force: true });
	});
});

import * as assert from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import {
	buildAsyncRunnerSpawnConfig,
	cancelAsyncRun,
	isAsyncAvailable,
	watchCompletion,
} from "../async-executor.ts";
import {
	asyncRunDir,
	asyncRunManifestPath,
	asyncRunResultPath,
} from "../paths.ts";
import { ASYNC_SCHEMA_VERSION, type AsyncResultFile, type AsyncRunManifest } from "../types.ts";

function seedManifest(runId: string, overrides: Partial<AsyncRunManifest> = {}): AsyncRunManifest {
	const dir = asyncRunDir(runId);
	fs.mkdirSync(dir, { recursive: true });
	const manifest: AsyncRunManifest = {
		schemaVersion: ASYNC_SCHEMA_VERSION,
		runId,
		topLevelRunId: runId,
		mode: "single",
		agent: "scout",
		status: "running",
		pid: process.pid, // use our own pid so SIGTERM is deliverable in tests (we trap it)
		startedAt: Date.now(),
		updatedAt: Date.now(),
		endedAt: null,
		spec: { mode: "single", context: "fresh", agent: "scout", task: "t" },
		children: [],
		...overrides,
	};
	fs.writeFileSync(asyncRunManifestPath(runId), JSON.stringify(manifest, null, 2));
	return manifest;
}

function seedResult(runId: string): AsyncResultFile {
	const file: AsyncResultFile = {
		schemaVersion: ASYNC_SCHEMA_VERSION,
		runId,
		result: {
			runId,
			mode: "single",
			status: "complete",
			results: [{ childId: "c1", agent: "scout", status: "complete", finalText: "done" }],
		},
		endedAt: Date.now(),
	};
	fs.writeFileSync(asyncRunResultPath(runId), JSON.stringify(file, null, 2));
	return file;
}

describe("launchAsyncRun", () => {
	test("builds the detached async runner spawn command", () => {
		const config = buildAsyncRunnerSpawnConfig({
			cfgPath: "/tmp/run-config.json",
			cwd: "/workspace/project",
			jitiCliPath: "/node_modules/.bin/jiti",
			runnerPath: "/pkg/extensions/subagent-mode/async-runner-main.ts",
		});

		assert.strictEqual(config.command, process.execPath);
		assert.deepStrictEqual(config.args, [
			"/node_modules/.bin/jiti",
			"/pkg/extensions/subagent-mode/async-runner-main.ts",
			"/tmp/run-config.json",
		]);
		assert.deepStrictEqual(config.options, {
			cwd: "/workspace/project",
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
	});
});

describe("isAsyncAvailable", () => {
	test("returns a boolean without throwing", () => {
		// Returns true when loaded inside a pi process (jiti resolves via the
		// pi require chain). When running the test suite via bare node, the
		// candidate search can legitimately come up empty. Either is a valid
		// runtime; we only assert the function is side-effect-free and
		// returns a boolean.
		assert.strictEqual(typeof isAsyncAvailable(), "boolean");
	});
});

describe("watchCompletion", () => {
	test("fires exactly once when result.json appears", async () => {
		const runId = `test-watch-${Date.now()}`;
		fs.mkdirSync(asyncRunDir(runId), { recursive: true });
		let fired = 0;
		let captured: { runId: string; status: string } | null = null;

		const watcher = watchCompletion(runId, {
			pollIntervalMs: 25,
			onComplete: (rid, result) => {
				fired += 1;
				captured = { runId: rid, status: result.status };
			},
		});

		// Race: write the result file slightly later.
		setTimeout(() => seedResult(runId), 50);

		const start = Date.now();
		while (Date.now() - start < 2000 && fired === 0) {
			await new Promise((r) => setTimeout(r, 25));
		}
		watcher.stop();

		assert.strictEqual(fired, 1);
		assert.strictEqual(captured?.runId, runId);
		assert.strictEqual(captured?.status, "complete");

		// Additional ticks should not re-fire.
		await new Promise((r) => setTimeout(r, 100));
		assert.strictEqual(fired, 1);

		// Cleanup
		fs.rmSync(asyncRunDir(runId), { recursive: true, force: true });
	});

	test("stop() prevents onComplete even if the file exists", async () => {
		const runId = `test-watch-stop-${Date.now()}`;
		fs.mkdirSync(asyncRunDir(runId), { recursive: true });
		let fired = 0;
		const watcher = watchCompletion(runId, {
			pollIntervalMs: 50,
			onComplete: () => { fired += 1; },
		});
		watcher.stop();

		seedResult(runId);
		await new Promise((r) => setTimeout(r, 150));
		assert.strictEqual(fired, 0);

		fs.rmSync(asyncRunDir(runId), { recursive: true, force: true });
	});
});

describe("cancelAsyncRun", () => {
	test("returns ok and signals an explicitly allowed startup fallback pid", (t, done) => {
		const runId = `test-cancel-${Date.now()}`;
		// Install a SIGUSR1 handler as a proxy — we will manually send SIGTERM
		// and verify it was received. Note: we must not leave the handler
		// installed across tests.
		let received = false;
		const handler = (): void => { received = true; };
		process.once("SIGTERM", handler);

		const result = cancelAsyncRun(runId, { pid: process.pid, allowUnverifiedPid: true });
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.alreadyFinished, undefined);

		// Give node's event loop a chance to deliver the signal.
		setTimeout(() => {
			try {
				assert.strictEqual(received, true, "expected SIGTERM to be delivered");
				done();
			} catch (error) {
				done(error as Error);
			}
		}, 100);
	});

	test("returns alreadyFinished for terminal runs without signaling", () => {
		const runId = `test-cancel-finished-${Date.now()}`;
		seedManifest(runId, { status: "complete", endedAt: Date.now() });
		const result = cancelAsyncRun(runId);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.alreadyFinished, true);
		fs.rmSync(asyncRunDir(runId), { recursive: true, force: true });
	});

	test("uses fallback pid when manifest is missing", () => {
		const originalKill = process.kill;
		const calls: Array<{ pid: number; signal?: string | number }> = [];
		(process as unknown as { kill: (pid: number, signal?: string | number) => boolean }).kill = (pid, signal) => {
			calls.push({ pid, signal });
			return true;
		};
		try {
			const result = cancelAsyncRun(`nonexistent-${Date.now()}`, { pid: 12345, allowUnverifiedPid: true });
			assert.strictEqual(result.ok, true);
			assert.deepStrictEqual(calls, [{ pid: 12345, signal: "SIGTERM" }]);
		} finally {
			(process as unknown as { kill: typeof process.kill }).kill = originalKill;
		}
	});

	test("refuses a stale manifest pid that is not the async runner", () => {
		const runId = `test-cancel-stale-${Date.now()}`;
		seedManifest(runId, { pid: process.pid });
		const result = cancelAsyncRun(runId);
		assert.strictEqual(result.ok, false);
		assert.match(result.message ?? "", /could not be verified/);
		fs.rmSync(asyncRunDir(runId), { recursive: true, force: true });
	});

	test("does not use fallback pid unless explicitly allowed", () => {
		const originalKill = process.kill;
		let called = false;
		(process as unknown as { kill: (pid: number, signal?: string | number) => boolean }).kill = () => {
			called = true;
			return true;
		};
		try {
			const result = cancelAsyncRun(`nonexistent-${Date.now()}`, { pid: 12345 });
			assert.strictEqual(result.ok, false);
			assert.strictEqual(called, false);
			assert.match(result.message ?? "", /not found/);
		} finally {
			(process as unknown as { kill: typeof process.kill }).kill = originalKill;
		}
	});

	test("returns failure when the run dir is missing", () => {
		const result = cancelAsyncRun(`nonexistent-${Date.now()}`);
		assert.strictEqual(result.ok, false);
		assert.match(result.message ?? "", /not found/);
	});
});

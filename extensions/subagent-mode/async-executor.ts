/**
 * Async execution: detached runner spawn + durable state persistence.
 *
 * Responsibilities (parent side):
 *   - write the run spec to a config file
 *   - spawn a detached `jiti async-runner-main.ts <cfg>` subprocess
 *   - set up an fs watcher that emits run.complete when result.json appears
 *   - provide a cancellation hook that SIGTERMs the persisted pid
 *
 * Responsibilities (child-side `runAsyncMain`):
 *   - initialize run.json (status: "running", pid, startedAt)
 *   - open events.jsonl
 *   - execute the spec in-process via sync-executor
 *   - stream normalized events to events.jsonl
 *   - atomically write result.json on terminal status
 *   - update run.json endedAt + final status
 *
 * Async state layout under `<ASYNC_RUNS_DIR>/<runId>/`:
 *   run.json          — manifest (schemaVersion 1)
 *   events.jsonl      — normalized event stream
 *   result.json       — DelegatedRunResult (atomic write)
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	asyncConfigPath,
	asyncRunDir,
	asyncRunEventsPath,
	asyncRunManifestPath,
	asyncRunResultPath,
	asyncRunResultTempPath,
	TEMP_ROOT_DIR,
} from "./paths.ts";
import { resolvePiPackageRoot } from "./pi-spawn.ts";
import {
	ASYNC_SCHEMA_VERSION,
	type AsyncResultFile,
	type AsyncRunManifest,
	type DelegatedRunResult,
	type RunSpec,
} from "./types.ts";

// ============================================================================
// jiti resolution — mirrors pi-subagents/async-execution.ts
// ============================================================================

const require = createRequire(import.meta.url);
const jitiCliPath: string | undefined = (() => {
	const candidates: Array<() => string> = [
		() => path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs"),
		() => path.join(path.dirname(require.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs"),
		() => {
			const piRoot = resolvePiPackageRoot();
			if (!piRoot) throw new Error("no pi package root");
			const piRequire = createRequire(path.join(piRoot, "package.json"));
			try {
				return path.join(path.dirname(piRequire.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
			} catch {
				return path.join(path.dirname(piRequire.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs");
			}
		},
	];
	for (const candidate of candidates) {
		try {
			const p = candidate();
			if (fs.existsSync(p)) return p;
		} catch {
			// next candidate
		}
	}
	return undefined;
})();

export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ensurePrivateDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
	try {
		fs.chmodSync(dirPath, PRIVATE_DIR_MODE);
	} catch {
		// best effort
	}
}

function writePrivateFile(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, { mode: PRIVATE_FILE_MODE });
	try {
		fs.chmodSync(filePath, PRIVATE_FILE_MODE);
	} catch {
		// best effort
	}
}

// ============================================================================
// Parent-side launch
// ============================================================================

export interface LaunchAsyncRunInput {
	spec: RunSpec;
	cwd?: string;
	parentSessionFile?: string;
}

export interface LaunchAsyncRunOutput {
	runId: string;
	asyncDir: string;
	pid: number;
}

export function launchAsyncRun(input: LaunchAsyncRunInput): LaunchAsyncRunOutput {
	if (!jitiCliPath) {
		throw new Error("jiti is not available; async runs cannot be launched.");
	}

	const runId = crypto.randomUUID();
	const dir = asyncRunDir(runId);
	ensurePrivateDir(TEMP_ROOT_DIR);
	ensurePrivateDir(dir);

	const config: AsyncChildConfig = {
		runId,
		spec: input.spec,
		cwd: input.cwd ?? process.cwd(),
		parentSessionFile: input.parentSessionFile,
	};
	const cfgPath = asyncConfigPath(runId);
	writePrivateFile(cfgPath, JSON.stringify(config, null, 2));

	const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "async-runner-main.ts");
	const proc = spawn(process.execPath, [jitiCliPath, runnerPath, cfgPath], {
		cwd: config.cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.unref();

	return {
		runId,
		asyncDir: dir,
		pid: proc.pid ?? -1,
	};
}

// ============================================================================
// Completion watcher
// ============================================================================

export interface WatchCompletionDeps {
	pollIntervalMs?: number;
	timeoutMs?: number;
	onComplete: (runId: string, result: DelegatedRunResult) => void;
	onTimeout?: (runId: string) => void;
}

export interface CompletionWatcher {
	stop(): void;
}

/**
 * Watch `<asyncDir>/result.json`. Fires `onComplete` exactly once when the
 * file is present and parses successfully. Uses polling instead of fs.watch
 * because atomic rename semantics across platforms are inconsistent with
 * single-shot watchers.
 */
export function watchCompletion(runId: string, deps: WatchCompletionDeps): CompletionWatcher {
	const resultPath = asyncRunResultPath(runId);
	const interval = deps.pollIntervalMs ?? 250;
	const timeoutMs = deps.timeoutMs ?? 30 * 60 * 1000;
	const startedAt = Date.now();
	let stopped = false;
	let fired = false;

	const stopTimer = (timer: NodeJS.Timeout | undefined): void => {
		if (timer) clearInterval(timer);
	};

	const tick = (): void => {
		if (stopped || fired) return;
		if (Date.now() - startedAt >= timeoutMs) {
			fired = true;
			stopped = true;
			stopTimer(timer);
			deps.onTimeout?.(runId);
			return;
		}
		if (!fs.existsSync(resultPath)) return;
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const parsed = JSON.parse(raw) as AsyncResultFile;
			if (!parsed.result) return;
			fired = true;
			stopped = true;
			stopTimer(timer);
			deps.onComplete(runId, parsed.result);
		} catch {
			// Partial write; try again on next tick.
		}
	};

	const timer: NodeJS.Timeout | undefined = setInterval(tick, interval);
	tick(); // fast-path check in case the file already exists

	return {
		stop() {
			stopped = true;
			stopTimer(timer);
		},
	};
}

// ============================================================================
// Cancellation
// ============================================================================

export interface CancelAsyncRunResult {
	ok: boolean;
	alreadyFinished?: boolean;
	message?: string;
}

export function cancelAsyncRun(runId: string): CancelAsyncRunResult {
	const manifestPath = asyncRunManifestPath(runId);
	if (!fs.existsSync(manifestPath)) {
		return { ok: false, message: `async run ${runId} not found` };
	}
	let manifest: AsyncRunManifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as AsyncRunManifest;
	} catch {
		return { ok: false, message: `async run ${runId} manifest unreadable` };
	}
	if (manifest.status === "complete" || manifest.status === "failed" || manifest.status === "cancelled") {
		return { ok: true, alreadyFinished: true, message: `run already ${manifest.status}` };
	}
	if (!manifest.pid || manifest.pid <= 0) {
		return { ok: false, message: "async run has no pid to signal" };
	}
	try {
		process.kill(manifest.pid, "SIGTERM");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `SIGTERM failed: ${msg}` };
	}
	return { ok: true, message: `SIGTERM sent to pid ${manifest.pid}` };
}

// ============================================================================
// Config shared with the detached child
// ============================================================================

export interface AsyncChildConfig {
	runId: string;
	spec: RunSpec;
	cwd: string;
	parentSessionFile?: string;
}

// ============================================================================
// Child-side runtime (invoked from async-runner-main.ts)
// ============================================================================

export async function runAsyncMain(configPath: string): Promise<void> {
	const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as AsyncChildConfig;
	const { runId, spec, cwd, parentSessionFile } = cfg;
	const controller = new AbortController();
	const sigtermHandler = (): void => {
		controller.abort();
	};
	process.on("SIGTERM", sigtermHandler);
	process.on("SIGINT", sigtermHandler);

	const dir = asyncRunDir(runId);
	ensurePrivateDir(TEMP_ROOT_DIR);
	ensurePrivateDir(dir);

	const manifest: AsyncRunManifest = {
		schemaVersion: ASYNC_SCHEMA_VERSION,
		runId,
		topLevelRunId: runId,
		mode: spec.mode,
		agent: spec.agent ?? spec.chain?.[0]?.agent ?? spec.tasks?.[0]?.agent ?? "unknown",
		status: "running",
		pid: process.pid,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		endedAt: null,
		spec: { ...spec, parentSessionFile },
		children: [],
	};
	writeManifest(manifest);

	const eventsPath = asyncRunEventsPath(runId);
	const eventsStream = fs.createWriteStream(eventsPath, { flags: "a", mode: PRIVATE_FILE_MODE });
	eventsStream.on("error", (err) => {
		// Best-effort fallback: write errors should not crash the detached child.
		// The parent will eventually time out if events are lost.
	});

	// Lazy-import to avoid circular type resolution at module load time.
	const { executeRun } = await import("./sync-executor.ts");

	let result: DelegatedRunResult;
	try {
		result = await executeRun(
			{ ...spec, parentSessionFile },
			{
				signal: controller.signal,
				onEvent: (event) => {

					try {
						eventsStream.write(`${JSON.stringify(event)}\n`);
					} catch {
						// best effort
					}
					// Reflect child lifecycle in manifest
					if ("childId" in event && event.type === "subagent:mode:child.started") {
						manifest.children.push({
							childId: event.childId,
							agent: event.agent,
							stepIndex: event.stepIndex,
							taskIndex: event.taskIndex,
							status: "running",
							sessionFile: event.sessionFile,
						});
						manifest.updatedAt = Date.now();
						writeManifest(manifest);
					}
					if ("childId" in event && event.type === "subagent:mode:child.complete") {
						const entry = manifest.children.find((c) => c.childId === event.childId);
						if (entry) {
							entry.status = event.result.status;
							if (event.result.sessionFile) entry.sessionFile = event.result.sessionFile;
						}
						manifest.updatedAt = Date.now();
						writeManifest(manifest);
					}
				},
			},
			{
				cwd,
				thinking: spec.thinking,
				tools: spec.tools,
				extensions: spec.extensions,
				systemPrompt: spec.systemPrompt,
			},
			{ runId },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = {
			runId,
			mode: spec.mode,
			status: "failed",
			results: [{
				childId: crypto.randomUUID(),
				agent: manifest.agent,
				status: "failed",
				error: message,
			}],
		};
	}

	manifest.status = result.status;
	manifest.endedAt = Date.now();
	manifest.updatedAt = Date.now();
	writeManifest(manifest);

	writeResultAtomic(runId, { schemaVersion: ASYNC_SCHEMA_VERSION, runId, result, endedAt: manifest.endedAt });

	await new Promise<void>((resolve) => eventsStream.end(() => resolve()));
	process.off("SIGTERM", sigtermHandler);
	process.off("SIGINT", sigtermHandler);

	// Clean up the config file; run dir (with run.json/events.jsonl/result.json) stays.
	try {
		fs.rmSync(configPath, { force: true });
	} catch {
		// best effort
	}
}

function writeManifest(manifest: AsyncRunManifest): void {
	const p = asyncRunManifestPath(manifest.runId);
	const tmp = `${p}.tmp`;
	writePrivateFile(tmp, JSON.stringify(manifest, null, 2));
	fs.renameSync(tmp, p);
	try {
		fs.chmodSync(p, PRIVATE_FILE_MODE);
	} catch {
		// best effort
	}
}

function writeResultAtomic(runId: string, file: AsyncResultFile): void {
	const finalPath = asyncRunResultPath(runId);
	const tmp = asyncRunResultTempPath(runId);
	writePrivateFile(tmp, JSON.stringify(file, null, 2));
	fs.renameSync(tmp, finalPath);
	try {
		fs.chmodSync(finalPath, PRIVATE_FILE_MODE);
	} catch {
		// best effort
	}
}

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

import { execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { once } from "node:events";
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
const MAX_MANIFEST_DIAGNOSTICS = 20;

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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
	let lastReadErrorMessage: string | undefined;

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
		} catch (error) {
			// Partial write or corrupted artifact; try again on next tick, but keep
			// a diagnostic so persistent failures do not degrade into opaque timeouts.
			const message = formatUnknownError(error);
			if (message !== lastReadErrorMessage) {
				lastReadErrorMessage = message;
				console.warn(`[subagent-mode] failed to read async result ${resultPath}: ${message}`);
			}
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

export interface CancelAsyncRunOptions {
	/** Fallback PID persisted by the orchestrator for post-reload cancellation. */
	pid?: number;
	/** Permit PID-only cancellation when the manifest is not yet available. */
	allowUnverifiedPid?: boolean;
}

function readProcessCommand(pid: number): string | undefined {
	try {
		if (process.platform === "linux") {
			const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
			return raw.toString("utf8").replace(/\0/g, " ").trim();
		}
		if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
			return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function isExpectedAsyncRunnerProcess(pid: number, runId: string): boolean {
	const command = readProcessCommand(pid);
	return Boolean(command && command.includes("async-runner-main.ts") && command.includes(runId));
}

function signalAsyncPid(pid: number, runId: string, options: { allowUnverifiedPid?: boolean } = {}): CancelAsyncRunResult {
	if (!pid || pid <= 0) {
		return { ok: false, message: "async run has no pid to signal" };
	}
	if (options.allowUnverifiedPid !== true && !isExpectedAsyncRunnerProcess(pid, runId)) {
		return { ok: false, message: "async run pid could not be verified" };
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `SIGTERM failed: ${msg}` };
	}
	return { ok: true, message: `SIGTERM sent to pid ${pid}` };
}

export function cancelAsyncRun(runId: string, options: CancelAsyncRunOptions = {}): CancelAsyncRunResult {
	const manifestPath = asyncRunManifestPath(runId);
	if (!fs.existsSync(manifestPath)) {
		if (options.pid !== undefined && options.allowUnverifiedPid === true) return signalAsyncPid(options.pid, runId, options);
		return { ok: false, message: `async run ${runId} not found` };
	}
	let manifest: AsyncRunManifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as AsyncRunManifest;
	} catch {
		if (options.pid !== undefined && options.allowUnverifiedPid === true) return signalAsyncPid(options.pid, runId, options);
		return { ok: false, message: `async run ${runId} manifest unreadable` };
	}
	if (manifest.status === "complete" || manifest.status === "failed" || manifest.status === "cancelled") {
		return { ok: true, alreadyFinished: true, message: `run already ${manifest.status}` };
	}
	return signalAsyncPid(manifest.pid ?? -1, runId);
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

	const recordDiagnostic = (message: string, error?: unknown): void => {
		const suffix = error === undefined ? "" : `: ${formatUnknownError(error)}`;
		manifest.diagnostics = [...(manifest.diagnostics ?? []), `${message}${suffix}`].slice(-MAX_MANIFEST_DIAGNOSTICS);
		manifest.updatedAt = Date.now();
		try {
			writeManifest(manifest);
		} catch {
			// If even the manifest cannot be updated, there is no more durable
			// channel available in the detached child.
		}
	};

	const eventsPath = asyncRunEventsPath(runId);
	const eventsStream = fs.createWriteStream(eventsPath, { flags: "a", mode: PRIVATE_FILE_MODE });
	let recordedEventsStreamError = false;
	eventsStream.on("error", (error) => {
		// Best-effort fallback: write errors should not crash the detached child,
		// but they should be visible in run.json for post-mortem debugging.
		if (recordedEventsStreamError) return;
		recordedEventsStreamError = true;
		recordDiagnostic("async event stream write failed", error);
	});
	const writeEvent = async (event: unknown): Promise<void> => {
		try {
			const ready = eventsStream.write(`${JSON.stringify(event)}\n`);
			if (!ready) await Promise.race([once(eventsStream, "drain"), once(eventsStream, "error")]);
		} catch (error) {
			recordDiagnostic("async event write threw", error);
		}
	};

	// Lazy-import to avoid circular type resolution at module load time.
	const { executeRun } = await import("./sync-executor.ts");

	let result: DelegatedRunResult;
	try {
		result = await executeRun(
			{ ...spec, parentSessionFile },
			{
				signal: controller.signal,
				onEvent: async (event) => {
					await writeEvent(event);
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

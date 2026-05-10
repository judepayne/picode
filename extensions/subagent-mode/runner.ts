/**
 * Per-child execution primitive.
 *
 *   runChild(request, callbacks) → DelegatedChildResult
 *
 * Spawns `pi --mode json -p`, streams its stdout line-by-line through the
 * normalizer, and emits normalized ChildEvents via the caller-provided
 * callback. Handles:
 *   - stdin closed at spawn (pi -p hangs waiting for stdin otherwise)
 *   - line-buffered JSONL parsing across chunk boundaries
 *   - cancellation via AbortSignal → SIGTERM → (3s later) SIGKILL
 *   - gate-profile and depth/identity env injection
 *   - deterministic emit order: child.started → …normalized… → child.complete
 *
 * This file is the substrate's core. Everything above it (sync-executor,
 * async-executor, orchestrator-bridge) composes children into runs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildChildPiArgs, buildChildEnv, cleanupChildTempDir, resolvePiSpawnCommand } from "./pi-spawn.ts";
import {
	buildFinalResult,
	createNormalizerState,
	normalizeRawEvent,
	parseRawLine,
	type NormalizerIdentity,
	type NormalizerState,
} from "./normalizer.ts";
import {
	EVENT_CHILD_CANCELLED,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_STARTED,
	type ChildEvent,
	type ChildExecutionRequest,
	type DelegatedChildResult,
} from "./types.ts";

// ============================================================================
// Public surface
// ============================================================================

export type ChildEventHandler = (event: ChildEvent) => void;

export interface RunChildCallbacks {
	onEvent: ChildEventHandler;
	/** Per-raw-line tap for async event-log persistence or debugging. */
	onRawLine?: (line: string) => void;
	signal?: AbortSignal;
}

export interface RunChildOptions {
	cwd?: string;
	/** Additional env to layer on top of the gate/depth contract. */
	extraEnv?: Record<string, string | undefined>;
	/** Tools to enable in the child (names and/or extension paths). */
	tools?: string[];
	/** Extension paths; when undefined, pi's default discovery applies. */
	extensions?: string[];
	/** Suppress skill auto-discovery in the child. */
	disableSkills?: boolean;
	/** Inline system prompt text; written to tmp file. */
	systemPrompt?: string;
	/** Thinking level (off|minimal|low|medium|high|xhigh). */
	thinking?: string;
	/** Directory for pi session files (if session enabled). */
	sessionDir?: string;
}

export function resolveDefaultChildExtensionPaths(): string[] {
	const assetsRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
	const extensionRoot = path.join(assetsRoot, "extensions");
	const preferred = ["agent-assets", "pi-gate", "subagent-mode", "subagent-orchestrator", "z-prompt-vars"];
	return preferred
		.map((name) => {
			const dir = path.join(extensionRoot, name);
			const entry = path.join(dir, "index.ts");
			if (fs.existsSync(dir)) return dir;
			if (fs.existsSync(entry)) return entry;
			return undefined;
		})
		.filter((value): value is string => Boolean(value));
}

export async function runChild(
	request: ChildExecutionRequest,
	callbacks: RunChildCallbacks,
	options: RunChildOptions = {},
): Promise<DelegatedChildResult> {
	const identity: NormalizerIdentity = {
		runId: request.runId,
		topLevelRunId: request.topLevelRunId,
		childId: request.childId,
		parentChildId: request.parentChildId,
		agent: request.agent,
		depth: request.depth,
		stepIndex: request.stepIndex,
		taskIndex: request.taskIndex,
	};

	const state = createNormalizerState();
	if (request.sessionFile) state.sessionFile = request.sessionFile;

	const { args, tempDir } = buildChildPiArgs({
		task: request.task,
		sessionEnabled: Boolean(request.sessionFile),
		sessionFile: request.sessionFile,
		sessionDir: options.sessionDir,
		model: request.model,
		thinking: options.thinking,
		tools: options.tools,
		extensions: options.extensions ?? resolveDefaultChildExtensionPaths(),
		disableSkills: options.disableSkills,
		systemPrompt: options.systemPrompt,
		promptFileStem: `subagent-${request.agent}`,
	});

	const env = {
		...process.env,
		...buildChildEnv({
			agent: request.agent,
			maxDepth: request.maxSubagentDepth,
			topLevelRunId: request.topLevelRunId,
			// Env sent to the spawned child is its OWN childId — so that if the
			// child delegates further, its grandchildren stamp parentChildId =
			// this child. Do NOT use request.parentChildId here (that's the
			// current child's parent, not what its descendants need).
			parentChildId: request.childId,
			extra: { ...options.extraEnv, ...request.env },
		}),
	};

	const spawnCmd = resolvePiSpawnCommand(args);

	// Fire child.started before spawn so subscribers see the lifecycle boundary
	// even if spawn fails immediately.
	callbacks.onEvent({
		type: EVENT_CHILD_STARTED,
		runId: identity.runId,
		topLevelRunId: identity.topLevelRunId,
		childId: identity.childId,
		parentChildId: identity.parentChildId,
		agent: identity.agent,
		timestamp: Date.now(),
		stepIndex: identity.stepIndex,
		taskIndex: identity.taskIndex,
		depth: identity.depth,
		sessionFile: request.sessionFile,
	});

	let proc: ChildProcess;
	try {
		proc = spawn(spawnCmd.command, spawnCmd.args, {
			cwd: options.cwd ?? request.cwd ?? process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"], // stdin closed; stdout/stderr piped
		});
	} catch (error) {
		cleanupChildTempDir(tempDir);
		const message = error instanceof Error ? error.message : String(error);
		callbacks.onEvent({
			type: EVENT_CHILD_ERROR,
			runId: identity.runId,
			topLevelRunId: identity.topLevelRunId,
			childId: identity.childId,
			parentChildId: identity.parentChildId,
			agent: identity.agent,
			timestamp: Date.now(),
			stepIndex: identity.stepIndex,
			taskIndex: identity.taskIndex,
			depth: identity.depth,
			message: `spawn failed: ${message}`,
			fatal: true,
		});
		const result = buildFinalResult({
			identity,
			state,
			exitCode: -1,
			cancelled: false,
			spawnError: message,
		});
		callbacks.onEvent(finalEvent(EVENT_CHILD_COMPLETE, identity, { result }));
		return result;
	}

	const outcome = await streamAndCollect(proc, identity, state, callbacks);
	cleanupChildTempDir(tempDir);

	const result = buildFinalResult({
		identity,
		state,
		exitCode: outcome.exitCode,
		cancelled: outcome.cancelled,
		spawnError: outcome.spawnError,
	});

	if (outcome.cancelled) {
		callbacks.onEvent(finalEvent(EVENT_CHILD_CANCELLED, identity, { reason: outcome.cancelReason }));
	}
	callbacks.onEvent(finalEvent(EVENT_CHILD_COMPLETE, identity, { result }));
	return result;
}

// ============================================================================
// Internal: stdout streaming + lifecycle
// ============================================================================

interface StreamOutcome {
	exitCode: number;
	cancelled: boolean;
	cancelReason?: string;
	spawnError?: string;
}

function streamAndCollect(
	proc: ChildProcess,
	identity: NormalizerIdentity,
	state: NormalizerState,
	callbacks: RunChildCallbacks,
): Promise<StreamOutcome> {
	return new Promise<StreamOutcome>((resolve) => {
		let cancelled = false;
		let cancelReason: string | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		let stdoutBuf = "";
		let stderrBuf = "";

		const flushLine = (line: string): void => {
			if (!line.trim()) return;
			callbacks.onRawLine?.(line);
			let raw: ReturnType<typeof parseRawLine>;
			try {
				raw = parseRawLine(line);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				callbacks.onEvent({
					type: EVENT_CHILD_ERROR,
					runId: identity.runId,
					topLevelRunId: identity.topLevelRunId,
					childId: identity.childId,
					parentChildId: identity.parentChildId,
					agent: identity.agent,
					timestamp: Date.now(),
					stepIndex: identity.stepIndex,
					taskIndex: identity.taskIndex,
					depth: identity.depth,
					message,
					fatal: false,
				});
				return;
			}
			if (!raw) return;
			const events = normalizeRawEvent(raw, identity, state);
			for (const event of events) callbacks.onEvent(event);
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString("utf-8");
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() ?? "";
			for (const line of lines) flushLine(line);
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			if (stderrBuf.length + text.length > 20000) {
				// Cap accumulation at ~20KB to prevent unbounded memory growth.
				const overflow = stderrBuf.length + text.length - 20000;
				stderrBuf = stderrBuf.slice(overflow) + text;
			} else {
				stderrBuf += text;
			}
		});

		proc.once("error", (error) => {
			if (killTimer) clearTimeout(killTimer);
			resolve({
				exitCode: -1,
				cancelled,
				cancelReason,
				spawnError: error instanceof Error ? error.message : String(error),
			});
		});

		proc.once("close", (code, signal) => {
			if (killTimer) clearTimeout(killTimer);
			if (stdoutBuf.trim()) flushLine(stdoutBuf);

			// Capture stderr into state.errorMessage only when the process failed
			// and the normalizer did not already surface a structured error.
			const exitCode = typeof code === "number" ? code : (signal ? -1 : 0);
			if (exitCode !== 0 && !state.errorMessage && stderrBuf.trim()) {
				state.errorMessage = stderrBuf.trim().slice(0, 2000);
			}

			resolve({ exitCode, cancelled, cancelReason });
		});

		const abort = (reason?: string): void => {
			if (cancelled) return;
			cancelled = true;
			cancelReason = reason ?? "aborted";
			try {
				proc.kill("SIGTERM");
			} catch {
				// Already exited.
			}
			killTimer = setTimeout(() => {
				if (!proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						// Best effort.
					}
				}
			}, 3000);
		};

		if (callbacks.signal) {
			if (callbacks.signal.aborted) {
				abort("signal already aborted");
			} else {
				callbacks.signal.addEventListener("abort", () => abort(), { once: true });
			}
		}
	});
}

function finalEvent(
	type: typeof EVENT_CHILD_COMPLETE | typeof EVENT_CHILD_CANCELLED,
	identity: NormalizerIdentity,
	payload: Record<string, unknown>,
): ChildEvent {
	return {
		type,
		runId: identity.runId,
		topLevelRunId: identity.topLevelRunId,
		childId: identity.childId,
		parentChildId: identity.parentChildId,
		agent: identity.agent,
		timestamp: Date.now(),
		stepIndex: identity.stepIndex,
		taskIndex: identity.taskIndex,
		depth: identity.depth,
		...payload,
	} as ChildEvent;
}

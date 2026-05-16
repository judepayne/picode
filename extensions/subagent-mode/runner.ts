/**
 * Per-child execution primitive.
 *
 *   runChild(request, callbacks) → DelegatedChildResult
 *
 * Public facade for child execution. By default, child spawn/stdout parsing runs
 * in a worker thread and transcript-grade events stay out of the callback. The
 * worker owns node-log persistence when a node-log target is supplied. The
 * in-process runner remains available as a fallback when the worker cannot
 * start.
 */

import { Worker } from "node:worker_threads";

import { appendChildNodeLogRecord, appendExpandedTaskNodeLogRecord } from "./node-log-writer.ts";
import { runChildInProcess } from "./runner-core.ts";
import type { RunChildCallbacks, RunChildOptions } from "./runner-core.ts";
import { isControlPlaneChildEvent, type RunnerWorkerMainMessage, type RunnerWorkerParentMessage } from "./runner-worker-protocol.ts";
import {
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_ERROR,
	type ChildEvent,
	type ChildExecutionRequest,
	type DelegatedChildResult,
} from "./types.ts";

export {
	MAX_STDOUT_LINE_BYTES,
	resolveDefaultChildExtensionPaths,
	runChildInProcess,
} from "./runner-core.ts";
export type { ChildEventHandler, RunChildCallbacks, RunChildOptions } from "./runner-core.ts";

export async function runChild(
	request: ChildExecutionRequest,
	callbacks: RunChildCallbacks,
	options: RunChildOptions = {},
): Promise<DelegatedChildResult> {
	return runChildWithWorker(request, callbacks, options);
}

function runChildWithWorker(
	request: ChildExecutionRequest,
	callbacks: RunChildCallbacks,
	options: RunChildOptions,
): Promise<DelegatedChildResult> {
	writeExpandedTaskNodeLog(request);
	let worker: Worker;
	try {
		worker = createRunnerWorker();
	} catch (error) {
		return fallbackToInProcess(request, callbacks, options, error);
	}

	return new Promise<DelegatedChildResult>((resolve, reject) => {
		let settled = false;
		let escapedEvent = false;
		let eventWork = Promise.resolve();

		const abort = (): void => {
			postToWorker(worker, { type: "cancel", reason: "aborted" });
		};

		const cleanup = (): void => {
			worker.off("message", onMessage);
			worker.off("error", onWorkerError);
			worker.off("exit", onExit);
			callbacks.signal?.removeEventListener("abort", abort);
			void worker.terminate();
		};

		const finish = (result: DelegatedChildResult): void => {
			if (settled) return;
			settled = true;
			void eventWork.then(() => {
				cleanup();
				resolve(result);
			}, (error) => {
				cleanup();
				reject(error);
			});
		};

		const handleWorkerFailure = (error: unknown): void => {
			if (settled) return;
			if (!escapedEvent) {
				settled = true;
				cleanup();
				void fallbackToInProcess(request, callbacks, options, error).then(resolve, reject);
				return;
			}
			const result = workerFailureResult(request, error);
			enqueueEvent(workerFailureErrorEvent(request, result.error ?? "runner worker failed"));
			enqueueEvent(workerFailureCompleteEvent(request, result));
			finish(result);
		};

		const enqueueEvent = (event: ChildEvent): void => {
			escapedEvent = true;
			eventWork = eventWork.then(() => callbacks.onEvent(event));
		};

		function onMessage(message: RunnerWorkerParentMessage): void {
			if (settled) return;
			switch (message.type) {
				case "event":
					enqueueEvent(message.event);
					return;
				case "raw-line":
					callbacks.onRawLine?.(message.line);
					return;
				case "result":
					finish(message.result);
					return;
				case "error":
					handleWorkerFailure(new Error(message.message));
					return;
			}
		}

		function onWorkerError(error: Error): void {
			handleWorkerFailure(error);
		}

		function onExit(code: number): void {
			if (!settled && code !== 0) handleWorkerFailure(new Error(`runner worker exited with code ${code}`));
		}

		worker.on("message", onMessage);
		worker.on("error", onWorkerError);
		worker.on("exit", onExit);

		callbacks.signal?.addEventListener("abort", abort, { once: true });
		postToWorker(worker, {
			type: "run",
			request,
			options: toRunnerWorkerOptions(options),
			includeRawLines: Boolean(callbacks.onRawLine),
			emitDataPlaneEvents: options.emitDataPlaneEvents === true,
		});
		if (callbacks.signal?.aborted) abort();
	});
}

function createRunnerWorker(): Worker {
	return new Worker(new URL("./runner-worker.ts", import.meta.url));
}

function postToWorker(worker: Worker, message: RunnerWorkerMainMessage): void {
	worker.postMessage(message);
}

async function fallbackToInProcess(
	request: ChildExecutionRequest,
	callbacks: RunChildCallbacks,
	options: RunChildOptions,
	error: unknown,
): Promise<DelegatedChildResult> {
	console.warn(`[picode] subagent runner worker failed; falling back to in-main execution: ${errorMessage(error)}`);
	return runChildInProcess(request, fallbackCallbacks(callbacks, options, request), options);
}

export function toRunnerWorkerOptions(options: RunChildOptions): RunChildOptions {
	return {
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
		...(options.tools !== undefined ? { tools: options.tools } : {}),
		...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
		...(options.disableSkills !== undefined ? { disableSkills: options.disableSkills } : {}),
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
		...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
		...(options.emitDataPlaneEvents !== undefined ? { emitDataPlaneEvents: options.emitDataPlaneEvents } : {}),
	};
}

function fallbackCallbacks(callbacks: RunChildCallbacks, options: RunChildOptions, request?: ChildExecutionRequest): RunChildCallbacks {
	return {
		...callbacks,
		onEvent: (event) => {
			const hasNodeLogTarget = request?.nodeLog !== undefined;
			const nodeLogWritten = writeNodeLog(request?.nodeLog, event);
			if (options.emitDataPlaneEvents === true || isControlPlaneChildEvent(event) || (hasNodeLogTarget && !nodeLogWritten)) {
				return callbacks.onEvent(nodeLogWritten ? { ...event, nodeLogWritten: true } : event);
			}
		},
	};
}

function writeNodeLog(config: ChildExecutionRequest["nodeLog"], event: ChildEvent): boolean {
	try {
		return appendChildNodeLogRecord(config, event);
	} catch (error) {
		console.warn(`[picode] subagent in-main runner could not append node log: ${errorMessage(error)}`);
		return false;
	}
}

function writeExpandedTaskNodeLog(request: ChildExecutionRequest): void {
	try {
		appendExpandedTaskNodeLogRecord(request);
	} catch (error) {
		console.warn(`[picode] subagent runner could not append expanded task node log: ${errorMessage(error)}`);
	}
}

function workerFailureResult(request: ChildExecutionRequest, error: unknown): DelegatedChildResult {
	return {
		childId: request.childId,
		agent: request.agent,
		status: "failed",
		error: `runner worker failed: ${errorMessage(error)}`,
		sessionFile: request.sessionFile,
	};
}

function workerFailureErrorEvent(request: ChildExecutionRequest, message: string): ChildEvent {
	return {
		type: EVENT_CHILD_ERROR,
		runId: request.runId,
		topLevelRunId: request.topLevelRunId,
		childId: request.childId,
		parentChildId: request.parentChildId,
		agent: request.agent,
		timestamp: Date.now(),
		stepIndex: request.stepIndex,
		taskIndex: request.taskIndex,
		depth: request.depth,
		message,
		fatal: true,
	};
}

function workerFailureCompleteEvent(request: ChildExecutionRequest, result: DelegatedChildResult): ChildEvent {
	return {
		type: EVENT_CHILD_COMPLETE,
		runId: request.runId,
		topLevelRunId: request.topLevelRunId,
		childId: request.childId,
		parentChildId: request.parentChildId,
		agent: request.agent,
		timestamp: Date.now(),
		stepIndex: request.stepIndex,
		taskIndex: request.taskIndex,
		depth: request.depth,
		result,
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

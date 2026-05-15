/**
 * Synchronous run executor — composes one or more `runChild` invocations
 * into single / parallel / chain runs and aggregates them into a
 * DelegatedRunResult.
 *
 * Responsibilities:
 *   - expand parallel task specs (count → N copies)
 *   - run parallel tasks concurrently with a cap (MAX_CONCURRENCY)
 *   - thread chain placeholders (`{task}`, `{previous}`, `{chain_dir}`)
 *   - stamp child identities (runId, topLevelRunId, parentChildId, stepIndex)
 *   - enforce depth ceiling at run ingress
 *   - emit RunStartedEvent / RunCompleteEvent on the normalized event stream
 *
 * This file does NOT know about the pi.events bus — it emits through the
 * supplied callback. orchestrator-bridge.ts adapts between callback and bus.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

import { checkSubagentDepth, currentParentChildId, currentSubagentDepth, currentTopLevelRunId } from "./depth.ts";
import { chainRunDir } from "./paths.ts";
import { runChild as defaultRunChild, type RunChildCallbacks, type RunChildOptions } from "./runner.ts";
import type { ChildExecutionRequest } from "./types.ts";
import {
	EVENT_RUN_COMPLETE,
	EVENT_RUN_STARTED,
	type ChainStep,
	type ChildEvent,
	type DelegatedChildResult,
	type DelegatedRunResult,
	type ParallelTaskSpec,
	type RunCompleteEvent,
	type RunSpec,
	type RunStartedEvent,
	type RunStatus,
} from "./types.ts";

// ============================================================================
// Tunables
// ============================================================================

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;

// ============================================================================
// Public surface
// ============================================================================

export interface SyncRunCallbacks {
	onEvent: (event: ChildEvent | RunStartedEvent | RunCompleteEvent) => void | Promise<void>;
	signal?: AbortSignal;
}

export interface SyncRunOptions extends Omit<RunChildOptions, "cwd"> {
	cwd?: string;
	/** Resolver for fork-mode session files, keyed by task/step index. */
	forkSessionFileForIndex?: (index: number) => string | undefined;
}

export type RunChildFn = (
	request: ChildExecutionRequest,
	callbacks: RunChildCallbacks,
	options?: RunChildOptions,
) => Promise<DelegatedChildResult>;

export interface ExecuteRunDeps {
	/** Override the child execution primitive. Tests inject a mock. */
	runChild?: RunChildFn;
	/**
	 * Use this runId instead of generating a fresh UUID. Async-runner-main
	 * sets this so the persisted run.json/result.json ids match the
	 * bridge-returned asyncId.
	 */
	runId?: string;
}

function resolveSessionFile(spec: RunSpec, options: SyncRunOptions, index: number): string | undefined {
	return spec.sessionFiles?.[index] ?? options.forkSessionFileForIndex?.(index);
}

export async function executeRun(
	spec: RunSpec,
	callbacks: SyncRunCallbacks,
	options: SyncRunOptions = {},
	deps: ExecuteRunDeps = {},
): Promise<DelegatedRunResult> {
	const runChild: RunChildFn = deps.runChild ?? defaultRunChild;
	const runId = deps.runId ?? crypto.randomUUID();
	const topLevelRunId = currentTopLevelRunId() ?? runId;

	// Top-down depth enforcement at ingress.
	const depthCheck = checkSubagentDepth(spec.maxSubagentDepth);
	if (depthCheck.blocked) {
		return emitDepthBlockedRun(runId, topLevelRunId, spec, depthCheck, callbacks);
	}

	switch (spec.mode) {
		case "single":
			return runSingle(runId, topLevelRunId, spec, callbacks, options, runChild);
		case "parallel":
			return runParallel(runId, topLevelRunId, spec, callbacks, options, runChild);
		case "chain":
			return runChain(runId, topLevelRunId, spec, callbacks, options, runChild);
		default:
			throw new Error(`Unknown run mode: ${String(spec.mode)}`);
	}
}

// ============================================================================
// single
// ============================================================================

async function runSingle(
	runId: string,
	topLevelRunId: string,
	spec: RunSpec,
	callbacks: SyncRunCallbacks,
	options: SyncRunOptions,
	runChild: RunChildFn,
): Promise<DelegatedRunResult> {
	if (!spec.agent || !spec.task) {
		throw new Error("single mode requires both `agent` and `task`");
	}
	await emitRunStarted(runId, topLevelRunId, "single", spec.agent, callbacks);

	const sessionFile = resolveSessionFile(spec, options, 0);
	const childId = spec.childIds?.[0] ?? crypto.randomUUID();
	const result = await runChild(
		{
			runId,
			topLevelRunId,
			childId,
			parentChildId: currentParentChildId(),
			agent: spec.agent,
			task: spec.task,
			context: spec.context,
			sessionFile,
			parentSessionFile: spec.parentSessionFile,
			cwd: options.cwd,
			model: spec.model,
			depth: currentSubagentDepth(),
			maxSubagentDepth: spec.maxSubagentDepth ?? 2,
			env: spec.env,
		},
		toChildCallbacks(callbacks),
		options,
	);

	const runStatus = aggregateRunStatus([result]);
	const runResult: DelegatedRunResult = { runId, mode: "single", status: runStatus, results: [result] };
	await emitRunComplete(runId, topLevelRunId, runResult, callbacks);
	return runResult;
}

// ============================================================================
// parallel
// ============================================================================

async function runParallel(
	runId: string,
	topLevelRunId: string,
	spec: RunSpec,
	callbacks: SyncRunCallbacks,
	options: SyncRunOptions,
	runChild: RunChildFn,
): Promise<DelegatedRunResult> {
	const tasks = spec.tasks ?? [];
	if (tasks.length === 0) {
		throw new Error("parallel mode requires a non-empty `tasks` array");
	}
	const expanded = expandParallelTasks(tasks);
	if (expanded.length > MAX_PARALLEL) {
		throw new Error(`parallel mode limit: at most ${MAX_PARALLEL} total tasks (got ${expanded.length})`);
	}

	const aggregatedAgent = uniqueAgentLabel(expanded.map((t) => t.agent));
	await emitRunStarted(runId, topLevelRunId, "parallel", aggregatedAgent, callbacks);

	const parentChildId = currentParentChildId();
	const results = await mapConcurrent(expanded, MAX_CONCURRENCY, async (task, index) => {
		const sessionFile = resolveSessionFile(spec, options, index);
		const childId = spec.childIds?.[index] ?? crypto.randomUUID();
		return runChild(
			{
				runId,
				topLevelRunId,
				childId,
				parentChildId,
				agent: task.agent,
				task: task.task ?? spec.task ?? "",
				context: spec.context,
				sessionFile,
				parentSessionFile: spec.parentSessionFile,
				cwd: options.cwd,
				model: task.model ?? spec.model,
				taskIndex: index,
				depth: currentSubagentDepth(),
				maxSubagentDepth: spec.maxSubagentDepth ?? 2,
				env: spec.env,
			},
			toChildCallbacks(callbacks),
			options,
		);
	});

	const runStatus = aggregateRunStatus(results);
	const runResult: DelegatedRunResult = { runId, mode: "parallel", status: runStatus, results };
	await emitRunComplete(runId, topLevelRunId, runResult, callbacks);
	return runResult;
}

function expandParallelTasks(tasks: ParallelTaskSpec[]): ParallelTaskSpec[] {
	const out: ParallelTaskSpec[] = [];
	for (const t of tasks) {
		const count = typeof t.count === "number" && Number.isInteger(t.count) && t.count >= 1 ? t.count : 1;
		for (let i = 0; i < count; i++) out.push(t);
	}
	return out;
}

function uniqueAgentLabel(agents: string[]): string {
	const set = new Set(agents.filter((a) => a && a.length > 0));
	if (set.size === 0) return "parallel";
	if (set.size === 1) return agents[0] ?? "parallel";
	return Array.from(set).join(",");
}

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	const workers: Promise<void>[] = [];
	const workerCount = Math.min(Math.max(1, limit), items.length);
	for (let w = 0; w < workerCount; w++) {
		workers.push((async () => {
			while (true) {
				const index = cursor++;
				if (index >= items.length) return;
				out[index] = await fn(items[index] as T, index);
			}
		})());
	}
	await Promise.all(workers);
	return out;
}

// ============================================================================
// chain
// ============================================================================

async function runChain(
	runId: string,
	topLevelRunId: string,
	spec: RunSpec,
	callbacks: SyncRunCallbacks,
	options: SyncRunOptions,
	runChild: RunChildFn,
): Promise<DelegatedRunResult> {
	const chain = spec.chain ?? [];
	if (chain.length === 0) {
		throw new Error("chain mode requires a non-empty `chain` array");
	}

	const leadAgent = chain[0]?.agent ?? "chain";
	await emitRunStarted(runId, topLevelRunId, "chain", leadAgent, callbacks);

	const chainDir = chainRunDir(runId);
	fs.mkdirSync(chainDir, { recursive: true });

	const results: DelegatedChildResult[] = [];
	let previousText = "";
	const originalTask = spec.task ?? "";

	try {
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex] as ChainStep;

			if (step.parallel && step.parallel.length > 0) {
				const stepResults = await runChainParallelStep({
					runId,
					topLevelRunId,
					spec,
					step,
					stepIndex,
					callbacks,
					options,
					previousText,
					originalTask,
					chainDir,
					runChild,
				});
				results.push(...stepResults);
				previousText = stepResults.map((r) => r.finalText ?? "").filter(Boolean).join("\n\n");
				if (stepResults.some((r) => r.status !== "complete")) break;
			} else {
				const child = await runChainSingleStep({
					runId,
					topLevelRunId,
					spec,
					step,
					stepIndex,
					callbacks,
					options,
					previousText,
					originalTask,
					chainDir,
					runChild,
				});
				results.push(child);
				previousText = child.finalText ?? "";
				if (child.status !== "complete") break;
			}
		}
	} finally {
		// Clean up chain temporary directory to avoid /tmp accumulation.
		try {
			fs.rmSync(chainDir, { force: true, recursive: true });
		} catch {
			// best effort
		}
	}

	const runStatus = aggregateRunStatus(results);
	const runResult: DelegatedRunResult = { runId, mode: "chain", status: runStatus, results };
	await emitRunComplete(runId, topLevelRunId, runResult, callbacks);
	return runResult;
}

interface ChainStepContext {
	runId: string;
	topLevelRunId: string;
	spec: RunSpec;
	step: ChainStep;
	stepIndex: number;
	callbacks: SyncRunCallbacks;
	options: SyncRunOptions;
	previousText: string;
	originalTask: string;
	chainDir: string;
	runChild: RunChildFn;
}

async function runChainSingleStep(ctx: ChainStepContext): Promise<DelegatedChildResult> {
	const task = substitutePlaceholders(
		ctx.step.task ?? "",
		ctx.originalTask,
		ctx.previousText,
		ctx.chainDir,
	);
	const childId = ctx.spec.childIds?.[ctx.stepIndex] ?? crypto.randomUUID();
	return ctx.runChild(
		{
			runId: ctx.runId,
			topLevelRunId: ctx.topLevelRunId,
			childId,
			parentChildId: currentParentChildId(),
			agent: ctx.step.agent,
			task,
			context: ctx.spec.context,
			sessionFile: resolveSessionFile(ctx.spec, ctx.options, ctx.stepIndex),
			parentSessionFile: ctx.spec.parentSessionFile,
			cwd: ctx.options.cwd,
			model: ctx.step.model ?? ctx.spec.model,
			stepIndex: ctx.stepIndex,
			depth: currentSubagentDepth(),
			maxSubagentDepth: ctx.spec.maxSubagentDepth ?? 2,
			env: ctx.spec.env,
		},
		toChildCallbacks(ctx.callbacks),
		ctx.options,
	);
}

async function runChainParallelStep(ctx: ChainStepContext): Promise<DelegatedChildResult[]> {
	const expanded = expandParallelTasks(ctx.step.parallel ?? []);
	if (expanded.length > MAX_PARALLEL) {
		throw new Error(`chain step ${ctx.stepIndex}: parallel fan-out limit exceeded`);
	}
	const parentChildId = currentParentChildId();
	const stableChildIds = ctx.spec.chainParallelChildIds?.[String(ctx.stepIndex)] ?? [];
	return mapConcurrent(expanded, MAX_CONCURRENCY, async (task, i) => {
		const resolvedTask = substitutePlaceholders(
			task.task ?? "",
			ctx.originalTask,
			ctx.previousText,
			ctx.chainDir,
		);
		const childId = stableChildIds[i] ?? crypto.randomUUID();
		return ctx.runChild(
			{
				runId: ctx.runId,
				topLevelRunId: ctx.topLevelRunId,
				childId,
				parentChildId,
				agent: task.agent,
				task: resolvedTask,
				context: ctx.spec.context,
				sessionFile: undefined, // parallel within a chain step uses fresh sessions
				parentSessionFile: ctx.spec.parentSessionFile,
				cwd: ctx.options.cwd,
				model: task.model ?? ctx.step.model ?? ctx.spec.model,
				stepIndex: ctx.stepIndex,
				taskIndex: i,
				depth: currentSubagentDepth(),
				maxSubagentDepth: ctx.spec.maxSubagentDepth ?? 2,
				env: ctx.spec.env,
			},
			toChildCallbacks(ctx.callbacks),
			ctx.options,
		);
	});
}

function substitutePlaceholders(
	template: string,
	originalTask: string,
	previousText: string,
	chainDir: string,
): string {
	const escaped = new Map([
		["__PICODE_ESCAPED_TASK__", "{task}"],
		["__PICODE_ESCAPED_PREVIOUS__", "{previous}"],
		["__PICODE_ESCAPED_CHAIN_DIR__", "{chain_dir}"],
	]);
	let output = template
		.replace(/\\\{task\}/g, "__PICODE_ESCAPED_TASK__")
		.replace(/\\\{previous\}/g, "__PICODE_ESCAPED_PREVIOUS__")
		.replace(/\\\{chain_dir\}/g, "__PICODE_ESCAPED_CHAIN_DIR__")
		.replace(/\{task\}/g, originalTask)
		.replace(/\{previous\}/g, previousText)
		.replace(/\{chain_dir\}/g, chainDir);
	for (const [token, literal] of escaped) {
		output = output.replaceAll(token, literal);
	}
	return output;
}

// ============================================================================
// Shared helpers
// ============================================================================

function aggregateRunStatus(results: DelegatedChildResult[]): RunStatus {
	if (results.length === 0) return "failed";
	if (results.some((r) => r.status === "cancelled")) return "cancelled";
	if (results.some((r) => r.status === "failed")) return "failed";
	return "complete";
}

function toChildCallbacks(callbacks: SyncRunCallbacks): RunChildCallbacks {
	return {
		onEvent: callbacks.onEvent,
		signal: callbacks.signal,
	};
}

async function emitRunStarted(
	runId: string,
	topLevelRunId: string,
	mode: RunSpec["mode"],
	agent: string,
	callbacks: SyncRunCallbacks,
): Promise<void> {
	await callbacks.onEvent({
		type: EVENT_RUN_STARTED,
		runId,
		topLevelRunId,
		mode,
		agent,
		timestamp: Date.now(),
	});
}

async function emitRunComplete(
	runId: string,
	topLevelRunId: string,
	result: DelegatedRunResult,
	callbacks: SyncRunCallbacks,
): Promise<void> {
	await callbacks.onEvent({
		type: EVENT_RUN_COMPLETE,
		runId,
		topLevelRunId,
		result,
		timestamp: Date.now(),
	});
}

async function emitDepthBlockedRun(
	runId: string,
	topLevelRunId: string,
	spec: RunSpec,
	depthCheck: { depth: number; maxDepth: number },
	callbacks: SyncRunCallbacks,
): Promise<DelegatedRunResult> {
	const agent = spec.agent ?? spec.chain?.[0]?.agent ?? spec.tasks?.[0]?.agent ?? "unknown";
	await emitRunStarted(runId, topLevelRunId, spec.mode, agent, callbacks);
	const message = `subagent delegation blocked: depth ${depthCheck.depth} >= max ${depthCheck.maxDepth}`;
	const childResult: DelegatedChildResult = {
		childId: crypto.randomUUID(),
		agent,
		status: "failed",
		error: message,
	};
	const runResult: DelegatedRunResult = {
		runId,
		mode: spec.mode,
		status: "failed",
		results: [childResult],
	};
	await emitRunComplete(runId, topLevelRunId, runResult, callbacks);
	return runResult;
}

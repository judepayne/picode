import * as assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import { executeRun, type RunChildFn } from "../sync-executor.ts";
import {
	EVENT_RUN_COMPLETE,
	EVENT_RUN_STARTED,
	type ChildExecutionRequest,
	type DelegatedChildResult,
	type RunCompleteEvent,
	type RunStartedEvent,
} from "../types.ts";

interface Recorder {
	requests: ChildExecutionRequest[];
	events: (RunStartedEvent | RunCompleteEvent | { type: string })[];
}

function makeMock(overrides: Partial<Record<string, Partial<DelegatedChildResult>>> = {}): {
	runChild: RunChildFn;
	recorder: Recorder;
} {
	const recorder: Recorder = { requests: [], events: [] };
	const runChild: RunChildFn = async (req, callbacks) => {
		recorder.requests.push(req);
		callbacks.onEvent({
			type: "subagent:mode:child.started",
			runId: req.runId,
			topLevelRunId: req.topLevelRunId,
			childId: req.childId,
			parentChildId: req.parentChildId,
			agent: req.agent,
			timestamp: Date.now(),
			stepIndex: req.stepIndex,
			taskIndex: req.taskIndex,
			depth: req.depth,
		});
		const override = overrides[req.childId] ?? overrides[req.agent] ?? {};
		return {
			childId: req.childId,
			agent: req.agent,
			status: override.status ?? "complete",
			finalText: override.finalText ?? `result-${req.agent}-${req.taskIndex ?? req.stepIndex ?? 0}`,
			sessionFile: req.sessionFile,
			usage: { input: 10, output: 5, total: 15 },
			...override,
		};
	};
	return { runChild, recorder };
}

describe("executeRun: single mode", () => {
	test("returns one child result with run.started / run.complete bookends", async () => {
		const { runChild, recorder } = makeMock();
		const events: (RunStartedEvent | RunCompleteEvent | { type: string })[] = [];
		const result = await executeRun(
			{ mode: "single", context: "fresh", agent: "scout", task: "probe" },
			{ onEvent: (e) => events.push(e) },
			{},
			{ runChild },
		);

		assert.strictEqual(result.mode, "single");
		assert.strictEqual(result.status, "complete");
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(recorder.requests.length, 1);
		assert.strictEqual(recorder.requests[0]?.agent, "scout");
		assert.strictEqual(recorder.requests[0]?.task, "probe");

		assert.strictEqual(events[0]?.type, EVENT_RUN_STARTED);
		assert.strictEqual(events[events.length - 1]?.type, EVENT_RUN_COMPLETE);
	});

	test("uses orchestrator-supplied child ids when provided", async () => {
		const { runChild, recorder } = makeMock();
		await executeRun(
			{ mode: "single", context: "fresh", agent: "scout", task: "probe", childIds: ["child-session-1"] },
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(recorder.requests[0]?.childId, "child-session-1");
	});

	test("threads worker node-log identity into child execution requests", async () => {
		const { runChild, recorder } = makeMock();
		await executeRun(
			{
				mode: "single",
				context: "fresh",
				agent: "scout",
				task: "probe",
				childIds: ["child-session-1"],
				nodeLog: {
					nodeLogsDir: "/tmp/picode-node-logs",
					runId: "orchestrator-run-1",
					rootRunId: "root-run-1",
				},
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.deepStrictEqual(recorder.requests[0]?.nodeLog, {
			nodeLogsDir: "/tmp/picode-node-logs",
			runId: "orchestrator-run-1",
			rootRunId: "root-run-1",
			childSessionId: "child-session-1",
		});
	});

	test("uses precomputed child session files from the run spec", async () => {
		const { runChild, recorder } = makeMock();
		await executeRun(
			{
				mode: "single",
				context: "fork",
				agent: "scout",
				task: "probe",
				sessionFiles: ["/tmp/forked-session.jsonl"],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(recorder.requests[0]?.sessionFile, "/tmp/forked-session.jsonl");
	});

	test("rejects when agent or task is missing", async () => {
		const { runChild } = makeMock();
		await assert.rejects(
			executeRun(
				{ mode: "single", context: "fresh", task: "no agent" },
				{ onEvent: () => {} },
				{},
				{ runChild },
			),
			/requires both `agent` and `task`/,
		);
	});
});

describe("executeRun: parallel mode", () => {
	test("runs all tasks and aggregates their results", async () => {
		const { runChild, recorder } = makeMock();
		const result = await executeRun(
			{
				mode: "parallel",
				context: "fresh",
				tasks: [
					{ agent: "worker", task: "a" },
					{ agent: "worker", task: "b", count: 2 }, // expands to 2 children
				],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);

		assert.strictEqual(result.mode, "parallel");
		assert.strictEqual(result.results.length, 3);
		assert.strictEqual(recorder.requests.length, 3);
		// taskIndex distinguishes children.
		assert.deepStrictEqual(
			recorder.requests.map((r) => r.taskIndex).sort(),
			[0, 1, 2],
		);
	});

	test("status aggregates to failed if any child fails", async () => {
		const { runChild } = makeMock({
			"worker": { status: "failed", error: "boom", finalText: undefined },
		});
		const result = await executeRun(
			{
				mode: "parallel",
				context: "fresh",
				tasks: [{ agent: "worker", task: "a", count: 2 }],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(result.status, "failed");
	});

	test("enforces MAX_PARALLEL=8 ceiling", async () => {
		const { runChild } = makeMock();
		await assert.rejects(
			executeRun(
				{
					mode: "parallel",
					context: "fresh",
					tasks: [{ agent: "worker", task: "x", count: 9 }],
				},
				{ onEvent: () => {} },
				{},
				{ runChild },
			),
			/at most 8 total tasks/,
		);
	});

	test("enforces MAX_CONCURRENCY=4 in-flight cap", async () => {
		let active = 0;
		let peak = 0;
		const runChild: RunChildFn = async (req) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active -= 1;
			return {
				childId: req.childId,
				agent: req.agent,
				status: "complete",
				finalText: "ok",
			};
		};
		await executeRun(
			{
				mode: "parallel",
				context: "fresh",
				tasks: [{ agent: "worker", task: "x", count: 8 }],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.ok(peak <= 4, `peak in-flight ${peak} must be <= 4`);
	});
});

describe("executeRun: chain mode", () => {
	test("threads {previous} between steps", async () => {
		const capturedTasks: string[] = [];
		const runChild: RunChildFn = async (req) => {
			capturedTasks.push(req.task);
			return {
				childId: req.childId,
				agent: req.agent,
				status: "complete",
				finalText: `output-of-${req.agent}`,
			};
		};
		await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "ORIGINAL",
				chain: [
					{ agent: "step1", task: "first: {task}" },
					{ agent: "step2", task: "second sees: {previous}" },
					{ agent: "step3", task: "third sees: {previous}" },
				],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(capturedTasks[0], "first: ORIGINAL");
		assert.strictEqual(capturedTasks[1], "second sees: output-of-step1");
		assert.strictEqual(capturedTasks[2], "third sees: output-of-step2");
	});

	test("allows escaped chain placeholders", async () => {
		const capturedTasks: string[] = [];
		const runChild: RunChildFn = async (req) => {
			capturedTasks.push(req.task);
			return { childId: req.childId, agent: req.agent, status: "complete", finalText: "done" };
		};
		await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "ORIGINAL",
				chain: [{ agent: "step1", task: "literal \\{task}; real {task}; dir \\{chain_dir}; previous \\{previous}" }],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.match(capturedTasks[0] ?? "", /^literal \{task\}; real ORIGINAL; dir \{chain_dir\}; previous \{previous\}$/);
	});

	test("stops chain on first failed step", async () => {
		const { runChild } = makeMock({
			step2: { status: "failed", error: "halt" },
		});
		const result = await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "X",
				chain: [
					{ agent: "step1", task: "a" },
					{ agent: "step2", task: "b" },
					{ agent: "step3", task: "c" }, // should NOT run
				],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.status, "failed");
	});

	test("runs parallel fan-out within a chain step", async () => {
		const { runChild, recorder } = makeMock();
		const result = await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "X",
				chain: [
					{ agent: "scout", task: "scan" },
					{ agent: "coalesce", parallel: [{ agent: "worker", task: "{previous}", count: 3 }] },
				],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		// 1 scout + 3 workers
		assert.strictEqual(result.results.length, 4);
		assert.strictEqual(recorder.requests.filter((r) => r.agent === "worker").length, 3);
	});

	test("uses stable child ids for chain parallel fan-out when provided", async () => {
		const { runChild, recorder } = makeMock();
		await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "X",
				chain: [
					{ agent: "scout", task: "scan" },
					{ agent: "coalesce", parallel: [{ agent: "worker", task: "{previous}", count: 2 }] },
				],
				chainParallelChildIds: { "1": ["fanout-a", "fanout-b"] },
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.deepStrictEqual(
			recorder.requests.filter((r) => r.agent === "worker").map((r) => r.childId),
			["fanout-a", "fanout-b"],
		);
	});
});

describe("executeRun: nested identity propagation", () => {
	const ENV_TOP = "PI_SUBAGENT_TOP_RUN_ID";
	const ENV_PARENT = "PI_SUBAGENT_PARENT_CHILD_ID";
	const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {
			[ENV_TOP]: process.env[ENV_TOP],
			[ENV_PARENT]: process.env[ENV_PARENT],
			[ENV_DEPTH]: process.env[ENV_DEPTH],
		};
	});
	afterEach(() => {
		for (const k of [ENV_TOP, ENV_PARENT, ENV_DEPTH]) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test("top-level run: request.parentChildId is undefined; topLevelRunId === runId", async () => {
		delete process.env[ENV_TOP];
		delete process.env[ENV_PARENT];
		const { runChild, recorder } = makeMock();
		const result = await executeRun(
			{ mode: "single", context: "fresh", agent: "scout", task: "x" },
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		const req = recorder.requests[0];
		assert.ok(req, "expected one request");
		assert.strictEqual(req.parentChildId, undefined);
		assert.strictEqual(req.topLevelRunId, result.runId);
		assert.strictEqual(req.depth, 0);
	});

	test("nested run: topLevelRunId preserved; parentChildId = env parent", async () => {
		process.env[ENV_TOP] = "top-run-abc";
		process.env[ENV_PARENT] = "parent-child-xyz";
		process.env[ENV_DEPTH] = "1";
		const { runChild, recorder } = makeMock();
		await executeRun(
			{ mode: "single", context: "fresh", agent: "scout", task: "y" },
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		const req = recorder.requests[0];
		assert.ok(req);
		assert.strictEqual(req.topLevelRunId, "top-run-abc");
		assert.strictEqual(req.parentChildId, "parent-child-xyz");
		assert.strictEqual(req.depth, 1);
	});

	test("parallel nested: all children share the same parentChildId", async () => {
		process.env[ENV_TOP] = "top-run-p";
		process.env[ENV_PARENT] = "parent-p";
		process.env[ENV_DEPTH] = "1";
		const { runChild, recorder } = makeMock();
		await executeRun(
			{
				mode: "parallel",
				context: "fresh",
				tasks: [{ agent: "w", task: "t", count: 3 }],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(recorder.requests.length, 3);
		for (const req of recorder.requests) {
			assert.strictEqual(req.parentChildId, "parent-p");
			assert.strictEqual(req.topLevelRunId, "top-run-p");
		}
	});

	test("chain nested: every step inherits parentChildId from env", async () => {
		process.env[ENV_TOP] = "top-run-c";
		process.env[ENV_PARENT] = "parent-c";
		process.env[ENV_DEPTH] = "1";
		const { runChild, recorder } = makeMock();
		await executeRun(
			{
				mode: "chain",
				context: "fresh",
				task: "T",
				chain: [
					{ agent: "step1", task: "a" },
					{ agent: "step2", task: "b" },
				],
			},
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(recorder.requests.length, 2);
		for (const req of recorder.requests) {
			assert.strictEqual(req.parentChildId, "parent-c");
			assert.strictEqual(req.topLevelRunId, "top-run-c");
		}
	});
});

describe("executeRun: depth enforcement", () => {
	const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
	const ENV_MAX = "PI_SUBAGENT_MAX_DEPTH";
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = { [ENV_DEPTH]: process.env[ENV_DEPTH], [ENV_MAX]: process.env[ENV_MAX] };
	});
	afterEach(() => {
		for (const k of [ENV_DEPTH, ENV_MAX]) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test("blocks at the ceiling without invoking any child", async () => {
		process.env[ENV_DEPTH] = "2";
		process.env[ENV_MAX] = "2";
		const { runChild, recorder } = makeMock();
		const result = await executeRun(
			{ mode: "single", context: "fresh", agent: "scout", task: "probe" },
			{ onEvent: () => {} },
			{},
			{ runChild },
		);
		assert.strictEqual(result.status, "failed");
		assert.strictEqual(recorder.requests.length, 0);
		assert.match(result.results[0]?.error ?? "", /depth 2 >= max 2/);
	});
});

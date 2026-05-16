/**
 * End-to-end runner integration test.
 *
 * Spawns a real `pi --mode json -p` child and verifies the full pipeline:
 *   spawn → stdio parsing → normalizer → result aggregation → event emission.
 *
 * Skipped automatically if the `pi` binary is not on PATH (so CI without
 * pi installed does not fail). Takes ~5-15 seconds against gpt-5.4 defaults.
 */

import * as assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { runChild } from "../../runner.ts";
import {
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_SUBAGENT_EXPANDED_TASK,
	type ChildEvent,
} from "../../types.ts";

function piInstalled(): boolean {
	try {
		execSync("which pi", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("runner: end-to-end against real pi child", { skip: !piInstalled() }, () => {
	test("emits child.started → text.final → child.complete without default text deltas", async () => {
		const events: ChildEvent[] = [];
		const nodeLogsDir = mkdtempSync(join(tmpdir(), "picode-runner-node-logs-"));
		try {
			const result = await runChild(
				{
					runId: "e2e-run",
					topLevelRunId: "e2e-run",
					childId: "e2e-child",
					agent: "scout",
					task: "Say exactly 'Hello world' and nothing else.",
					context: "fresh",
					depth: 0,
					maxSubagentDepth: 2,
					nodeLog: {
						nodeLogsDir,
						runId: "orchestrator-run",
						rootRunId: "root-run",
						childSessionId: "e2e-child",
					},
				},
				{
					onEvent: (event) => events.push(event),
				},
				{
					extensions: [], // --no-extensions to skip discovery (faster, deterministic)
					disableSkills: true,
				},
			);

			const types = events.map((e) => e.type);
			assert.ok(types.includes(EVENT_CHILD_STARTED), "expected child.started");
			assert.strictEqual(
				types.filter((t) => t === EVENT_CHILD_TEXT_DELTA).length,
				0,
				"expected child.text.delta to stay in the worker data plane by default",
			);
			assert.ok(types.includes(EVENT_CHILD_TEXT_FINAL), "expected child.text.final");
			assert.ok(types.includes(EVENT_CHILD_COMPLETE), "expected child.complete");

			// child.started must be first; child.complete must be last.
			assert.strictEqual(events[0]?.type, EVENT_CHILD_STARTED);
			assert.strictEqual(events[events.length - 1]?.type, EVENT_CHILD_COMPLETE);

			// Result shape
			assert.strictEqual(result.status, "complete");
			assert.strictEqual(result.agent, "scout");
			assert.strictEqual(result.childId, "e2e-child");
			assert.ok(result.finalText, "expected a final text on the child result");
			assert.ok(result.usage, "expected usage totals to be populated");
			assert.ok((result.usage?.input ?? 0) > 0);
			assert.ok((result.usage?.output ?? 0) > 0);

			const nodeLogLines = readFileSync(join(nodeLogsDir, "e2e-child.jsonl"), "utf8").trim().split("\n");
			const nodeLogRecords = nodeLogLines.map((line) => JSON.parse(line) as { runId: string; rootRunId?: string; eventType: string; event: { task?: string; taskCharCount?: number } });
			assert.equal(nodeLogRecords[0]?.eventType, EVENT_SUBAGENT_EXPANDED_TASK, "expected expanded task audit record first");
			assert.equal(nodeLogRecords[0]?.event.task, "Say exactly 'Hello world' and nothing else.");
			assert.equal(nodeLogRecords[0]?.event.taskCharCount, "Say exactly 'Hello world' and nothing else.".length);
			assert.ok(nodeLogRecords.some((record) => record.eventType === EVENT_CHILD_TEXT_DELTA), "expected text deltas in worker-owned node log");
			assert.ok(nodeLogRecords.some((record) => record.eventType === EVENT_CHILD_COMPLETE), "expected child.complete in worker-owned node log");
			assert.equal(nodeLogRecords[0]?.runId, "orchestrator-run");
			assert.equal(nodeLogRecords[0]?.rootRunId, "root-run");
		} finally {
			rmSync(nodeLogsDir, { recursive: true, force: true });
		}
	});

	test("AbortSignal triggers cancellation with SIGTERM", async (t) => {
		// Expected wall-clock: ~1s to spawn + 0.1s to abort + up to 3s SIGKILL
		// grace. Give it a generous buffer.
		t.diagnostic("cancellation test can take up to ~5s");

		const controller = new AbortController();
		const events: ChildEvent[] = [];

		// Abort shortly after spawn so the child is mid-stream.
		setTimeout(() => controller.abort(), 200);

		const result = await runChild(
			{
				runId: "cancel-run",
				topLevelRunId: "cancel-run",
				childId: "cancel-child",
				agent: "scout",
				task: "Count slowly from one to one hundred, listing each number on its own line.",
				context: "fresh",
				depth: 0,
				maxSubagentDepth: 2,
			},
			{
				onEvent: (event) => events.push(event),
				signal: controller.signal,
			},
			{
				extensions: [],
				disableSkills: true,
			},
		);

		assert.strictEqual(result.status, "cancelled");
		const types = events.map((e) => e.type);
		assert.ok(types.includes(EVENT_CHILD_STARTED));
		assert.ok(types.includes(EVENT_CHILD_COMPLETE));
	});
});

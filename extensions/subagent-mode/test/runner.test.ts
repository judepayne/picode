import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveDefaultChildExtensionPaths, toRunnerWorkerOptions } from "../runner.ts";
import { isControlPlaneChildEvent } from "../runner-worker-protocol.ts";
import {
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	type ChildEvent,
} from "../types.ts";

describe("runner child extension defaults", () => {
	test("uses an explicit child extension set that excludes agent-mode", () => {
		const paths = resolveDefaultChildExtensionPaths();
		assert.ok(paths.some((entry) => entry.includes("extensions/agent-assets")));
		assert.ok(paths.some((entry) => entry.includes("extensions/pi-gate")));
		assert.ok(paths.some((entry) => entry.includes("extensions/subagent-mode")));
		assert.ok(paths.some((entry) => entry.includes("extensions/subagent-orchestrator")));
		assert.ok(paths.some((entry) => entry.includes("extensions/z-prompt-vars")));
		assert.equal(paths.some((entry) => entry.includes("extensions/agent-mode")), false);
	});
});

describe("runner worker option serialization", () => {
	test("drops non-cloneable executor-only fields before posting to the worker", () => {
		const options = toRunnerWorkerOptions({
			cwd: "/tmp/example",
			thinking: "medium",
			emitDataPlaneEvents: true,
			forkSessionFileForIndex: () => "session.json",
		} as never);

		assert.deepEqual(options, {
			cwd: "/tmp/example",
			thinking: "medium",
			emitDataPlaneEvents: true,
		});
	});
});

describe("runner worker event filtering", () => {
	const base = {
		runId: "run-1",
		topLevelRunId: "run-1",
		childId: "child-1",
		agent: "scout",
		timestamp: 1,
		depth: 0,
	};

	test("keeps transcript-grade events out of the control plane", () => {
		const dataPlaneEvents: ChildEvent[] = [
			{ type: EVENT_CHILD_TEXT_DELTA, ...base, delta: "hello" },
			{ type: EVENT_CHILD_THINKING_START, ...base },
			{ type: EVENT_CHILD_THINKING_END, ...base, summary: "done" },
		];
		for (const event of dataPlaneEvents) assert.equal(isControlPlaneChildEvent(event), false);
	});

	test("allows lifecycle and final-text events through the control plane", () => {
		const controlEvents: ChildEvent[] = [
			{ type: EVENT_CHILD_STARTED, ...base },
			{ type: EVENT_CHILD_TEXT_FINAL, ...base, text: "hello" },
			{
				type: EVENT_CHILD_COMPLETE,
				...base,
				result: { childId: "child-1", agent: "scout", status: "complete", finalText: "hello" },
			},
		];
		for (const event of controlEvents) assert.equal(isControlPlaneChildEvent(event), true);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildSessionRecords } from "../session-model.ts";

describe("session model", () => {
	it("creates one child per single, parallel task, and chain step", () => {
		const single = buildChildSessionRecords({
			runId: "run-single",
			rootRunId: "root-1",
			parentChildSessionId: "parent-child-1",
			ownerModeId: "designer",
			parentSessionId: "session-1",
			agent: "scout",
			request: { shape: "single", async: false, context: "fresh", task: "Inspect" },
			now: 1,
		});
		assert.equal(single[0]?.rootRunId, "root-1");
		assert.equal(single[0]?.parentChildSessionId, "parent-child-1");
		assert.equal(single.length, 1);
		assert.equal(single[0]?.childKey, "single:0");

		const parallel = buildChildSessionRecords({
			runId: "run-parallel",
			rootRunId: "run-parallel",
			ownerModeId: "designer",
			parentSessionId: "session-1",
			agent: "scout",
			request: { shape: "parallel", async: true, context: "fresh", tasks: [{ task: "A" }, { task: "B" }] },
			now: 1,
		});
		assert.deepEqual(parallel.map((entry) => entry.childKey), ["parallel:0", "parallel:1"]);
		assert.deepEqual(parallel.map((entry) => entry.taskIndex), [0, 1]);

		const chain = buildChildSessionRecords({
			runId: "run-chain",
			rootRunId: "run-chain",
			ownerModeId: "designer",
			parentSessionId: "session-1",
			agent: "scout",
			request: { shape: "chain", async: true, context: "fork", chain: [{ task: "Plan" }, { task: "Build" }] },
			now: 1,
		});
		assert.deepEqual(chain.map((entry) => entry.childKey), ["chain:0", "chain:1"]);
		assert.deepEqual(chain.map((entry) => entry.stepIndex), [0, 1]);
	});
});

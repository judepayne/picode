import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildChildEnv, buildChildPiArgs } from "../pi-spawn.ts";

describe("buildChildPiArgs", () => {
	test("keeps extension-like tool paths when explicit extensions are provided", () => {
		const gatePath = "/tmp/pi-gate";
		const helperPath = "/tmp/helper-ext";
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: ["bash", gatePath],
			extensions: [helperPath],
		});

		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--tools"));
		assert.ok(args.includes("bash"));

		const extensionValues: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			if (args[index] === "--extension") {
				extensionValues.push(args[index + 1] ?? "");
			}
		}

		assert.deepEqual(extensionValues, [helperPath, gatePath]);
	});

	test("deduplicates extension paths gathered from tools and explicit extensions", () => {
		const gatePath = "/tmp/pi-gate";
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: [gatePath],
			extensions: [gatePath],
		});

		const extensionValues: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			if (args[index] === "--extension") {
				extensionValues.push(args[index + 1] ?? "");
			}
		}

		assert.deepEqual(extensionValues, [gatePath]);
	});

	test("passes --no-tools when the resolved tool list is empty", () => {
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: [],
		});

		assert.ok(args.includes("--no-tools"));
	});
});

describe("buildChildEnv", () => {
	const savedGateProfile = process.env.GATE_PROFILE;
	const savedLineage = process.env.PI_GATE_PROFILE_LINEAGE;

	function restoreEnv(): void {
		if (savedGateProfile === undefined) delete process.env.GATE_PROFILE;
		else process.env.GATE_PROFILE = savedGateProfile;
		if (savedLineage === undefined) delete process.env.PI_GATE_PROFILE_LINEAGE;
		else process.env.PI_GATE_PROFILE_LINEAGE = savedLineage;
	}

	test("derives first child gate lineage from the parent profile", () => {
		process.env.GATE_PROFILE = "planner";
		delete process.env.PI_GATE_PROFILE_LINEAGE;
		const env = buildChildEnv({ agent: "scout", maxDepth: 2, topLevelRunId: "run", parentChildId: "child" });
		assert.equal(env.PI_GATE_PROFILE_LINEAGE, "planner,scout");
		restoreEnv();
	});

	test("appends nested child profile to the inherited gate lineage", () => {
		process.env.GATE_PROFILE = "scout";
		process.env.PI_GATE_PROFILE_LINEAGE = "planner,scout";
		const env = buildChildEnv({ agent: "worker", maxDepth: 2, topLevelRunId: "run", parentChildId: "child" });
		assert.equal(env.PI_GATE_PROFILE_LINEAGE, "planner,scout,worker");
		restoreEnv();
	});

	test("adds the parent profile when inherited lineage omits it", () => {
		process.env.GATE_PROFILE = "planner";
		process.env.PI_GATE_PROFILE_LINEAGE = "scout";
		const env = buildChildEnv({ agent: "worker", maxDepth: 2, topLevelRunId: "run", parentChildId: "child" });
		assert.equal(env.PI_GATE_PROFILE_LINEAGE, "scout,planner,worker");
		restoreEnv();
	});

	test("reserved runtime env values cannot be overridden by extra env", () => {
		process.env.GATE_PROFILE = "planner";
		delete process.env.PI_GATE_PROFILE_LINEAGE;
		const env = buildChildEnv({
			agent: "scout",
			maxDepth: 2,
			topLevelRunId: "run",
			parentChildId: "child",
			extra: {
				GATE_PROFILE: "worker",
				GATE_PROFILE_LOCK: "0",
				PI_GATE_PROFILE_LINEAGE: "worker",
				PI_SUBAGENT_DEPTH: "99",
				MCP_DIRECT_TOOLS: "1",
			},
		});
		assert.equal(env.GATE_PROFILE, "scout");
		assert.equal(env.GATE_PROFILE_LOCK, "1");
		assert.equal(env.PI_GATE_PROFILE_LINEAGE, "planner,scout");
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.MCP_DIRECT_TOOLS, "1");
		restoreEnv();
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentCommandCompletions, isReadOnlyBashCommand } from "../index.ts";
import { isDelegatedSubagentChildProcess } from "../runtime.ts";

describe("agent-mode runtime", () => {
	it("detects delegated subagent child processes from the top-run env", () => {
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "run-123" }), true);
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "  " }), false);
		assert.equal(isDelegatedSubagentChildProcess({}), false);
	});

	it("treats find as read-only and awk as non-read-only", () => {
		assert.equal(isReadOnlyBashCommand("find . -name '*.ts'"), true);
		assert.equal(isReadOnlyBashCommand("awk '{ print $1 }' file.txt"), false);
	});

	it("offers next/prev and agent-name completions for /agents", () => {
		const completions = buildAgentCommandCompletions("p", [
			{
				id: "planner",
				name: "Planner",
				profile: "planner",
				toolSelection: { toolsMode: "omitted" },
				bashPolicy: "read-only",
				instructions: "Plan things.",
			},
			{
				id: "builder",
				name: "Builder",
				profile: "builder",
				toolSelection: { toolsMode: "omitted" },
				bashPolicy: "full",
				instructions: "Build things.",
			},
		]);
		assert.deepEqual(completions, [
			{ value: "prev", label: "prev — switch to the previous configured agent" },
			{ value: "Planner", label: "Planner" },
		]);
	});
});

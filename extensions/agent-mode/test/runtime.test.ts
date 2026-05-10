import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentCommandCompletions, isReadOnlyBashCommand, modeFromAgentCard } from "../index.ts";
import { isDelegatedSubagentChildProcess } from "../runtime.ts";

describe("agent-mode runtime", () => {
	it("detects delegated subagent child processes from the top-run env", () => {
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "run-123" }), true);
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "  " }), false);
		assert.equal(isDelegatedSubagentChildProcess({}), false);
	});

	it("treats find and read-only dd as read-only, but mutating commands as non-read-only", () => {
		assert.equal(isReadOnlyBashCommand("find . -name '*.ts'"), true);
		assert.equal(isReadOnlyBashCommand("dd if=input.bin bs=1 count=10"), true);
		assert.equal(isReadOnlyBashCommand("dd if=input.bin of=output.bin bs=1 count=10"), false);
		assert.equal(isReadOnlyBashCommand("dd if=input.bin o'f'=output.bin bs=1 count=10"), false);
		assert.equal(isReadOnlyBashCommand("awk '{ print $1 }' file.txt"), false);
	});

	it("maps agent asset cards to mode definitions", () => {
		const mode = modeFromAgentCard({
			name: "Builder",
			description: "Build things.",
			profile: "builder",
			color: "#ff0000",
			tools: "all",
			ban_tools: "vars",
			subagents: "scout, worker",
			bash: "read-only",
			thinking: "-",
			model: "-",
			prompt: "Build prompt.",
		});
		assert.deepEqual(mode, {
			id: "builder",
			name: "Builder",
			description: "Build things.",
			profile: "builder",
			color: "#ff0000",
			toolSelection: { toolsMode: "all", banTools: ["vars"] },
			subagents: ["scout", "worker"],
			bashPolicy: "read-only",
			thinkingLevel: undefined,
			model: undefined,
			instructions: "Build prompt.",
		});
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

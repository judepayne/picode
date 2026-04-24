import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseToolSelection, resolveToolSelection } from "../tool-selection.ts";

describe("tool selection", () => {
	test("parses omitted tools, all, explicit lists, and ban_tools", () => {
		assert.deepEqual(parseToolSelection({}), { toolsMode: "omitted" });
		assert.deepEqual(parseToolSelection({ tools: "all" }), { toolsMode: "all" });
		assert.deepEqual(parseToolSelection({ tools: "[all]" }), { toolsMode: "all" });
		assert.deepEqual(parseToolSelection({ tools: "read, grep", banTools: "bash, grep" }), {
			toolsMode: "list",
			tools: ["read", "grep"],
			banTools: ["bash", "grep"],
		});
	});

	test("resolves omitted tools to all when requested by context", () => {
		const result = resolveToolSelection(parseToolSelection({}), {
			defaultMode: "all",
			availableTools: ["read", "bash", "todo"],
		});
		assert.deepEqual(result, {
			tools: ["read", "bash", "todo"],
			unknownRequestedTools: [],
			unknownBannedTools: [],
		});
	});

	test("resolves omitted tools to inherited tools when requested by context", () => {
		const result = resolveToolSelection(parseToolSelection({}), {
			defaultMode: "inherit",
			availableTools: ["read", "bash", "delegate_subagent"],
			inheritedTools: ["bash", "todo", "read"],
		});
		assert.deepEqual(result, {
			tools: ["bash", "read"],
			unknownRequestedTools: [],
			unknownBannedTools: [],
		});
	});

	test("applies ban_tools after selecting the base tool set", () => {
		const result = resolveToolSelection(parseToolSelection({ tools: "all", banTools: "todo, bash" }), {
			defaultMode: "all",
			availableTools: ["read", "bash", "todo"],
		});
		assert.deepEqual(result, {
			tools: ["read"],
			unknownRequestedTools: [],
			unknownBannedTools: [],
		});
	});

	test("reports unknown requested and banned tools while remaining permissive", () => {
		const result = resolveToolSelection(parseToolSelection({ tools: "read, todo, bash", banTools: "vars, grep" }), {
			defaultMode: "all",
			availableTools: ["read", "bash"],
		});
		assert.deepEqual(result, {
			tools: ["read", "bash"],
			unknownRequestedTools: ["todo"],
			unknownBannedTools: ["vars", "grep"],
		});
	});
});

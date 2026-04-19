import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveDefaultChildExtensionPaths } from "../runner.ts";

describe("runner child extension defaults", () => {
	test("uses an explicit child extension set that excludes agent-mode", () => {
		const paths = resolveDefaultChildExtensionPaths();
		assert.ok(paths.some((entry) => entry.includes("extensions/pi-gate")));
		assert.ok(paths.some((entry) => entry.includes("extensions/subagent-mode")));
		assert.ok(paths.some((entry) => entry.includes("extensions/subagent-orchestrator")));
		assert.ok(paths.some((entry) => entry.includes("extensions/z-prompt-vars")));
		assert.equal(paths.some((entry) => entry.includes("extensions/agent-mode")), false);
	});
});

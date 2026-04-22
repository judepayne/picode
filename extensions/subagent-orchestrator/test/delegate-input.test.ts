import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeDelegateInput } from "../delegate-input.ts";

describe("delegate_subagent input normalization", () => {
	it("rejects continue for agent-facing delegation", () => {
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", context: "continue" }),
			{ error: 'context "continue" is only supported for direct user `~subagent` dispatch. Use "fresh" or "fork" here.' },
		);
	});

	it("accepts fresh and fork contexts", () => {
		assert.equal(normalizeDelegateInput({ task: "inspect the repo", context: "fresh" }).request?.context, "fresh");
		assert.equal(normalizeDelegateInput({ task: "inspect the repo", context: "fork" }).request?.context, "fork");
	});
});

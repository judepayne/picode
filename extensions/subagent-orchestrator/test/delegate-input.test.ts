import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeDelegateInput } from "../delegate-input.ts";

describe("delegate_subagent input normalization", () => {
	it("accepts continue when a childSessionId is provided", () => {
		const normalized = normalizeDelegateInput({
			agent: "worker",
			task: "continue the workflow",
			context: "continue",
			childSessionId: "child-123",
		});
		assert.equal(normalized.request?.context, "continue");
		assert.equal(normalized.request?.childSessionId, "child-123");
	});

	it("requires childSessionId for continue", () => {
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", context: "continue" }),
			{ error: 'childSessionId is required when context is "continue".' },
		);
	});

	it("restricts continue to single-task delegation", () => {
		assert.deepEqual(
			normalizeDelegateInput({ tasks: [{ task: "a" }], context: "continue", childSessionId: "child-123" }),
			{ error: 'context "continue" currently supports only single-task delegation via `task`.' },
		);
	});

	it("rejects childSessionId outside continue", () => {
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", context: "fresh", childSessionId: "child-123" }),
			{ error: 'childSessionId is only supported when context is "continue".' },
		);
	});

	it("accepts fresh and fork contexts", () => {
		assert.equal(normalizeDelegateInput({ task: "inspect the repo", context: "fresh" }).request?.context, "fresh");
		assert.equal(normalizeDelegateInput({ task: "inspect the repo", context: "fork" }).request?.context, "fork");
	});
});

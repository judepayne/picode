import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeDelegateInput } from "../delegate-input.ts";
import { MAX_SYNC_TIMEOUT_SECONDS } from "../timeout.ts";

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

	it("accepts a positive integer timeoutSeconds", () => {
		assert.equal(normalizeDelegateInput({ task: "inspect the repo", timeoutSeconds: 300 }).request?.timeoutSeconds, 300);
	});

	it("rejects a non-positive, non-integer, or too-large timeoutSeconds", () => {
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", timeoutSeconds: 0 }),
			{ error: `timeoutSeconds must be a positive integer no greater than ${MAX_SYNC_TIMEOUT_SECONDS}.` },
		);
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", timeoutSeconds: 1.5 }),
			{ error: `timeoutSeconds must be a positive integer no greater than ${MAX_SYNC_TIMEOUT_SECONDS}.` },
		);
		assert.deepEqual(
			normalizeDelegateInput({ task: "inspect the repo", timeoutSeconds: MAX_SYNC_TIMEOUT_SECONDS + 1 }),
			{ error: `timeoutSeconds must be a positive integer no greater than ${MAX_SYNC_TIMEOUT_SECONDS}.` },
		);
	});
});

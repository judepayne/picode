import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatContinuationTitle } from "../session-entries.ts";

describe("session entries", () => {
	it("formats a singular continuation title", () => {
		assert.equal(formatContinuationTitle(1), "Background scout completed");
	});

	it("formats a plural continuation title", () => {
		assert.equal(formatContinuationTitle(2), "Background scouts completed");
	});

	it("formats a user-facing continuation title", () => {
		assert.equal(formatContinuationTitle(1, "user", "scout"), "From scout");
	});
});

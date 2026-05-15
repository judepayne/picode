import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBackgroundFailureNotification, formatUserLaunchNotification } from "../footer-status.ts";

describe("notifications", () => {
	it("formats user launch notifications in title case", () => {
		assert.equal(formatUserLaunchNotification("scout"), "Scout running in background");
		assert.equal(formatUserLaunchNotification("worker"), "Worker running in background");
	});

	it("formats background failure notifications with the agent type", () => {
		assert.equal(
			formatBackgroundFailureNotification("worker", "parser test failed"),
			"Background worker failed: parser test failed",
		);
	});
});

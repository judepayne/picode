import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBackgroundFailureNotification, formatFooterStatus, formatUserLaunchNotification, summarizeFailedAgents } from "../footer-status.ts";

describe("footer status", () => {
	it("returns undefined when no activity exists", () => {
		assert.equal(formatFooterStatus({ activeRuns: 0, activeChildren: 0, queuedHandbacks: 0 }), undefined);
	});

	it("formats healthy aggregate status", () => {
		assert.equal(
			formatFooterStatus({ activeRuns: 2, activeChildren: 3, queuedHandbacks: 1 }),
			"subagents:2 runs · 3 active · 1 waiting",
		);
	});

	it("formats a single failed scout with emphasis hook", () => {
		assert.equal(
			formatFooterStatus({
				activeRuns: 1,
				activeChildren: 0,
				queuedHandbacks: 0,
				failedAgents: [{ agent: "scout", count: 1 }],
			}, (text) => `**${text}**`),
			"subagents: **failed** scout",
		);
	});

	it("keeps active and waiting state visible alongside failures", () => {
		assert.equal(
			formatFooterStatus({
				activeRuns: 1,
				activeChildren: 1,
				queuedHandbacks: 1,
				failedAgents: [{ agent: "generalist", count: 1 }],
			}),
			"subagents: failed generalist · 1 active · 1 waiting",
		);
	});

	it("formats multiple failed groups by descending count", () => {
		assert.equal(
			summarizeFailedAgents([
				{ agent: "generalist", count: 1 },
				{ agent: "scout", count: 2 },
			]),
			"2 scouts, 1 generalist",
		);
		assert.equal(
			formatFooterStatus({
				activeRuns: 0,
				activeChildren: 0,
				queuedHandbacks: 0,
				failedAgents: [
					{ agent: "generalist", count: 1 },
					{ agent: "scout", count: 2 },
				],
			}),
			"subagents: failed 2 scouts, 1 generalist",
		);
	});
});

describe("notifications", () => {
	it("formats user launch notifications in title case", () => {
		assert.equal(formatUserLaunchNotification("scout"), "Scout running in background");
		assert.equal(formatUserLaunchNotification("generalist"), "Generalist running in background");
	});

	it("formats background failure notifications with the agent type", () => {
		assert.equal(
			formatBackgroundFailureNotification("generalist", "parser test failed"),
			"Background generalist failed: parser test failed",
		);
	});
});

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatRunCardLines, shortenDisplayPath } from "../run-ui.ts";
import type { OrchestratorRunMessageDetails } from "../types.ts";

const HOME_DIR = os.homedir();

function baseDetails(status: OrchestratorRunMessageDetails["status"]): OrchestratorRunMessageDetails {
	return {
		runId: "run-1",
		ownerModeId: "designer",
		parentSessionId: "session-1",
		requestShape: "parallel",
		async: true,
		context: "fresh",
		status,
		taskSummary: "Inspect two files",
		updatedAt: 1,
		childSessionCount: 2,
		activeChildCount: status === "running" ? 2 : 0,
		queuedHandbackCount: status === "complete" ? 1 : 0,
		consumedHandbackCount: status === "complete" ? 1 : 0,
		selectedChildIndex: 1,
		resultSummary: status === "complete" ? "scout:\nscout" : undefined,
		children: [
			{
				childSessionId: "child-0",
				childIndex: 0,
				status,
				taskSummary: "Inspect first file",
				sessionFile: path.join(HOME_DIR, ".pi/agent/sessions/example/first.jsonl"),
				asyncDir: "/var/folders/example/async-run",
				resultSummary: status === "complete" ? "first" : undefined,
			},
			{
				childSessionId: "child-1",
				childIndex: 1,
				status,
				taskSummary: "Inspect second file",
				currentTool: status === "running" ? "read" : undefined,
				toolCount: status === "running" ? 1 : undefined,
				sessionFile: path.join(HOME_DIR, ".pi/agent/sessions/example/second.jsonl"),
				asyncDir: "/var/folders/example/async-run",
				recentOutput: status === "running" ? ["line one", "line two"] : undefined,
				resultSummary: status === "complete" ? "scout" : undefined,
			},
		],
	};
}

describe("run ui", () => {
	it("formats running cards around the selected child with recent output", () => {
		const lines = formatRunCardLines(baseDetails("running"));
		assert.deepEqual(lines.slice(0, 5), [
			"Delegated run run-1",
			"running · parallel · async · context=fresh",
			"Task: Inspect two files",
			"Children: 2 active",
			"",
		]);
		assert.ok(lines.includes("Selected child [1]: Inspect second file"));
		assert.ok(lines.some((line) => line.startsWith("Focus: 2/2 · cycle with delegate_subagent_status")));
		assert.ok(lines.includes("Tool: read (1)"));
		assert.ok(lines.includes("Session: ~/…/second.jsonl"));
		assert.ok(lines.includes("Log: /var/…/output-1.log"));
		assert.ok(lines.includes("Recent output:"));
		assert.ok(lines.includes("  line two"));
	});

	it("formats complete cards with queue state and summary", () => {
		const lines = formatRunCardLines(baseDetails("complete"));
		assert.ok(lines.includes("Children: 2 complete"));
		assert.ok(lines.includes("Handback queue: 1 waiting"));
		assert.ok(lines.includes("Selected child [1] · complete: Inspect second file"));
		assert.ok(lines.includes("Summary: scout"));
	});

	it("shortens long display paths", () => {
		assert.equal(
			shortenDisplayPath(path.join(HOME_DIR, ".pi/agent/sessions/example/child.jsonl"), 20),
			"~/…/child.jsonl",
		);
		assert.equal(
			shortenDisplayPath("/var/folders/example/async-run/output-0.log", 24),
			"/var/…/output-0.log",
		);
	});
});

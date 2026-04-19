import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearRunMessageSnapshots, getRenderableRunSnapshot, ORCHESTRATOR_RUN_MESSAGE_TYPE, rememberRunMessageDetails, restoreRunMessageSnapshots } from "../run-live-state.ts";
import type { OrchestratorRunMessageDetails } from "../types.ts";

function details(updatedAt: number, status: OrchestratorRunMessageDetails["status"] = "running"): OrchestratorRunMessageDetails {
	return {
		runId: "run-1",
		ownerModeId: "designer",
		parentSessionId: "session-1",
		requestShape: "single",
		async: true,
		context: "fresh",
		status,
		taskSummary: "Inspect file",
		updatedAt,
		childSessionCount: 1,
		activeChildCount: status === "running" ? 1 : 0,
		queuedHandbackCount: 0,
		consumedHandbackCount: status === "complete" ? 1 : 0,
		children: [{
			childSessionId: "child-1",
			childIndex: 0,
			status,
			taskSummary: "Inspect file",
		}]
	};
}

describe("run live state", () => {
	it("returns the most recently remembered snapshot", () => {
		clearRunMessageSnapshots();
		rememberRunMessageDetails(details(1, "running"));
		const snapshot = getRenderableRunSnapshot(rememberRunMessageDetails(details(2, "complete")));
		assert.equal(snapshot.details.status, "complete");
		assert.equal(snapshot.details.updatedAt, 2);
	});

	it("restores the latest run snapshot from session messages", () => {
		clearRunMessageSnapshots();
		restoreRunMessageSnapshots([
			{
				type: "message",
				message: {
					role: "custom",
					customType: ORCHESTRATOR_RUN_MESSAGE_TYPE,
					display: true,
					details: details(10, "running"),
				},
			},
			{
				type: "message",
				message: {
					role: "custom",
					customType: ORCHESTRATOR_RUN_MESSAGE_TYPE,
					display: false,
					details: details(20, "complete"),
				},
			},
		]);
		const snapshot = getRenderableRunSnapshot(details(0, "queued"));
		assert.equal(snapshot.details.status, "complete");
		assert.equal(snapshot.details.updatedAt, 20);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRunStateService } from "../run-state-service.ts";
import type { OrchestratorChildSessionRecord, OrchestratorRunRecord } from "../types.ts";

function makeState() {
	let child = { childSessionId: "child-1", runId: "run-1", status: "running", updatedAt: 1 } as OrchestratorChildSessionRecord;
	let run = { orchestratorRunId: "run-1", status: "running", updatedAt: 1 } as OrchestratorRunRecord;
	return {
		state: {
			getChildSession: () => child,
			updateChildSession: (_id: string, patch: Partial<OrchestratorChildSessionRecord>) => (child = { ...child, ...patch }),
			getRun: () => run,
			updateRun: (_id: string, patch: Partial<OrchestratorRunRecord>) => (run = { ...run, ...patch }),
			listChildSessionsByRun: () => [child],
			listHandbacksByRun: () => [],
		} as never,
		child: () => child,
		run: () => run,
	};
}

describe("run state terminal ownership", () => {
	it("claims child and aggregate terminal transitions independently", () => {
		const fixture = makeState();
		const service = createRunStateService({ state: fixture.state });

		assert.equal(service.tryFinalizeChild("child-1", { status: "complete", resultSummary: "done" })?.status, "complete");
		assert.equal(fixture.run().status, "running", "child completion must not finalize an active parent run");
		assert.equal(service.tryFinalizeChild("child-1", { status: "failed", error: "late" }), undefined);
		assert.equal(fixture.child().status, "complete");

		assert.equal(service.tryFinalizeRun("run-1", { status: "complete", resultSummary: "done" })?.status, "complete");
		assert.equal(service.tryFinalizeRun("run-1", { status: "cancelled" }), undefined);
		assert.equal(fixture.run().status, "complete");
	});
});

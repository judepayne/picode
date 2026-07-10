import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activateRunMessageSnapshotStore, createRunMessageSnapshotStore, getRenderableRunSnapshot } from "../run-live-state.ts";
import { activateSubagentStreamService, openSubagentStream } from "../stream.ts";

const details = (runId: string, status = "running") => ({ runId, ownerModeId: "builder", requestShape: "single", async: true, context: "fresh", origin: "agent", status, taskSummary: runId, updatedAt: 1, childSessionCount: 0, activeChildCount: 0, queuedHandbackCount: 0, consumedHandbackCount: 0, children: [] }) as never;

describe("registration-owned runtime projections", () => {
	test("run snapshots are isolated and stale disposal cannot deactivate the current store", () => {
		const first = createRunMessageSnapshotStore();
		const disposeFirst = activateRunMessageSnapshotStore(first);
		first.remember(details("first"));
		const second = createRunMessageSnapshotStore();
		const disposeSecond = activateRunMessageSnapshotStore(second);
		second.remember(details("second"));
		disposeFirst();
		assert.equal(getRenderableRunSnapshot(details("second")).version, 1);
		disposeSecond();
	});

	test("stream activation uses ownership tokens", () => {
		const opened: string[] = [];
		const disposeFirst = activateSubagentStreamService({ open(id) { opened.push(`first:${id}`); return () => {}; } });
		const disposeSecond = activateSubagentStreamService({ open(id) { opened.push(`second:${id}`); return () => {}; } });
		disposeFirst();
		openSubagentStream("child", () => {});
		assert.deepEqual(opened, ["second:child"]);
		disposeSecond();
		assert.throws(() => openSubagentStream("child", () => {}), /not active/);
	});
});

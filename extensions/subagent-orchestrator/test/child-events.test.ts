import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EVENT_CHILD_COMPLETE, EVENT_CHILD_ERROR, EVENT_CHILD_TEXT_DELTA } from "../../subagent-mode/types.ts";
import { createChildEventController } from "../child-events.ts";
import type { OrchestratorChildSessionRecord, OrchestratorNodeLogRecord, RunStatus } from "../types.ts";

function childRecord(): OrchestratorChildSessionRecord {
	return {
		childSessionId: "child-1",
		runId: "run-1",
		rootRunId: "run-1",
		ownerModeId: "builder",
		parentSessionId: "parent-1",
		requestShape: "single",
		async: false,
		context: "fresh",
		agent: "scout",
		childIndex: 0,
		childKey: "0",
		executionChildId: "exec-child-1",
		status: "running",
		taskSummary: "inspect",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("child event controller", () => {
	test("does not append already worker-logged text deltas on the main thread when the worker log matches the child", () => {
		const child = childRecord();
		let appendCount = 0;
		const controller = createChildEventController({
			pi: { events: { emit() {} } } as never,
			state: {
				listChildSessionsByRun: () => [child],
				findChildSessionByRunAndExecutionChildId: () => child,
				getChildSession: () => child,
				updateChildSession: () => child,
				appendNodeLogRecord: (_childSessionId: string, record: Omit<OrchestratorNodeLogRecord, "cursor">) => {
					appendCount += 1;
					return { cursor: "0", childSessionId: child.childSessionId, ...record };
				},
			},
			isTerminal: (status: RunStatus) => status === "complete" || status === "failed" || status === "cancelled",
			appendChildEntry: () => undefined,
			refreshRunAggregates: () => undefined,
			refreshRunMessageSnapshot: () => undefined,
			bindStickyUserSubagentSessionToRun: () => undefined,
		});

		controller.handleChildEvent("run-1", {
			type: EVENT_CHILD_TEXT_DELTA,
			runId: "underlying-run-1",
			childId: "child-1",
			agent: "scout",
			timestamp: 2,
			delta: "hello",
			nodeLogWritten: true,
		});
		controller.clearPendingTextDeltaFlushes();

		assert.equal(appendCount, 0);
	});

	test("ignores a late completion for a cancelled child", () => {
		const child = { ...childRecord(), status: "cancelled" as const, completedAt: 2, resultSummary: "cancelled by user" };
		let updateCount = 0;
		const controller = createChildEventController({
			pi: { events: { emit() {} } } as never,
			state: {
				listChildSessionsByRun: () => [child],
				findChildSessionByRunAndExecutionChildId: () => child,
				getChildSession: () => child,
				updateChildSession: (_childSessionId: string, patch: Partial<OrchestratorChildSessionRecord>) => {
					updateCount += 1;
					return { ...child, ...patch };
				},
				appendNodeLogRecord: (_childSessionId: string, record: Omit<OrchestratorNodeLogRecord, "cursor">) => ({
					cursor: "0",
					childSessionId: child.childSessionId,
					...record,
				}),
			},
			isTerminal: (status: RunStatus) => status === "complete" || status === "failed" || status === "cancelled",
			appendChildEntry: () => undefined,
			refreshRunAggregates: () => undefined,
			refreshRunMessageSnapshot: () => undefined,
			bindStickyUserSubagentSessionToRun: () => undefined,
		});

		controller.handleChildEvent("run-1", {
			type: EVENT_CHILD_COMPLETE,
			runId: "underlying-run-1",
			childId: child.executionChildId,
			agent: "scout",
			timestamp: 3,
			result: { status: "complete", finalText: "late result" },
		});

		assert.equal(updateCount, 0);
	});

	test("allows authoritative completion after a non-fatal child diagnostic", () => {
		let child = childRecord();
		const controller = createChildEventController({
			pi: { events: { emit() {} } } as never,
			state: {
				listChildSessionsByRun: () => [child],
				findChildSessionByRunAndExecutionChildId: () => child,
				getChildSession: () => child,
				updateChildSession: (_id: string, patch: Partial<OrchestratorChildSessionRecord>) => (child = { ...child, ...patch }),
				appendNodeLogRecord: (_id: string, record: Omit<OrchestratorNodeLogRecord, "cursor">) => ({ cursor: "0", childSessionId: child.childSessionId, ...record }),
			},
			isTerminal: (status: RunStatus) => status === "complete" || status === "failed" || status === "cancelled",
			appendChildEntry: () => undefined,
			refreshRunAggregates: () => undefined,
			refreshRunMessageSnapshot: () => undefined,
			bindStickyUserSubagentSessionToRun: () => undefined,
		});

		controller.handleChildEvent("run-1", {
			type: EVENT_CHILD_ERROR,
			childId: child.executionChildId,
			fatal: false,
			message: "malformed stdout line",
		});
		assert.equal(child.status, "running");
		controller.handleChildEvent("run-1", {
			type: EVENT_CHILD_COMPLETE,
			childId: child.executionChildId,
			result: { status: "complete", finalText: "done", sessionFile: "/tmp/child.jsonl" },
		});
		assert.equal(child.status, "complete");
		assert.equal(child.sessionFile, "/tmp/child.jsonl");
	});

	test("appends worker-marked events when the worker log child id does not match the resolved child", () => {
		const child = childRecord();
		let appendCount = 0;
		const controller = createChildEventController({
			pi: { events: { emit() {} } } as never,
			state: {
				listChildSessionsByRun: () => [child],
				findChildSessionByRunAndExecutionChildId: () => undefined,
				getChildSession: () => child,
				updateChildSession: () => child,
				appendNodeLogRecord: (_childSessionId: string, record: Omit<OrchestratorNodeLogRecord, "cursor">) => {
					appendCount += 1;
					return { cursor: "0", childSessionId: child.childSessionId, ...record };
				},
			},
			isTerminal: (status: RunStatus) => status === "complete" || status === "failed" || status === "cancelled",
			appendChildEntry: () => undefined,
			refreshRunAggregates: () => undefined,
			refreshRunMessageSnapshot: () => undefined,
			bindStickyUserSubagentSessionToRun: () => undefined,
		});

		controller.handleChildEvent("run-1", {
			type: EVENT_CHILD_TEXT_DELTA,
			runId: "underlying-run-1",
			childId: "random-worker-child-id",
			agent: "scout",
			stepIndex: 0,
			timestamp: 2,
			delta: "hello",
			nodeLogWritten: true,
		});
		controller.clearPendingTextDeltaFlushes();

		assert.equal(appendCount, 1);
	});
});

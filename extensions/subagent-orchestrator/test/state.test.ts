import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createStateStore } from "../state.ts";

describe("subagent-orchestrator state store", () => {
	it("persists child sessions, handbacks, and continuations", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-orchestrator-state-"));
		try {
			const store = createStateStore(root);
			store.ensureReady();
			store.createRun({
				orchestratorRunId: "run-1",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				rootRunId: "run-1",
				depth: 0,
				launchedAt: 1,
				updatedAt: 1,
				requestShape: "parallel",
				async: true,
				context: "fork",
				origin: "user",
				agent: "scout",
				status: "queued",
				taskSummary: "A | B",
				selectedChildIndex: 0,
			});
			store.createChildSession({
				childSessionId: "child-1",
				runId: "run-1",
				rootRunId: "run-1",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				requestShape: "parallel",
				async: true,
				context: "fork",
				agent: "scout",
				childIndex: 0,
				childKey: "parallel:0",
				status: "running",
				taskSummary: "A",
				recentOutput: ["line 1", "line 2"],
				createdAt: 1,
				updatedAt: 2,
			});
			store.createChildSession({
				childSessionId: "child-2",
				runId: "run-2",
				rootRunId: "run-2",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				requestShape: "single",
				async: true,
				context: "fork",
				agent: "worker",
				childIndex: 0,
				childKey: "single:0",
				status: "queued",
				taskSummary: "B",
				createdAt: 1,
				updatedAt: 2,
			});
			store.createHandback({
				handbackId: "handback-1",
				runId: "run-1",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				childSessionIds: ["child-1"],
				consumer: "user",
				agent: "scout",
				status: "queued",
				content: "Result",
				summary: "Result",
				createdAt: 3,
				updatedAt: 3,
			});
			store.createContinuation({
				continuationId: "cont-1",
				parentSessionId: "session-1",
				ownerModeId: "designer",
				handbackIds: ["handback-1"],
				consumer: "user",
				agent: "scout",
				status: "queued",
				content: "Continue",
				createdAt: 4,
				updatedAt: 4,
			});

			assert.equal(store.listChildSessionsByRun("run-1").length, 1);
			assert.equal(store.listChildSessionsByRootRunId("run-1").length, 1);
			assert.deepEqual(store.listChildSessionsByRootRunIds(["run-1", "run-2"]).map((child) => child.childSessionId), ["child-1", "child-2"]);
			assert.deepEqual(store.listChildSessionsByRootRunIds([]), []);
			assert.deepEqual(store.listChildSessionsByRun("run-1")[0]?.recentOutput, ["line 1", "line 2"]);
			assert.equal(store.getRun("run-1")?.selectedChildIndex, 0);
			assert.equal(store.getRun("run-1")?.origin, "user");
			assert.equal(store.getLatestTopLevelRunForMode("designer")?.orchestratorRunId, "run-1");
			assert.equal(store.listQueuedHandbacks("session-1", "designer").length, 1);
			assert.equal(store.listContinuations().length, 1);
			assert.equal(store.getHandback("handback-1")?.consumer, "user");
			assert.equal(store.getContinuation("cont-1")?.agent, "scout");

			const firstLog = store.appendNodeLogRecord("child-1", {
				runId: "run-1",
				rootRunId: "run-1",
				timestamp: 10,
				eventType: "subagent:mode:child.started",
				event: { type: "subagent:mode:child.started" },
			});
			assert.equal(firstLog.cursor, "0");
			assert.equal(store.readNodeLog("child-1").length, 1);
			const next = store.readNodeLogSince("child-1", "0");
			assert.equal(next.records.length, 1);
			assert.equal(store.readNodeLogSince("child-1", next.cursor).records.length, 0);
			assert.equal(store.readNodeLogSince("child-1", "bogus").records.length, 1);
			assert.equal(store.readNodeLogSince("child-1", "999999").records.length, 0);

			const nodeLogPath = path.join(root, "node-logs", "child-1.jsonl");
			const cursorBeforePartial = store.readNodeLogSince("child-1").cursor;
			fs.appendFileSync(nodeLogPath, "{\"cursor\":\"" + cursorBeforePartial + "\",\"childSessionId\":\"child-1\",\"runId\":\"run-1\",\"timestamp\":11,\"eventType\":\"partial\",\"event\":{\"partial\":", "utf8");
			const partialRead = store.readNodeLogSince("child-1", cursorBeforePartial);
			assert.equal(partialRead.records.length, 0);
			assert.equal(partialRead.cursor, cursorBeforePartial);
			fs.appendFileSync(nodeLogPath, "true}}\n", "utf8");
			const completedRead = store.readNodeLogSince("child-1", cursorBeforePartial);
			assert.equal(completedRead.records.length, 1);
			assert.equal(completedRead.records[0]?.event.partial, true);

			fs.writeFileSync(path.join(root, "runs", "run-2.json"), JSON.stringify({
				orchestratorRunId: "run-2",
				ownerModeId: "designer",
				launchedAt: 6,
				updatedAt: 6,
				requestShape: "single",
				async: false,
				context: "fresh",
				status: "queued",
				taskSummary: "B",
			}, null, 2));
			assert.equal(store.listRuns().some((run) => run.orchestratorRunId === "run-2"), true);

			store.markHandbackConsumed("handback-1", 5);
			assert.equal(store.getHandback("handback-1")?.status, "consumed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps run index summaries compact while preserving full run records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-orchestrator-state-"));
		try {
			const store = createStateStore(root);
			store.ensureReady();
			const longText = "x".repeat(1000);
			store.createRun({
				orchestratorRunId: "run-compact",
				ownerModeId: "builder",
				launchedAt: 1,
				updatedAt: 1,
				requestShape: "single",
				async: true,
				context: "fresh",
				status: "failed",
				taskSummary: "task",
				resultSummary: longText,
				error: longText,
			});

			assert.equal(store.getRun("run-compact")?.resultSummary, longText);
			const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
			assert.equal(index.runs[0].resultSummary.length <= 240, true);
			assert.equal(index.runs[0].error.length <= 240, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

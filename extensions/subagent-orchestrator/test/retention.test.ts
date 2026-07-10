import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { asyncRunDir, asyncRunManifestPath } from "../../subagent-mode/paths.ts";
import { ASYNC_SCHEMA_VERSION } from "../../subagent-mode/types.ts";
import {
	createOrchestratorRetentionController,
	DEFAULT_RETENTION_MAX_AGE_DAYS,
	DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS,
	resolveOrchestratorRetentionPolicy,
} from "../retention.ts";
import { createStateStore, type StateStore } from "../state.ts";
import type { OrchestratorRunRecord, RunStatus } from "../types.ts";

const roots: string[] = [];
const asyncDirs: string[] = [];
const NOW = Date.UTC(2026, 6, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const dir of asyncDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(vars?: unknown): { cwd: string; state: StateStore } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-retention-"));
	roots.push(cwd);
	if (vars !== undefined) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "agent-mode-vars.json"), `${JSON.stringify(vars, null, 2)}\n`, "utf8");
	}
	const state = createStateStore(path.join(cwd, ".pi", "state", "subagent-orchestrator"));
	state.ensureReady();
	return { cwd, state };
}

function createRun(
	state: StateStore,
	id: string,
	completedAt: number,
	options: { status?: RunStatus; rootRunId?: string; parentRunId?: string; visible?: boolean; asyncDir?: string; underlyingRunId?: string } = {},
): OrchestratorRunRecord {
	const status = options.status ?? "complete";
	return state.createRun({
		orchestratorRunId: id,
		ownerModeId: "builder",
		rootRunId: options.rootRunId ?? id,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		launchedAt: completedAt - 100,
		updatedAt: completedAt,
		completedAt,
		requestShape: "single",
		async: Boolean(options.asyncDir),
		context: "fresh",
		status,
		taskSummary: id,
		...(options.asyncDir ? { asyncDir: options.asyncDir } : {}),
		...(options.underlyingRunId ? { underlyingRunId: options.underlyingRunId } : {}),
		...(options.visible ? {} : { terminalStatusNotifiedAt: completedAt + 1 }),
		...(status === "failed" && !options.visible ? { failureAcknowledgedAt: completedAt + 1 } : {}),
	});
}

function createChild(state: StateStore, rootRunId: string, runId: string, childSessionId: string, status: RunStatus): void {
	state.createChildSession({
		childSessionId,
		runId,
		rootRunId,
		ownerModeId: "builder",
		parentSessionId: "parent",
		requestShape: "single",
		async: false,
		context: "fresh",
		agent: "worker",
		childIndex: 0,
		childKey: `single:${childSessionId}`,
		status,
		taskSummary: childSessionId,
		createdAt: NOW - 60 * DAY_MS,
		updatedAt: NOW - 60 * DAY_MS,
		...(status === "complete" ? { completedAt: NOW - 60 * DAY_MS } : {}),
	});
}

describe("orchestrator retention", () => {
	it("uses conservative defaults and independently validates overrides", () => {
		assert.deepEqual(resolveOrchestratorRetentionPolicy({}), {
			maxAgeDays: DEFAULT_RETENTION_MAX_AGE_DAYS,
			maxTopLevelRuns: DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS,
			warnings: [],
		});
		const policy = resolveOrchestratorRetentionPolicy({
			"subagent.orchestrator.retention.maxAgeDays": 7,
			"subagent.orchestrator.retention.maxTopLevelRuns": "2",
		});
		assert.equal(policy.maxAgeDays, 7);
		assert.equal(policy.maxTopLevelRuns, DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS);
		assert.equal(policy.warnings.length, 1);
	});

	it("prunes complete trees when either age or project-wide count is exceeded", () => {
		const { cwd, state } = workspace({ subagent: { orchestrator: { retention: { maxAgeDays: 30, maxTopLevelRuns: 2 } } } });
		createRun(state, "recent-1", NOW - DAY_MS);
		createRun(state, "recent-2", NOW - 2 * DAY_MS, { status: "failed" });
		createRun(state, "count-pruned", NOW - 3 * DAY_MS, { status: "cancelled" });
		createRun(state, "old-root", NOW - 40 * DAY_MS);
		createRun(state, "old-nested", NOW - 40 * DAY_MS, { rootRunId: "old-root", parentRunId: "old-root" });
		createChild(state, "old-root", "old-nested", "old-child", "complete");
		state.appendNodeLogRecord("old-child", { runId: "old-nested", rootRunId: "old-root", timestamp: NOW, eventType: "done", event: {} });

		const summary = createOrchestratorRetentionController({ state, now: () => NOW }).prune(cwd);
		assert.equal(summary.prunedTopLevelRuns, 2);
		assert.equal(summary.prunedRuns, 3);
		assert.equal(summary.prunedChildSessions, 1);
		assert.equal(summary.prunedNodeLogs, 1);
		assert.deepEqual(state.listRuns().map((run) => run.orchestratorRunId).sort(), ["recent-1", "recent-2"]);
	});

	it("protects active, visible, queued-handback, deferred-continuation, and sticky run trees", () => {
		const { cwd, state } = workspace({ subagent: { orchestrator: { retention: { maxAgeDays: 1, maxTopLevelRuns: 1 } } } });
		const old = NOW - 40 * DAY_MS;
		createRun(state, "active-child", old);
		createChild(state, "active-child", "active-child", "running-child", "running");
		createRun(state, "visible", old, { visible: true });
		createRun(state, "queued-handback", old);
		state.createHandback({ handbackId: "queued", runId: "queued-handback", ownerModeId: "builder", parentSessionId: "parent", childSessionIds: [], status: "queued", content: "queued", summary: "queued", createdAt: old, updatedAt: old });
		createRun(state, "deferred-continuation", old);
		state.createHandback({ handbackId: "deferred-hb", runId: "deferred-continuation", ownerModeId: "builder", parentSessionId: "parent", childSessionIds: [], status: "consumed", content: "done", summary: "done", createdAt: old, updatedAt: old });
		state.createContinuation({ continuationId: "deferred", parentSessionId: "parent", ownerModeId: "builder", handbackIds: ["deferred-hb"], status: "deferred", content: "later", createdAt: old, updatedAt: old });
		createRun(state, "sticky", old);

		const summary = createOrchestratorRetentionController({ state, getActiveRunIds: () => ["sticky"], now: () => NOW }).prune(cwd);
		assert.equal(summary.prunedTopLevelRuns, 0);
		assert.equal(summary.protectedTopLevelRuns, 5);
		assert.equal(state.listRuns().length, 5);
	});

	it("keeps proven async cleanup journaled until durable tree deletion succeeds", () => {
		const { cwd, state } = workspace({ subagent: { orchestrator: { retention: { maxAgeDays: 1, maxTopLevelRuns: 10 } } } });
		const ownedId = `retention-state-retry-${process.pid}-${Date.now()}`;
		const ownedDir = asyncRunDir(ownedId);
		asyncDirs.push(ownedDir);
		fs.mkdirSync(ownedDir, { recursive: true });
		fs.writeFileSync(asyncRunManifestPath(ownedId), JSON.stringify({ schemaVersion: ASYNC_SCHEMA_VERSION, runId: ownedId, topLevelRunId: ownedId }), "utf8");
		createRun(state, "state-retry-root", NOW - 40 * DAY_MS, { asyncDir: ownedDir, underlyingRunId: ownedId });
		createChild(state, "state-retry-root", "state-retry-root", "blocked-child", "complete");
		const blockedLog = path.join(state.nodeLogsDir, "blocked-child.jsonl");
		fs.mkdirSync(blockedLog);

		const failed = createOrchestratorRetentionController({ state, now: () => NOW }).prune(cwd);
		assert.equal(failed.prunedTopLevelRuns, 0);
		assert.equal(failed.errors.length, 1);
		assert.ok(state.getRun("state-retry-root"));
		assert.equal(fs.existsSync(ownedDir), false);
		assert.equal(fs.existsSync(path.join(state.rootDir, "retention-async-cleanup.json")), true);

		fs.rmdirSync(blockedLog);
		const retried = createOrchestratorRetentionController({ state, now: () => NOW }).prune(cwd);
		assert.equal(retried.prunedTopLevelRuns, 1);
		assert.equal(fs.existsSync(path.join(state.rootDir, "retention-async-cleanup.json")), false);
	});

	it("retries journaled async cleanup even when a partial prior removal lost the manifest", () => {
		const { cwd, state } = workspace({ subagent: { orchestrator: { retention: { maxAgeDays: 1, maxTopLevelRuns: 10 } } } });
		const ownedId = `retention-retry-${process.pid}-${Date.now()}`;
		const ownedDir = asyncRunDir(ownedId);
		asyncDirs.push(ownedDir);
		fs.mkdirSync(ownedDir, { recursive: true });
		fs.writeFileSync(path.join(ownedDir, "partial"), "partial", "utf8");
		createRun(state, "retry-root", NOW - 40 * DAY_MS, { asyncDir: ownedDir, underlyingRunId: ownedId });
		fs.writeFileSync(path.join(state.rootDir, "retention-async-cleanup.json"), `${JSON.stringify({
			version: 1,
			entries: [{ rootRunId: "retry-root", underlyingRunId: ownedId, dir: ownedDir }],
		}, null, 2)}\n`, "utf8");

		const summary = createOrchestratorRetentionController({ state, now: () => NOW }).prune(cwd);
		assert.equal(summary.prunedTopLevelRuns, 1);
		assert.equal(summary.prunedAsyncDirs, 1);
		assert.equal(fs.existsSync(ownedDir), false);
		assert.equal(fs.existsSync(path.join(state.rootDir, "retention-async-cleanup.json")), false);
	});

	it("deletes only async directories with canonical paths and matching manifests", () => {
		const { cwd, state } = workspace({ subagent: { orchestrator: { retention: { maxAgeDays: 1, maxTopLevelRuns: 10 } } } });
		const ownedId = `retention-owned-${process.pid}-${Date.now()}`;
		const ownedDir = asyncRunDir(ownedId);
		asyncDirs.push(ownedDir);
		fs.mkdirSync(ownedDir, { recursive: true });
		fs.writeFileSync(asyncRunManifestPath(ownedId), JSON.stringify({ schemaVersion: ASYNC_SCHEMA_VERSION, runId: ownedId, topLevelRunId: ownedId }), "utf8");
		createRun(state, "owned", NOW - 40 * DAY_MS, { asyncDir: ownedDir, underlyingRunId: ownedId });

		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-unowned-"));
		roots.push(outsideDir);
		createRun(state, "unowned", NOW - 40 * DAY_MS, { asyncDir: outsideDir, underlyingRunId: "unowned" });
		const summary = createOrchestratorRetentionController({ state, now: () => NOW }).prune(cwd);
		assert.equal(summary.prunedTopLevelRuns, 2);
		assert.equal(summary.prunedAsyncDirs, 1);
		assert.equal(summary.skippedAsyncDirs, 1);
		assert.equal(fs.existsSync(ownedDir), false);
		assert.equal(fs.existsSync(outsideDir), true);
	});
});

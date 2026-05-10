import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	OrchestratorChildSessionIndexFile,
	OrchestratorChildSessionRecord,
	OrchestratorChildSessionSummary,
	OrchestratorContinuationIndexFile,
	OrchestratorContinuationRecord,
	OrchestratorContinuationSummary,
	OrchestratorHandbackIndexFile,
	OrchestratorHandbackRecord,
	OrchestratorHandbackSummary,
	OrchestratorIndexFile,
	OrchestratorNodeLogRecord,
	OrchestratorRunRecord,
	OrchestratorRunSummary,
} from "./types.ts";

function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return fallback;
		}
		throw error;
	}
}

function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
	fs.renameSync(tmpPath, filePath);
}

function sortByUpdatedAtDesc<T extends { updatedAt: number }>(items: T[]): T[] {
	return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sortRunsForTree<T extends { launchedAt: number; updatedAt: number }>(items: T[]): T[] {
	return [...items].sort((a, b) => b.launchedAt - a.launchedAt || b.updatedAt - a.updatedAt);
}

function listRecordJsonFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
		.map((entry) => path.join(dir, entry))
		.sort();
}

function listRecordJsonIds(dir: string): string[] {
	return listRecordJsonFiles(dir).map((filePath) => path.basename(filePath, ".json"));
}

function sameIdSet(actualIds: string[], expectedIds: string[]): boolean {
	if (actualIds.length !== expectedIds.length) return false;
	const actual = [...actualIds].sort();
	const expected = [...expectedIds].sort();
	return actual.every((id, index) => id === expected[index]);
}

function parseJsonlBuffer(buffer: Buffer, offset = 0): OrchestratorNodeLogRecord[] {
	const text = buffer.subarray(offset).toString("utf8");
	if (!text.trim()) return [];
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as OrchestratorNodeLogRecord);
}

function summarizeRun(record: OrchestratorRunRecord): OrchestratorRunSummary {
	return {
		orchestratorRunId: record.orchestratorRunId,
		ownerModeId: record.ownerModeId,
		...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
		...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
		...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
		...(record.parentChildSessionId ? { parentChildSessionId: record.parentChildSessionId } : {}),
		...(record.depth !== undefined ? { depth: record.depth } : {}),
		updatedAt: record.updatedAt,
		requestShape: record.requestShape,
		async: record.async,
		context: record.context,
		...(record.origin ? { origin: record.origin } : {}),
		...(record.agent ? { agent: record.agent } : {}),
		status: record.status,
		taskSummary: record.taskSummary,
		...(record.underlyingRunId ? { underlyingRunId: record.underlyingRunId } : {}),
		...(record.asyncEventCursor !== undefined ? { asyncEventCursor: record.asyncEventCursor } : {}),
		...(record.resultSummary ? { resultSummary: record.resultSummary } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.childSessionCount !== undefined ? { childSessionCount: record.childSessionCount } : {}),
		...(record.activeChildCount !== undefined ? { activeChildCount: record.activeChildCount } : {}),
		...(record.queuedHandbackCount !== undefined ? { queuedHandbackCount: record.queuedHandbackCount } : {}),
		...(record.consumedHandbackCount !== undefined ? { consumedHandbackCount: record.consumedHandbackCount } : {}),
		...(record.selectedChildIndex !== undefined ? { selectedChildIndex: record.selectedChildIndex } : {}),
		...(record.terminalStatusNotifiedAt !== undefined ? { terminalStatusNotifiedAt: record.terminalStatusNotifiedAt } : {}),
		...(record.failureAcknowledgedAt !== undefined ? { failureAcknowledgedAt: record.failureAcknowledgedAt } : {}),
	};
}

function summarizeChildSession(record: OrchestratorChildSessionRecord): OrchestratorChildSessionSummary {
	return {
		childSessionId: record.childSessionId,
		runId: record.runId,
		...(record.rootRunId ? { rootRunId: record.rootRunId } : {}),
		...(record.parentChildSessionId ? { parentChildSessionId: record.parentChildSessionId } : {}),
		ownerModeId: record.ownerModeId,
		parentSessionId: record.parentSessionId,
		agent: record.agent,
		childIndex: record.childIndex,
		childKey: record.childKey,
		...(record.branchKey ? { branchKey: record.branchKey } : {}),
		...(record.stepIndex !== undefined ? { stepIndex: record.stepIndex } : {}),
		...(record.taskIndex !== undefined ? { taskIndex: record.taskIndex } : {}),
		...(record.executionChildId ? { executionChildId: record.executionChildId } : {}),
		status: record.status,
		taskSummary: record.taskSummary,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.currentTool ? { currentTool: record.currentTool } : {}),
		...(record.toolCount !== undefined ? { toolCount: record.toolCount } : {}),
		...(record.recentOutput && record.recentOutput.length > 0 ? { recentOutput: [...record.recentOutput] } : {}),
		...(record.resultSummary ? { resultSummary: record.resultSummary } : {}),
		...(record.error ? { error: record.error } : {}),
		updatedAt: record.updatedAt,
		...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
	};
}

function summarizeHandback(record: OrchestratorHandbackRecord): OrchestratorHandbackSummary {
	return {
		handbackId: record.handbackId,
		runId: record.runId,
		ownerModeId: record.ownerModeId,
		parentSessionId: record.parentSessionId,
		childSessionIds: [...record.childSessionIds],
		...(record.consumer ? { consumer: record.consumer } : {}),
		...(record.agent ? { agent: record.agent } : {}),
		status: record.status,
		summary: record.summary,
		...(record.batchId ? { batchId: record.batchId } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.visibleNotifiedAt !== undefined ? { visibleNotifiedAt: record.visibleNotifiedAt } : {}),
		...(record.consumedAt !== undefined ? { consumedAt: record.consumedAt } : {}),
		...(record.dismissedAt !== undefined ? { dismissedAt: record.dismissedAt } : {}),
	};
}

function summarizeContinuation(record: OrchestratorContinuationRecord): OrchestratorContinuationSummary {
	return {
		continuationId: record.continuationId,
		parentSessionId: record.parentSessionId,
		ownerModeId: record.ownerModeId,
		handbackIds: [...record.handbackIds],
		...(record.consumer ? { consumer: record.consumer } : {}),
		...(record.agent ? { agent: record.agent } : {}),
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.launchedAt !== undefined ? { launchedAt: record.launchedAt } : {}),
		...(record.error ? { error: record.error } : {}),
	};
}

function parseCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	const value = Number(cursor);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function createStateStore(rootDir: string) {
	const runsDir = path.join(rootDir, "runs");
	const childSessionsDir = path.join(rootDir, "child-sessions");
	const handbacksDir = path.join(rootDir, "handbacks");
	const continuationsDir = path.join(rootDir, "continuations");
	const nodeLogsDir = path.join(rootDir, "node-logs");
	const runsIndexPath = path.join(rootDir, "index.json");
	const childSessionsIndexPath = path.join(rootDir, "child-sessions-index.json");
	const handbacksIndexPath = path.join(rootDir, "handbacks-index.json");
	const continuationsIndexPath = path.join(rootDir, "continuations-index.json");

	function ensureReady(): void {
		fs.mkdirSync(runsDir, { recursive: true });
		fs.mkdirSync(childSessionsDir, { recursive: true });
		fs.mkdirSync(handbacksDir, { recursive: true });
		fs.mkdirSync(continuationsDir, { recursive: true });
		fs.mkdirSync(nodeLogsDir, { recursive: true });
		if (!fs.existsSync(runsIndexPath)) writeJsonFile(runsIndexPath, { version: 1, runs: [] } satisfies OrchestratorIndexFile);
		if (!fs.existsSync(childSessionsIndexPath)) writeJsonFile(childSessionsIndexPath, { version: 1, childSessions: [] } satisfies OrchestratorChildSessionIndexFile);
		if (!fs.existsSync(handbacksIndexPath)) writeJsonFile(handbacksIndexPath, { version: 1, handbacks: [] } satisfies OrchestratorHandbackIndexFile);
		if (!fs.existsSync(continuationsIndexPath)) writeJsonFile(continuationsIndexPath, { version: 1, continuations: [] } satisfies OrchestratorContinuationIndexFile);
	}

	function runPath(runId: string): string {
		return path.join(runsDir, `${runId}.json`);
	}

	function childSessionPath(childSessionId: string): string {
		return path.join(childSessionsDir, `${childSessionId}.json`);
	}

	function handbackPath(handbackId: string): string {
		return path.join(handbacksDir, `${handbackId}.json`);
	}

	function continuationPath(continuationId: string): string {
		return path.join(continuationsDir, `${continuationId}.json`);
	}

	function nodeLogPath(childSessionId: string): string {
		return path.join(nodeLogsDir, `${childSessionId}.jsonl`);
	}

	function rebuildRunsIndex(): OrchestratorIndexFile {
		const runs = sortByUpdatedAtDesc(listRecordJsonFiles(runsDir).map((filePath) => readJsonFile<OrchestratorRunRecord | undefined>(filePath, undefined)).filter((run): run is OrchestratorRunRecord => Boolean(run)).map(summarizeRun));
		const index = { version: 1, runs } satisfies OrchestratorIndexFile;
		writeJsonFile(runsIndexPath, index);
		return index;
	}

	function rebuildChildSessionsIndex(): OrchestratorChildSessionIndexFile {
		const childSessions = sortByUpdatedAtDesc(listRecordJsonFiles(childSessionsDir).map((filePath) => readJsonFile<OrchestratorChildSessionRecord | undefined>(filePath, undefined)).filter((record): record is OrchestratorChildSessionRecord => Boolean(record)).map(summarizeChildSession));
		const index = { version: 1, childSessions } satisfies OrchestratorChildSessionIndexFile;
		writeJsonFile(childSessionsIndexPath, index);
		return index;
	}

	function rebuildHandbacksIndex(): OrchestratorHandbackIndexFile {
		const handbacks = sortByUpdatedAtDesc(listRecordJsonFiles(handbacksDir).map((filePath) => readJsonFile<OrchestratorHandbackRecord | undefined>(filePath, undefined)).filter((record): record is OrchestratorHandbackRecord => Boolean(record)).map(summarizeHandback));
		const index = { version: 1, handbacks } satisfies OrchestratorHandbackIndexFile;
		writeJsonFile(handbacksIndexPath, index);
		return index;
	}

	function rebuildContinuationsIndex(): OrchestratorContinuationIndexFile {
		const continuations = sortByUpdatedAtDesc(listRecordJsonFiles(continuationsDir).map((filePath) => readJsonFile<OrchestratorContinuationRecord | undefined>(filePath, undefined)).filter((record): record is OrchestratorContinuationRecord => Boolean(record)).map(summarizeContinuation));
		const index = { version: 1, continuations } satisfies OrchestratorContinuationIndexFile;
		writeJsonFile(continuationsIndexPath, index);
		return index;
	}

	function loadRunsIndex(): OrchestratorIndexFile {
		ensureReady();
		let index: OrchestratorIndexFile;
		try {
			index = readJsonFile<OrchestratorIndexFile>(runsIndexPath, { version: 1, runs: [] });
		} catch {
			return rebuildRunsIndex();
		}
		const runs = Array.isArray(index.runs) ? sortByUpdatedAtDesc(index.runs) : [];
		const expectedIds = listRecordJsonIds(runsDir);
		const actualIds = runs.map((run) => run.orchestratorRunId);
		if (!sameIdSet(actualIds, expectedIds)) return rebuildRunsIndex();
		return { version: 1, runs };
	}

	function saveRunsIndex(index: OrchestratorIndexFile): void {
		writeJsonFile(runsIndexPath, { version: 1, runs: sortByUpdatedAtDesc(index.runs) });
	}

	function loadChildSessionsIndex(): OrchestratorChildSessionIndexFile {
		ensureReady();
		let index: OrchestratorChildSessionIndexFile;
		try {
			index = readJsonFile<OrchestratorChildSessionIndexFile>(childSessionsIndexPath, { version: 1, childSessions: [] });
		} catch {
			return rebuildChildSessionsIndex();
		}
		const childSessions = Array.isArray(index.childSessions) ? sortByUpdatedAtDesc(index.childSessions) : [];
		const expectedIds = listRecordJsonIds(childSessionsDir);
		const actualIds = childSessions.map((record) => record.childSessionId);
		if (!sameIdSet(actualIds, expectedIds)) return rebuildChildSessionsIndex();
		return { version: 1, childSessions };
	}

	function saveChildSessionsIndex(index: OrchestratorChildSessionIndexFile): void {
		writeJsonFile(childSessionsIndexPath, { version: 1, childSessions: sortByUpdatedAtDesc(index.childSessions) });
	}

	function loadHandbacksIndex(): OrchestratorHandbackIndexFile {
		ensureReady();
		let index: OrchestratorHandbackIndexFile;
		try {
			index = readJsonFile<OrchestratorHandbackIndexFile>(handbacksIndexPath, { version: 1, handbacks: [] });
		} catch {
			return rebuildHandbacksIndex();
		}
		const handbacks = Array.isArray(index.handbacks) ? sortByUpdatedAtDesc(index.handbacks) : [];
		const expectedIds = listRecordJsonIds(handbacksDir);
		const actualIds = handbacks.map((record) => record.handbackId);
		if (!sameIdSet(actualIds, expectedIds)) return rebuildHandbacksIndex();
		return { version: 1, handbacks };
	}

	function saveHandbacksIndex(index: OrchestratorHandbackIndexFile): void {
		writeJsonFile(handbacksIndexPath, { version: 1, handbacks: sortByUpdatedAtDesc(index.handbacks) });
	}

	function loadContinuationsIndex(): OrchestratorContinuationIndexFile {
		ensureReady();
		let index: OrchestratorContinuationIndexFile;
		try {
			index = readJsonFile<OrchestratorContinuationIndexFile>(continuationsIndexPath, { version: 1, continuations: [] });
		} catch {
			return rebuildContinuationsIndex();
		}
		const continuations = Array.isArray(index.continuations) ? sortByUpdatedAtDesc(index.continuations) : [];
		const expectedIds = listRecordJsonIds(continuationsDir);
		const actualIds = continuations.map((record) => record.continuationId);
		if (!sameIdSet(actualIds, expectedIds)) return rebuildContinuationsIndex();
		return { version: 1, continuations };
	}

	function saveContinuationsIndex(index: OrchestratorContinuationIndexFile): void {
		writeJsonFile(continuationsIndexPath, { version: 1, continuations: sortByUpdatedAtDesc(index.continuations) });
	}

	function getRun(runId: string): OrchestratorRunRecord | undefined {
		ensureReady();
		const filePath = runPath(runId);
		if (!fs.existsSync(filePath)) return undefined;
		return readJsonFile<OrchestratorRunRecord | undefined>(filePath, undefined);
	}

	function saveRun(record: OrchestratorRunRecord): OrchestratorRunRecord {
		ensureReady();
		writeJsonFile(runPath(record.orchestratorRunId), record);
		rebuildRunsIndex();
		return record;
	}

	function createRun(record: OrchestratorRunRecord): OrchestratorRunRecord {
		return saveRun(record);
	}

	function updateRun(runId: string, patch: Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined {
		const existing = getRun(runId);
		if (!existing) return undefined;
		return saveRun({ ...existing, ...patch, orchestratorRunId: existing.orchestratorRunId });
	}

	function listRuns(): OrchestratorRunRecord[] {
		return loadRunsIndex().runs
			.map((summary) => getRun(summary.orchestratorRunId))
			.filter((run): run is OrchestratorRunRecord => Boolean(run))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function listOwnedRuns(ownerModeId: string): OrchestratorRunRecord[] {
		return loadRunsIndex().runs
			.filter((summary) => summary.ownerModeId === ownerModeId)
			.map((summary) => getRun(summary.orchestratorRunId))
			.filter((run): run is OrchestratorRunRecord => Boolean(run))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function listRunsByRootRunId(rootRunId: string): OrchestratorRunRecord[] {
		return loadRunsIndex().runs
			.filter((summary) => (summary.rootRunId ?? summary.orchestratorRunId) === rootRunId)
			.map((summary) => getRun(summary.orchestratorRunId))
			.filter((run): run is OrchestratorRunRecord => Boolean(run))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function listTopLevelRunsByMode(ownerModeId: string): OrchestratorRunRecord[] {
		return sortRunsForTree(
			loadRunsIndex().runs
				.filter((summary) => summary.ownerModeId === ownerModeId && !summary.parentRunId && !summary.parentChildSessionId)
				.map((summary) => getRun(summary.orchestratorRunId))
				.filter((run): run is OrchestratorRunRecord => Boolean(run)),
		);
	}

	function getLatestTopLevelRunForMode(ownerModeId: string): OrchestratorRunRecord | undefined {
		return listTopLevelRunsByMode(ownerModeId)[0];
	}

	function getOwnedRun(ownerModeId: string, runId: string): OrchestratorRunRecord | undefined {
		const run = getRun(runId);
		return run?.ownerModeId === ownerModeId ? run : undefined;
	}

	function findRunByUnderlyingId(id: string): OrchestratorRunRecord | undefined {
		return loadRunsIndex().runs
			.filter((summary) => summary.underlyingRunId === id || summary.orchestratorRunId === id)
			.map((summary) => getRun(summary.orchestratorRunId))
			.find((run) => Boolean(run && (run.underlyingRunId === id || run.underlyingRequestId === id || run.orchestratorRunId === id)));
	}

	function getChildSession(childSessionId: string): OrchestratorChildSessionRecord | undefined {
		ensureReady();
		const filePath = childSessionPath(childSessionId);
		if (!fs.existsSync(filePath)) return undefined;
		return readJsonFile<OrchestratorChildSessionRecord | undefined>(filePath, undefined);
	}

	function saveChildSession(record: OrchestratorChildSessionRecord): OrchestratorChildSessionRecord {
		ensureReady();
		writeJsonFile(childSessionPath(record.childSessionId), record);
		rebuildChildSessionsIndex();
		return record;
	}

	function createChildSession(record: OrchestratorChildSessionRecord): OrchestratorChildSessionRecord {
		return saveChildSession(record);
	}

	function updateChildSession(childSessionId: string, patch: Partial<OrchestratorChildSessionRecord>): OrchestratorChildSessionRecord | undefined {
		const existing = getChildSession(childSessionId);
		if (!existing) return undefined;
		return saveChildSession({ ...existing, ...patch, childSessionId: existing.childSessionId });
	}

	function listChildSessions(): OrchestratorChildSessionRecord[] {
		return loadChildSessionsIndex().childSessions
			.map((summary) => getChildSession(summary.childSessionId))
			.filter((record): record is OrchestratorChildSessionRecord => Boolean(record))
			.sort((a, b) => a.childIndex - b.childIndex || a.updatedAt - b.updatedAt);
	}

	function listChildSessionsByRun(runId: string): OrchestratorChildSessionRecord[] {
		return loadChildSessionsIndex().childSessions
			.filter((summary) => summary.runId === runId)
			.map((summary) => getChildSession(summary.childSessionId))
			.filter((record): record is OrchestratorChildSessionRecord => Boolean(record))
			.sort((a, b) => a.childIndex - b.childIndex || a.updatedAt - b.updatedAt);
	}

	function listChildSessionsByRootRunId(rootRunId: string): OrchestratorChildSessionRecord[] {
		return loadChildSessionsIndex().childSessions
			.filter((summary) => (summary.rootRunId ?? summary.runId) === rootRunId)
			.map((summary) => getChildSession(summary.childSessionId))
			.filter((record): record is OrchestratorChildSessionRecord => Boolean(record))
			.sort((a, b) => a.createdAt - b.createdAt || a.childIndex - b.childIndex || a.updatedAt - b.updatedAt);
	}

	function findChildSessionByRunAndKey(runId: string, childKey: string): OrchestratorChildSessionRecord | undefined {
		return loadChildSessionsIndex().childSessions
			.filter((summary) => summary.runId === runId && summary.childKey === childKey)
			.map((summary) => getChildSession(summary.childSessionId))
			.find((record): record is OrchestratorChildSessionRecord => Boolean(record));
	}

	function findChildSessionByRunAndExecutionChildId(runId: string, executionChildId: string): OrchestratorChildSessionRecord | undefined {
		return loadChildSessionsIndex().childSessions
			.filter((summary) => summary.runId === runId && summary.executionChildId === executionChildId)
			.map((summary) => getChildSession(summary.childSessionId))
			.find((record): record is OrchestratorChildSessionRecord => Boolean(record));
	}

	function findChildSessionByExecutionChildId(executionChildId: string): OrchestratorChildSessionRecord | undefined {
		return loadChildSessionsIndex().childSessions
			.filter((summary) => summary.executionChildId === executionChildId)
			.map((summary) => getChildSession(summary.childSessionId))
			.find((record): record is OrchestratorChildSessionRecord => Boolean(record));
	}

	function getHandback(handbackId: string): OrchestratorHandbackRecord | undefined {
		ensureReady();
		const filePath = handbackPath(handbackId);
		if (!fs.existsSync(filePath)) return undefined;
		return readJsonFile<OrchestratorHandbackRecord | undefined>(filePath, undefined);
	}

	function saveHandback(record: OrchestratorHandbackRecord): OrchestratorHandbackRecord {
		ensureReady();
		writeJsonFile(handbackPath(record.handbackId), record);
		rebuildHandbacksIndex();
		return record;
	}

	function createHandback(record: OrchestratorHandbackRecord): OrchestratorHandbackRecord {
		return saveHandback(record);
	}

	function updateHandback(handbackId: string, patch: Partial<OrchestratorHandbackRecord>): OrchestratorHandbackRecord | undefined {
		const existing = getHandback(handbackId);
		if (!existing) return undefined;
		return saveHandback({ ...existing, ...patch, handbackId: existing.handbackId });
	}

	function listHandbacks(): OrchestratorHandbackRecord[] {
		return loadHandbacksIndex().handbacks
			.map((summary) => getHandback(summary.handbackId))
			.filter((record): record is OrchestratorHandbackRecord => Boolean(record))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function listHandbacksByRun(runId: string): OrchestratorHandbackRecord[] {
		return loadHandbacksIndex().handbacks
			.filter((summary) => summary.runId === runId)
			.map((summary) => getHandback(summary.handbackId))
			.filter((record): record is OrchestratorHandbackRecord => Boolean(record))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function listQueuedHandbacks(parentSessionId?: string, ownerModeId?: string): OrchestratorHandbackRecord[] {
		return loadHandbacksIndex().handbacks
			.filter((summary) => {
				if (summary.status !== "queued") return false;
				if (parentSessionId && summary.parentSessionId !== parentSessionId) return false;
				if (ownerModeId && summary.ownerModeId !== ownerModeId) return false;
				return true;
			})
			.map((summary) => getHandback(summary.handbackId))
			.filter((record): record is OrchestratorHandbackRecord => Boolean(record))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function markHandbackConsumed(handbackId: string, consumedAt = Date.now()): OrchestratorHandbackRecord | undefined {
		return updateHandback(handbackId, { status: "consumed", updatedAt: consumedAt, consumedAt });
	}

	function markHandbackDismissed(handbackId: string, dismissedAt = Date.now()): OrchestratorHandbackRecord | undefined {
		return updateHandback(handbackId, { status: "dismissed", updatedAt: dismissedAt, dismissedAt });
	}

	function getContinuation(continuationId: string): OrchestratorContinuationRecord | undefined {
		ensureReady();
		const filePath = continuationPath(continuationId);
		if (!fs.existsSync(filePath)) return undefined;
		return readJsonFile<OrchestratorContinuationRecord | undefined>(filePath, undefined);
	}

	function saveContinuation(record: OrchestratorContinuationRecord): OrchestratorContinuationRecord {
		ensureReady();
		writeJsonFile(continuationPath(record.continuationId), record);
		rebuildContinuationsIndex();
		return record;
	}

	function createContinuation(record: OrchestratorContinuationRecord): OrchestratorContinuationRecord {
		return saveContinuation(record);
	}

	function updateContinuation(continuationId: string, patch: Partial<OrchestratorContinuationRecord>): OrchestratorContinuationRecord | undefined {
		const existing = getContinuation(continuationId);
		if (!existing) return undefined;
		return saveContinuation({ ...existing, ...patch, continuationId: existing.continuationId });
	}

	function listContinuations(): OrchestratorContinuationRecord[] {
		return loadContinuationsIndex().continuations
			.map((summary) => getContinuation(summary.continuationId))
			.filter((record): record is OrchestratorContinuationRecord => Boolean(record))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	function appendNodeLogRecord(childSessionId: string, record: Omit<OrchestratorNodeLogRecord, "cursor" | "childSessionId">): OrchestratorNodeLogRecord {
		ensureReady();
		const filePath = nodeLogPath(childSessionId);
		const cursor = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
		const entry: OrchestratorNodeLogRecord = {
			cursor: String(cursor),
			childSessionId,
			...record,
		};
		fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
		return entry;
	}

	function readNodeLog(childSessionId: string): OrchestratorNodeLogRecord[] {
		ensureReady();
		const filePath = nodeLogPath(childSessionId);
		if (!fs.existsSync(filePath)) return [];
		return parseJsonlBuffer(fs.readFileSync(filePath));
	}

	function readNodeLogSince(childSessionId: string, cursor?: string): { records: OrchestratorNodeLogRecord[]; cursor: string } {
		ensureReady();
		const filePath = nodeLogPath(childSessionId);
		if (!fs.existsSync(filePath)) return { records: [], cursor: "0" };
		const buffer = fs.readFileSync(filePath);
		const start = Math.min(parseCursor(cursor), buffer.length);
		return {
			records: parseJsonlBuffer(buffer, start),
			cursor: String(buffer.length),
		};
	}

	return {
		rootDir,
		runsDir,
		childSessionsDir,
		handbacksDir,
		continuationsDir,
		nodeLogsDir,
		runsIndexPath,
		childSessionsIndexPath,
		handbacksIndexPath,
		continuationsIndexPath,
		ensureReady,
		createRun,
		getRun,
		updateRun,
		listRuns,
		listOwnedRuns,
		listRunsByRootRunId,
		listTopLevelRunsByMode,
		getLatestTopLevelRunForMode,
		getOwnedRun,
		findRunByUnderlyingId,
		createChildSession,
		getChildSession,
		updateChildSession,
		listChildSessions,
		listChildSessionsByRun,
		listChildSessionsByRootRunId,
		findChildSessionByRunAndKey,
		findChildSessionByRunAndExecutionChildId,
		findChildSessionByExecutionChildId,
		createHandback,
		getHandback,
		updateHandback,
		listHandbacks,
		listHandbacksByRun,
		listQueuedHandbacks,
		markHandbackConsumed,
		markHandbackDismissed,
		createContinuation,
		getContinuation,
		updateContinuation,
		listContinuations,
		appendNodeLogRecord,
		readNodeLog,
		readNodeLogSince,
		loadRunsIndex,
		loadChildSessionsIndex,
		loadHandbacksIndex,
		loadContinuationsIndex,
		saveRunsIndex,
		saveChildSessionsIndex,
		saveHandbacksIndex,
		saveContinuationsIndex,
		rebuildRunsIndex,
		rebuildChildSessionsIndex,
		rebuildHandbacksIndex,
		rebuildContinuationsIndex,
	};
}

export type StateStore = ReturnType<typeof createStateStore>;

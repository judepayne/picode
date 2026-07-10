import * as fs from "node:fs";
import * as path from "node:path";

import { asyncRunDir, asyncRunManifestPath } from "../subagent-mode/paths.ts";
import { ASYNC_SCHEMA_VERSION, type AsyncRunManifest } from "../subagent-mode/types.ts";
import { buildPromptVars } from "../z-prompt-vars/prompt-vars.ts";
import type { StateStore } from "./state.ts";
import { isTerminal } from "./run-status.ts";
import type { OrchestratorRunRecord } from "./types.ts";

export const DEFAULT_RETENTION_MAX_AGE_DAYS = 30;
export const DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS = 100;
export const RETENTION_MAX_AGE_DAYS_VAR = "subagent.orchestrator.retention.maxAgeDays";
export const RETENTION_MAX_TOP_LEVEL_RUNS_VAR = "subagent.orchestrator.retention.maxTopLevelRuns";

const DAY_MS = 24 * 60 * 60 * 1000;
const ASYNC_CLEANUP_JOURNAL_FILE = "retention-async-cleanup.json";

interface AsyncCleanupEntry {
	rootRunId: string;
	underlyingRunId: string;
	dir: string;
}

interface AsyncCleanupJournal {
	version: 1;
	entries: AsyncCleanupEntry[];
}

export interface OrchestratorRetentionPolicy {
	maxAgeDays: number;
	maxTopLevelRuns: number;
	warnings: string[];
}

export interface OrchestratorRetentionSummary {
	checkedAt: number;
	policy: OrchestratorRetentionPolicy;
	examinedTopLevelRuns: number;
	terminalTopLevelRuns: number;
	protectedTopLevelRuns: number;
	prunedTopLevelRuns: number;
	prunedRuns: number;
	prunedChildSessions: number;
	prunedHandbacks: number;
	prunedContinuations: number;
	prunedNodeLogs: number;
	prunedAsyncDirs: number;
	skippedAsyncDirs: number;
	errors: string[];
}

export interface OrchestratorRetentionController {
	prune(cwd: string): OrchestratorRetentionSummary;
	schedule(cwd: string): void;
	getLastSummary(): OrchestratorRetentionSummary | undefined;
	dispose(): void;
}

export interface OrchestratorRetentionOptions {
	state: StateStore;
	getActiveRunIds?(): Iterable<string>;
	hasActiveAsyncTailer?(runId: string): boolean;
	now?(): number;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveOrchestratorRetentionPolicy(storedVars: Record<string, unknown>): OrchestratorRetentionPolicy {
	const warnings: string[] = [];
	const configuredAge = storedVars[RETENTION_MAX_AGE_DAYS_VAR];
	const configuredCount = storedVars[RETENTION_MAX_TOP_LEVEL_RUNS_VAR];
	const maxAgeDays = positiveInteger(configuredAge) ?? DEFAULT_RETENTION_MAX_AGE_DAYS;
	const maxTopLevelRuns = positiveInteger(configuredCount) ?? DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS;
	if (configuredAge !== undefined && positiveInteger(configuredAge) === undefined) {
		warnings.push(`${RETENTION_MAX_AGE_DAYS_VAR} must be a positive integer; using ${DEFAULT_RETENTION_MAX_AGE_DAYS}.`);
	}
	if (configuredCount !== undefined && positiveInteger(configuredCount) === undefined) {
		warnings.push(`${RETENTION_MAX_TOP_LEVEL_RUNS_VAR} must be a positive integer; using ${DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS}.`);
	}
	return { maxAgeDays, maxTopLevelRuns, warnings };
}

function rootRunId(run: Pick<OrchestratorRunRecord, "orchestratorRunId" | "rootRunId">): string {
	return run.rootRunId ?? run.orchestratorRunId;
}

function terminalTime(run: OrchestratorRunRecord): number {
	return run.completedAt ?? run.updatedAt ?? run.launchedAt;
}

function readOwnedAsyncManifest(run: OrchestratorRunRecord): { dir: string; manifest: AsyncRunManifest } | undefined {
	if (!run.async || !run.asyncDir || !run.underlyingRunId || path.basename(run.underlyingRunId) !== run.underlyingRunId) return undefined;
	const expectedDir = path.resolve(asyncRunDir(run.underlyingRunId));
	if (path.resolve(run.asyncDir) !== expectedDir) return undefined;
	try {
		const stat = fs.lstatSync(expectedDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
		const manifest = JSON.parse(fs.readFileSync(asyncRunManifestPath(run.underlyingRunId), "utf8")) as AsyncRunManifest;
		if (
			manifest.schemaVersion !== ASYNC_SCHEMA_VERSION
			|| manifest.runId !== run.underlyingRunId
			|| manifest.topLevelRunId !== run.underlyingRunId
		) return undefined;
		return { dir: expectedDir, manifest };
	} catch {
		return undefined;
	}
}

function readAsyncCleanupJournal(state: StateStore): AsyncCleanupJournal {
	const filePath = path.join(state.rootDir, ASYNC_CLEANUP_JOURNAL_FILE);
	if (!fs.existsSync(filePath)) return { version: 1, entries: [] };
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AsyncCleanupJournal>;
	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error(`Invalid async cleanup journal ${filePath}.`);
	const entries = parsed.entries.filter((entry): entry is AsyncCleanupEntry => Boolean(
		entry
		&& typeof entry.rootRunId === "string"
		&& typeof entry.underlyingRunId === "string"
		&& typeof entry.dir === "string",
	));
	if (entries.length !== parsed.entries.length) throw new Error(`Invalid async cleanup journal entry in ${filePath}.`);
	return { version: 1, entries };
}

function writeAsyncCleanupJournal(state: StateStore, journal: AsyncCleanupJournal): void {
	const filePath = path.join(state.rootDir, ASYNC_CLEANUP_JOURNAL_FILE);
	if (journal.entries.length === 0) {
		fs.rmSync(filePath, { force: true });
		return;
	}
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
	fs.renameSync(tmpPath, filePath);
}

function validJournalEntry(entry: AsyncCleanupEntry): boolean {
	return path.basename(entry.underlyingRunId) === entry.underlyingRunId
		&& path.resolve(entry.dir) === path.resolve(asyncRunDir(entry.underlyingRunId));
}

function selectPrunableRootIds(
	state: StateStore,
	policy: OrchestratorRetentionPolicy,
	now: number,
	activeRunIds: Iterable<string>,
	hasActiveAsyncTailer: (runId: string) => boolean,
): { rootIds: string[]; examined: number; terminal: number; protected: number; allRuns: OrchestratorRunRecord[] } {
	const allRuns = state.listRuns();
	const allChildren = state.listChildSessions();
	const handbacks = state.listHandbacks();
	const continuations = state.listContinuations();
	const runsById = new Map(allRuns.map((run) => [run.orchestratorRunId, run]));
	const handbacksById = new Map(handbacks.map((handback) => [handback.handbackId, handback]));
	const trees = new Map<string, OrchestratorRunRecord[]>();
	for (const run of allRuns) {
		const id = rootRunId(run);
		const entries = trees.get(id) ?? [];
		entries.push(run);
		trees.set(id, entries);
	}
	const topLevelRuns = allRuns.filter((run) => !run.parentRunId && !run.parentChildSessionId && rootRunId(run) === run.orchestratorRunId);
	const rootForRunId = (runId: string): string | undefined => {
		const run = runsById.get(runId);
		return run ? rootRunId(run) : undefined;
	};
	const protectedRoots = new Set<string>();
	for (const [id, treeRuns] of trees) {
		if (
			treeRuns.some((run) => !isTerminal(run.status) || run.terminalStatusNotifiedAt === undefined || (run.status === "failed" && run.failureAcknowledgedAt === undefined))
			|| allChildren.some((child) => (child.rootRunId ?? child.runId) === id && !isTerminal(child.status))
			|| treeRuns.some((run) => hasActiveAsyncTailer(run.orchestratorRunId))
		) protectedRoots.add(id);
	}
	for (const runId of activeRunIds) {
		const id = rootForRunId(runId);
		if (id) protectedRoots.add(id);
	}
	for (const handback of handbacks) {
		if (handback.status !== "queued") continue;
		const id = rootForRunId(handback.runId);
		if (id) protectedRoots.add(id);
	}
	// queued/deferred continuations have not been dispatched. "launched" means
	// dispatch already happened and is therefore historical for retention.
	for (const continuation of continuations) {
		if (continuation.status !== "queued" && continuation.status !== "deferred") continue;
		for (const handbackId of continuation.handbackIds) {
			const handback = handbacksById.get(handbackId);
			const id = handback ? rootForRunId(handback.runId) : undefined;
			if (id) protectedRoots.add(id);
		}
	}
	const terminalRoots = topLevelRuns
		.filter((run) => isTerminal(run.status) && (trees.get(run.orchestratorRunId) ?? []).every((entry) => isTerminal(entry.status)))
		.sort((a, b) => terminalTime(b) - terminalTime(a) || a.orchestratorRunId.localeCompare(b.orchestratorRunId));
	const cutoff = now - policy.maxAgeDays * DAY_MS;
	const candidates = new Set(terminalRoots
		.filter((run, index) => !protectedRoots.has(run.orchestratorRunId) && (terminalTime(run) < cutoff || index >= policy.maxTopLevelRuns))
		.map((run) => run.orchestratorRunId));

	// Historical continuation batches may span multiple roots. Prune the linked
	// roots together or not at all so no durable continuation becomes dangling.
	let changed = true;
	while (changed) {
		changed = false;
		for (const continuation of continuations) {
			const linkedRoots = new Set(continuation.handbackIds
				.map((id) => handbacksById.get(id))
				.map((handback) => handback ? rootForRunId(handback.runId) : undefined)
				.filter((id): id is string => Boolean(id)));
			if (![...linkedRoots].some((id) => candidates.has(id)) || [...linkedRoots].every((id) => candidates.has(id))) continue;
			for (const id of linkedRoots) {
				if (candidates.delete(id)) changed = true;
			}
		}
	}
	return {
		rootIds: [...candidates],
		examined: topLevelRuns.length,
		terminal: terminalRoots.length,
		protected: [...protectedRoots].filter((id) => trees.has(id)).length,
		allRuns,
	};
}

export function formatOrchestratorRetentionSummary(summary: OrchestratorRetentionSummary): string {
	const issues = [
		summary.policy.warnings.length > 0 ? `${summary.policy.warnings.length} config warning(s)` : undefined,
		summary.skippedAsyncDirs > 0 ? `${summary.skippedAsyncDirs} async dir(s) skipped` : undefined,
		summary.errors.length > 0 ? `${summary.errors.length} error(s)` : undefined,
	].filter(Boolean);
	return `Retention: ${summary.policy.maxAgeDays}d / ${summary.policy.maxTopLevelRuns} top-level terminal runs; last check pruned ${summary.prunedTopLevelRuns} trees, ${summary.prunedRuns} runs, ${summary.prunedChildSessions} children, ${summary.prunedNodeLogs} logs, ${summary.prunedAsyncDirs} async dirs; protected ${summary.protectedTopLevelRuns}${issues.length > 0 ? `; ${issues.join(", ")}` : ""}.`;
}

export function createOrchestratorRetentionController(options: OrchestratorRetentionOptions): OrchestratorRetentionController {
	let lastSummary: OrchestratorRetentionSummary | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let scheduledCwd: string | undefined;

	function prune(cwd: string): OrchestratorRetentionSummary {
		const checkedAt = options.now?.() ?? Date.now();
		let policy: OrchestratorRetentionPolicy;
		try {
			policy = resolveOrchestratorRetentionPolicy(buildPromptVars(cwd).storedVars);
		} catch (error) {
			policy = {
				maxAgeDays: DEFAULT_RETENTION_MAX_AGE_DAYS,
				maxTopLevelRuns: DEFAULT_RETENTION_MAX_TOP_LEVEL_RUNS,
				warnings: [`Failed to read retention configuration; using defaults: ${error instanceof Error ? error.message : String(error)}`],
			};
		}
		try {
			const selected = selectPrunableRootIds(
				options.state,
				policy,
				checkedAt,
				options.getActiveRunIds?.() ?? [],
				options.hasActiveAsyncTailer ?? (() => false),
			);
			const candidateSet = new Set(selected.rootIds);
			const retainedAsyncDirs = new Set(selected.allRuns
				.filter((run) => !candidateSet.has(rootRunId(run)) && run.asyncDir)
				.map((run) => path.resolve(run.asyncDir!)));
			const journal = readAsyncCleanupJournal(options.state);
			let skippedAsyncDirs = 0;
			for (const run of selected.allRuns.filter((entry) => candidateSet.has(rootRunId(entry)))) {
				if (!run.asyncDir) continue;
				const owned = readOwnedAsyncManifest(run);
				if (!owned || retainedAsyncDirs.has(owned.dir) || options.hasActiveAsyncTailer?.(run.orchestratorRunId)) {
					skippedAsyncDirs += 1;
					continue;
				}
				if (!journal.entries.some((entry) => entry.rootRunId === rootRunId(run) && entry.dir === owned.dir)) {
					journal.entries.push({ rootRunId: rootRunId(run), underlyingRunId: run.underlyingRunId!, dir: owned.dir });
				}
			}
			writeAsyncCleanupJournal(options.state, journal);
			const pendingEntries: AsyncCleanupEntry[] = [];
			const cleanedEntries: AsyncCleanupEntry[] = [];
			const failedCleanupRoots = new Set<string>();
			const errors: string[] = [];
			let prunedAsyncDirs = 0;
			for (const entry of journal.entries) {
				const rootStillExists = Boolean(options.state.getRun(entry.rootRunId));
				if (rootStillExists && !candidateSet.has(entry.rootRunId)) {
					pendingEntries.push(entry);
					continue;
				}
				if (!validJournalEntry(entry)) {
					pendingEntries.push(entry);
					failedCleanupRoots.add(entry.rootRunId);
					errors.push(`Refused invalid async cleanup journal entry for root ${entry.rootRunId}.`);
					continue;
				}
				try {
					if (fs.existsSync(entry.dir)) {
						fs.rmSync(entry.dir, { recursive: true, force: true });
						prunedAsyncDirs += 1;
					}
					cleanedEntries.push(entry);
				} catch (error) {
					pendingEntries.push(entry);
					failedCleanupRoots.add(entry.rootRunId);
					errors.push(`Failed to prune async directory ${entry.dir}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			// Keep proven ownership journaled until the corresponding durable root is
			// gone. If state deletion fails, the next pass can finish the transaction.
			writeAsyncCleanupJournal(options.state, { version: 1, entries: [...pendingEntries, ...cleanedEntries] });
			const deletableRootIds = selected.rootIds.filter((rootId) => !failedCleanupRoots.has(rootId));
			const deleted = options.state.deleteRunTrees(deletableRootIds);
			errors.push(...deleted.errors);
			writeAsyncCleanupJournal(options.state, {
				version: 1,
				entries: [
					...pendingEntries,
					...cleanedEntries.filter((entry) => Boolean(options.state.getRun(entry.rootRunId))),
				],
			});
			skippedAsyncDirs += pendingEntries.filter((entry) => candidateSet.has(entry.rootRunId)).length;
			lastSummary = {
				checkedAt,
				policy,
				examinedTopLevelRuns: selected.examined,
				terminalTopLevelRuns: selected.terminal,
				protectedTopLevelRuns: selected.protected,
				prunedTopLevelRuns: deleted.rootRuns,
				prunedRuns: deleted.runs,
				prunedChildSessions: deleted.childSessions,
				prunedHandbacks: deleted.handbacks,
				prunedContinuations: deleted.continuations,
				prunedNodeLogs: deleted.nodeLogs,
				prunedAsyncDirs,
				skippedAsyncDirs,
				errors,
			};
		} catch (error) {
			lastSummary = {
				checkedAt,
				policy,
				examinedTopLevelRuns: 0,
				terminalTopLevelRuns: 0,
				protectedTopLevelRuns: 0,
				prunedTopLevelRuns: 0,
				prunedRuns: 0,
				prunedChildSessions: 0,
				prunedHandbacks: 0,
				prunedContinuations: 0,
				prunedNodeLogs: 0,
				prunedAsyncDirs: 0,
				skippedAsyncDirs: 0,
				errors: [`Retention check failed safely: ${error instanceof Error ? error.message : String(error)}`],
			};
		}
		return lastSummary;
	}

	function schedule(cwd: string): void {
		scheduledCwd = cwd;
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			const nextCwd = scheduledCwd;
			scheduledCwd = undefined;
			if (nextCwd) prune(nextCwd);
		}, 0);
		timer.unref?.();
	}

	return {
		prune,
		schedule,
		getLastSummary: () => lastSummary,
		dispose() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			scheduledCwd = undefined;
		},
	};
}

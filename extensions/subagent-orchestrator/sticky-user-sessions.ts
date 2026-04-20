import { sessionReferenceInLineage, type SessionLineage } from "./session-lineage.ts";

export interface StickyUserSubagentSession {
	agent: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	sessionFile?: string;
	childSessionId?: string;
	activeRunId?: string;
	createdAt: number;
	lastUsedAt: number;
}

function matchesLineage(entry: StickyUserSubagentSession, lineage: SessionLineage): boolean {
	return sessionReferenceInLineage(entry.parentSessionFile, lineage)
		|| sessionReferenceInLineage(entry.parentSessionId, lineage);
}

export function findStickyUserSubagentSessionIndex(
	entries: readonly StickyUserSubagentSession[],
	agent: string,
	lineage: SessionLineage,
): number {
	let bestIndex = -1;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.agent !== agent) continue;
		if (!matchesLineage(entry, lineage)) continue;
		if (bestIndex < 0) {
			bestIndex = index;
			continue;
		}
		const best = entries[bestIndex]!;
		if (entry.lastUsedAt > best.lastUsedAt || (entry.lastUsedAt === best.lastUsedAt && entry.createdAt > best.createdAt)) {
			bestIndex = index;
		}
	}
	return bestIndex;
}

export function findStickyUserSubagentSession(
	entries: readonly StickyUserSubagentSession[],
	agent: string,
	lineage: SessionLineage,
): StickyUserSubagentSession | undefined {
	const index = findStickyUserSubagentSessionIndex(entries, agent, lineage);
	return index >= 0 ? entries[index] : undefined;
}

export function upsertStickyUserSubagentSession(
	entries: readonly StickyUserSubagentSession[],
	lineage: SessionLineage,
	next: StickyUserSubagentSession,
): StickyUserSubagentSession[] {
	const index = findStickyUserSubagentSessionIndex(entries, next.agent, lineage);
	if (index < 0) return [...entries, next];
	const existing = entries[index]!;
	const merged: StickyUserSubagentSession = {
		...existing,
		...next,
		parentSessionId: existing.parentSessionId,
		parentSessionFile: existing.parentSessionFile,
		createdAt: existing.createdAt,
	};
	return entries.map((entry, entryIndex) => entryIndex === index ? merged : entry);
}

export function updateStickyUserSubagentSessionByRun(
	entries: readonly StickyUserSubagentSession[],
	runId: string,
	patch: Partial<StickyUserSubagentSession>,
): StickyUserSubagentSession[] {
	return entries.map((entry) => entry.activeRunId === runId ? { ...entry, ...patch } : entry);
}

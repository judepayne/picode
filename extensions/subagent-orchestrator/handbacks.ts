import { randomUUID } from "node:crypto";
import type {
	AsyncCompleteEvent,
	OrchestratorChildSessionRecord,
	OrchestratorHandbackRecord,
	OrchestratorRunRecord,
	ProgrammaticResultEntry,
} from "./types.ts";

export interface ChildResultPayload {
	childIndex: number;
	agent?: string;
	output?: string;
	finalOutput?: string;
	success?: boolean;
	sessionFile?: string;
}

function firstMeaningfulText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

export function normalizeHandbackText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function summarizeHandbackText(text: string, maxLength = 180): string {
	const normalized = normalizeHandbackText(text);
	if (!normalized) return "Background handback available.";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildHandbackDeduplicationKey(input: Pick<OrchestratorHandbackRecord, "runId" | "childSessionIds" | "content">): string {
	return [
		input.runId,
		[...input.childSessionIds].sort().join(","),
		normalizeHandbackText(input.content),
	].join("::");
}

function handbackStatusPriority(status: OrchestratorHandbackRecord["status"]): number {
	switch (status) {
		case "consumed": return 0;
		case "queued": return 1;
		case "dismissed": return 2;
	}
}

export function partitionHandbackDuplicates<T extends Pick<OrchestratorHandbackRecord, "runId" | "childSessionIds" | "content" | "createdAt" | "status">>(records: T[]): {
	unique: T[];
	duplicates: T[];
} {
	const groups = new Map<string, T[]>();
	for (const record of records) {
		const key = buildHandbackDeduplicationKey(record);
		const existing = groups.get(key) ?? [];
		existing.push(record);
		groups.set(key, existing);
	}
	const unique: T[] = [];
	const duplicates: T[] = [];
	for (const group of groups.values()) {
		const sorted = [...group].sort((a, b) => {
			const priorityDelta = handbackStatusPriority(a.status) - handbackStatusPriority(b.status);
			if (priorityDelta !== 0) return priorityDelta;
			return a.createdAt - b.createdAt;
		});
		const [keep, ...rest] = sorted;
		if (keep) unique.push(keep);
		duplicates.push(...rest);
	}
	return {
		unique: unique.sort((a, b) => a.createdAt - b.createdAt),
		duplicates: duplicates.sort((a, b) => a.createdAt - b.createdAt),
	};
}

export function extractChildResultPayloads(results: ProgrammaticResultEntry[] | undefined): ChildResultPayload[] {
	return (results ?? []).map((result, childIndex) => ({
		childIndex,
		agent: firstMeaningfulText(result.agent),
		output: firstMeaningfulText(result.output),
		finalOutput: firstMeaningfulText(result.finalOutput),
		success: typeof result.success === "boolean" ? result.success : undefined,
		sessionFile: firstMeaningfulText(result.sessionFile),
	}));
}

export function formatQueuedHandbackContent(
	run: OrchestratorRunRecord,
	children: OrchestratorChildSessionRecord[],
	results: ChildResultPayload[],
	fallbackSummary?: string,
): string {
	const sections = children.map((child) => {
		const result = results[child.childIndex];
		const body = result?.output ?? result?.finalOutput ?? child.finalAnswer ?? child.resultSummary ?? fallbackSummary ?? "No final output was captured.";
		return body.trim();
	}).filter(Boolean);
	return sections.join("\n\n").trim();
}

export function buildQueuedHandback(
	run: OrchestratorRunRecord,
	children: OrchestratorChildSessionRecord[],
	event: AsyncCompleteEvent,
	now: number,
): OrchestratorHandbackRecord | undefined {
	if (event.cancelled || event.status === "cancelled") return undefined;
	const results = extractChildResultPayloads(event.results);
	const content = formatQueuedHandbackContent(run, children, results, event.summary);
	return {
		handbackId: randomUUID(),
		runId: run.orchestratorRunId,
		ownerModeId: run.ownerModeId,
		parentSessionId: run.parentSessionId ?? children[0]?.parentSessionId ?? "unknown-session",
		childSessionIds: children.map((child) => child.childSessionId),
		consumer: run.origin === "user" ? "user" : "agent",
		agent: run.agent ?? children[0]?.agent,
		status: "queued",
		content,
		summary: summarizeHandbackText(content || event.summary || run.taskSummary),
		batchId: run.orchestratorRunId,
		createdAt: now,
		updatedAt: now,
	};
}

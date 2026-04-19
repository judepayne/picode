import type { OrchestratorRunMessageDetails } from "./types.ts";

export const ORCHESTRATOR_RUN_MESSAGE_TYPE = "subagent-orchestrator-run";

interface RunSnapshot {
	details: OrchestratorRunMessageDetails;
	version: number;
}

const snapshots = new Map<string, RunSnapshot>();
let versionCounter = 1;

function nextVersion(): number {
	return versionCounter++;
}

function isRunMessageDetails(value: unknown): value is OrchestratorRunMessageDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { runId?: unknown; children?: unknown; status?: unknown; taskSummary?: unknown };
	return typeof candidate.runId === "string"
		&& candidate.runId.length > 0
		&& Array.isArray(candidate.children)
		&& typeof candidate.status === "string"
		&& typeof candidate.taskSummary === "string";
}

export function resolveRunMessageDetails(value: unknown): OrchestratorRunMessageDetails | undefined {
	return isRunMessageDetails(value) ? value : undefined;
}

export function rememberRunMessageDetails(details: OrchestratorRunMessageDetails): OrchestratorRunMessageDetails {
	snapshots.set(details.runId, { details, version: nextVersion() });
	return details;
}

export function getRenderableRunSnapshot(details: OrchestratorRunMessageDetails): RunSnapshot {
	return snapshots.get(details.runId) ?? { details, version: 0 };
}

export function restoreRunMessageSnapshots(entries: unknown[]): void {
	snapshots.clear();
	for (const entry of entries) {
		const candidate = entry as { type?: string; message?: { role?: string; customType?: string; details?: unknown } };
		if (candidate?.type !== "message") continue;
		const message = candidate.message;
		if (!message || message.role !== "custom" || message.customType !== ORCHESTRATOR_RUN_MESSAGE_TYPE) continue;
		const details = resolveRunMessageDetails(message.details);
		if (!details) continue;
		rememberRunMessageDetails(details);
	}
}

export function clearRunMessageSnapshots(): void {
	snapshots.clear();
}

import type { OrchestratorRunMessageDetails } from "./types.ts";

export const ORCHESTRATOR_RUN_MESSAGE_TYPE = "subagent-orchestrator-run";

export interface RunSnapshot {
	details: OrchestratorRunMessageDetails;
	version: number;
}

export interface RunMessageSnapshotStore {
	remember(details: OrchestratorRunMessageDetails): OrchestratorRunMessageDetails;
	get(details: OrchestratorRunMessageDetails): RunSnapshot;
	restore(entries: unknown[]): void;
	clear(): void;
}

export function isRunMessageDetails(value: unknown): value is OrchestratorRunMessageDetails {
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

export function createRunMessageSnapshotStore(): RunMessageSnapshotStore {
	const snapshots = new Map<string, RunSnapshot>();
	let versionCounter = 1;
	return {
		remember(details) {
			snapshots.set(details.runId, { details, version: versionCounter++ });
			return details;
		},
		get(details) {
			return snapshots.get(details.runId) ?? { details, version: 0 };
		},
		restore(entries) {
			snapshots.clear();
			for (const entry of entries) {
				const candidate = entry as { type?: string; message?: { role?: string; customType?: string; details?: unknown } };
				if (candidate?.type !== "message") continue;
				const message = candidate.message;
				if (!message || message.role !== "custom" || message.customType !== ORCHESTRATOR_RUN_MESSAGE_TYPE) continue;
				const details = resolveRunMessageDetails(message.details);
				if (details) this.remember(details);
			}
		},
		clear() { snapshots.clear(); },
	};
}

// Renderers are process-level registrations, so route them through an ownership token
// while keeping the historical value exports intact.
let activeStore: { token: symbol; store: RunMessageSnapshotStore } | undefined;
const fallbackStore = createRunMessageSnapshotStore();
export function activateRunMessageSnapshotStore(store: RunMessageSnapshotStore): () => void {
	const token = Symbol("run-message-snapshots");
	activeStore = { token, store };
	return () => { if (activeStore?.token === token) activeStore = undefined; };
}
function store(): RunMessageSnapshotStore { return activeStore?.store ?? fallbackStore; }
export function rememberRunMessageDetails(details: OrchestratorRunMessageDetails) { return store().remember(details); }
export function getRenderableRunSnapshot(details: OrchestratorRunMessageDetails) { return store().get(details); }
export function restoreRunMessageSnapshots(entries: unknown[]) { store().restore(entries); }
export function clearRunMessageSnapshots() { store().clear(); }

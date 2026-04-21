export const COLLECT_AGENT_ASSET_FILES_EVENT = "picode:collect-asset-files";

export type AgentAssetKind = "agent" | "subagent";
export type AgentAssetOrigin = "native" | "user";
export type AgentAssetDiagnosticSeverity = "warning" | "error";

export interface AgentAssetFile {
	kind: AgentAssetKind;
	filePath: string;
	fileName: string;
	origin: AgentAssetOrigin;
	shadowedFilePath?: string;
}

export interface AgentAssetDiagnostic {
	severity: AgentAssetDiagnosticSeverity;
	message: string;
	filePath?: string;
}

export interface AgentAssetFileEntry {
	source: string;
	priority?: number;
	agents?: AgentAssetFile[];
	subagents?: AgentAssetFile[];
	diagnostics?: AgentAssetDiagnostic[];
}

export interface CollectAgentAssetFilesRequest {
	entries: AgentAssetFileEntry[];
}

interface EventEmitterLike {
	emit(event: string, data: unknown): void;
}

interface PiLike {
	events: EventEmitterLike;
}

export function collectAgentAssetFileEntries(pi: PiLike): AgentAssetFileEntry[] {
	const request: CollectAgentAssetFilesRequest = { entries: [] };
	pi.events.emit(COLLECT_AGENT_ASSET_FILES_EVENT, request);
	return [...request.entries].sort((a, b) => {
		const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
		if (priorityDiff !== 0) return priorityDiff;
		return a.source.localeCompare(b.source);
	});
}

function flattenUniqueFiles(entries: AgentAssetFileEntry[], key: AgentAssetKind): AgentAssetFile[] {
	const seen = new Set<string>();
	const out: AgentAssetFile[] = [];
	for (const entry of entries) {
		const files = key === "agent" ? entry.agents : entry.subagents;
		for (const file of files ?? []) {
			if (seen.has(file.filePath)) continue;
			seen.add(file.filePath);
			out.push(file);
		}
	}
	return out;
}

export function collectAgentFiles(pi: PiLike): AgentAssetFile[] {
	return flattenUniqueFiles(collectAgentAssetFileEntries(pi), "agent");
}

export function collectSubagentFiles(pi: PiLike): AgentAssetFile[] {
	return flattenUniqueFiles(collectAgentAssetFileEntries(pi), "subagent");
}

export function collectAgentAssetDiagnostics(pi: PiLike): AgentAssetDiagnostic[] {
	const diagnostics: AgentAssetDiagnostic[] = [];
	for (const entry of collectAgentAssetFileEntries(pi)) {
		for (const diagnostic of entry.diagnostics ?? []) {
			diagnostics.push(diagnostic);
		}
	}
	return diagnostics;
}

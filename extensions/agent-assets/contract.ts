export const COLLECT_AGENT_ASSET_DIRS_EVENT = "picode:collect-asset-dirs";

export interface AgentAssetDirEntry {
	source: string;
	priority?: number;
	agentsDir?: string;
	subagentsDir?: string;
}

export interface CollectAgentAssetDirsRequest {
	entries: AgentAssetDirEntry[];
}

interface EventEmitterLike {
	emit(event: string, data: unknown): void;
}

interface PiLike {
	events: EventEmitterLike;
}

export function collectAgentAssetDirEntries(pi: PiLike): AgentAssetDirEntry[] {
	const request: CollectAgentAssetDirsRequest = { entries: [] };
	pi.events.emit(COLLECT_AGENT_ASSET_DIRS_EVENT, request);
	return [...request.entries].sort((a, b) => {
		const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
		if (priorityDiff !== 0) return priorityDiff;
		return a.source.localeCompare(b.source);
	});
}

export function collectAgentsDirs(pi: PiLike): string[] {
	return [...new Set(
		collectAgentAssetDirEntries(pi)
			.map((entry) => entry.agentsDir)
			.filter((value): value is string => typeof value === "string" && value.length > 0),
	)];
}

export function collectSubagentsDirs(pi: PiLike): string[] {
	return [...new Set(
		collectAgentAssetDirEntries(pi)
			.map((entry) => entry.subagentsDir)
			.filter((value): value is string => typeof value === "string" && value.length > 0),
	)];
}

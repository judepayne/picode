import { unquote } from "./frontmatter-values.ts";

export const COLLECT_AGENT_ASSET_CARDS_EVENT = "picode:collect-asset-cards";

export type AgentAssetKind = "agent" | "subagent";
export type AgentAssetCard = Record<string, string>;
export type AgentAssetDiagnosticSeverity = "warning" | "error";

export interface AgentAssetDiagnostic {
	severity: AgentAssetDiagnosticSeverity;
	message: string;
	filePath?: string;
}

export interface AgentAssetCardEntry {
	source: string;
	priority?: number;
	agents?: AgentAssetCard[];
	subagents?: AgentAssetCard[];
	diagnostics?: AgentAssetDiagnostic[];
}

export interface CollectAgentAssetCardsRequest {
	entries: AgentAssetCardEntry[];
}

export interface AgentAssetSnapshot {
	entries: AgentAssetCardEntry[];
	agents: AgentAssetCard[];
	subagents: AgentAssetCard[];
	diagnostics: AgentAssetDiagnostic[];
}

interface EventEmitterLike {
	emit(event: string, data: unknown): void;
}

interface PiLike {
	events: EventEmitterLike;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "mode";
}

function normalizedCardName(card: AgentAssetCard, _kind: AgentAssetKind): string | undefined {
	const name = card.name ? unquote(card.name).trim() : "";
	if (!name) return undefined;
	return slugify(name);
}

export function collectAgentAssetCardEntries(pi: PiLike): AgentAssetCardEntry[] {
	const request: CollectAgentAssetCardsRequest = { entries: [] };
	pi.events.emit(COLLECT_AGENT_ASSET_CARDS_EVENT, request);
	return [...request.entries].sort((a, b) => {
		const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
		if (priorityDiff !== 0) return priorityDiff;
		return a.source.localeCompare(b.source);
	});
}

function flattenUniqueCards(entries: AgentAssetCardEntry[], kind: AgentAssetKind): AgentAssetCard[] {
	const seen = new Set<string>();
	const out: AgentAssetCard[] = [];
	for (const entry of entries) {
		const cards = kind === "agent" ? entry.agents : entry.subagents;
		for (const card of cards ?? []) {
			const name = normalizedCardName(card, kind);
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push(card);
		}
	}
	return out;
}

export function collectAgentAssetSnapshot(pi: PiLike): AgentAssetSnapshot {
	const entries = collectAgentAssetCardEntries(pi);
	const diagnostics: AgentAssetDiagnostic[] = [];
	for (const entry of entries) {
		for (const diagnostic of entry.diagnostics ?? []) diagnostics.push(diagnostic);
	}
	return {
		entries,
		agents: flattenUniqueCards(entries, "agent"),
		subagents: flattenUniqueCards(entries, "subagent"),
		diagnostics,
	};
}

export function collectAgentCards(pi: PiLike): AgentAssetCard[] {
	return collectAgentAssetSnapshot(pi).agents;
}

export function collectSubagentCards(pi: PiLike): AgentAssetCard[] {
	return collectAgentAssetSnapshot(pi).subagents;
}

export function collectAgentAssetDiagnostics(pi: PiLike): AgentAssetDiagnostic[] {
	return collectAgentAssetSnapshot(pi).diagnostics;
}

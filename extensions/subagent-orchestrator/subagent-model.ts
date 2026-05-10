import type { AgentAssetCard } from "../agent-assets/contract.ts";
import { normalizeOptionalFrontmatterString, unquote } from "../agent-assets/frontmatter-values.ts";
import { parseToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { findNamedAgentCard } from "./agent-card-lookup.ts";

interface ModelLike {
	provider?: unknown;
	id?: unknown;
	modelID?: unknown;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function parseStringList(value: string | undefined): string[] | undefined {
	const normalized = normalizeString(value);
	if (!normalized) return undefined;
	const unquoted = unquote(normalized);
	if (!unquoted || unquoted === "-") return undefined;
	const list = unquoted.startsWith("[") && unquoted.endsWith("]") ? unquoted.slice(1, -1) : unquoted;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of list.split(",")) {
		const item = unquote(entry).trim();
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function readNamedAgentAttributeFromCards(cards: readonly AgentAssetCard[], id: string, attribute: string): string | undefined {
	const card = findNamedAgentCard(cards, id);
	return normalizeOptionalFrontmatterString(card?.[attribute]);
}

export function normalizeThinkingLevel(value: string | undefined): string | undefined {
	const normalized = normalizeString(value)?.toLowerCase();
	return normalized && THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

export function readNamedAgentModelFromCards(cards: readonly AgentAssetCard[], id: string): string | undefined {
	return readNamedAgentAttributeFromCards(cards, id, "model");
}

export function readNamedAgentThinkingFromCards(cards: readonly AgentAssetCard[], id: string): string | undefined {
	return normalizeThinkingLevel(readNamedAgentAttributeFromCards(cards, id, "thinking"));
}

export function readNamedAgentToolSelectionFromCards(cards: readonly AgentAssetCard[], id: string): ToolSelectionSpec | undefined {
	const card = findNamedAgentCard(cards, id);
	if (!card) return undefined;
	return parseToolSelection({ tools: card.tools, banTools: card.ban_tools });
}

export function readNamedAgentToolsFromCards(cards: readonly AgentAssetCard[], id: string): string[] | undefined {
	const selection = readNamedAgentToolSelectionFromCards(cards, id);
	if (!selection) return undefined;
	if (selection.toolsMode === "list") return selection.tools;
	if (selection.toolsMode === "all") return ["all"];
	return undefined;
}

export function readNamedAgentExtensionPathsFromCards(cards: readonly AgentAssetCard[], id: string): string[] | undefined {
	const card = findNamedAgentCard(cards, id);
	return parseStringList(card?.extensions);
}

export function readNamedAgentPromptFromCards(cards: readonly AgentAssetCard[], id: string): string | undefined {
	const card = findNamedAgentCard(cards, id);
	return card?.prompt?.trim() || undefined;
}

export function formatModelReference(model: ModelLike | undefined): string | undefined {
	const provider = normalizeString(model?.provider);
	const id = normalizeString(model?.id) ?? normalizeString(model?.modelID);
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

import type { AgentAssetCard } from "../agent-assets/contract.ts";
import { unquote } from "../agent-assets/frontmatter-values.ts";

export function slugifyCardName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "mode";
}

function normalizeLookupToken(value: string): string {
	return value.trim().toLowerCase();
}

export function findNamedAgentCard(cards: readonly AgentAssetCard[], id: string): AgentAssetCard | undefined {
	const normalizedId = normalizeLookupToken(id);
	if (!normalizedId) return undefined;

	for (const card of cards) {
		const name = card.name ? unquote(card.name).trim() : "";
		if (!name) continue;
		const normalizedName = normalizeLookupToken(name);
		if (normalizedName === normalizedId || slugifyCardName(name) === normalizedId) return card;
	}

	return undefined;
}

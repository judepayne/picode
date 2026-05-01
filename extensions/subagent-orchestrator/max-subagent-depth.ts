import type { AgentAssetCard } from "../agent-assets/contract.ts";
import { currentSubagentDepth, normalizeMaxSubagentDepth, resolveCurrentMaxSubagentDepth } from "../subagent-mode/depth.ts";
import { findNamedAgentCard } from "./agent-card-lookup.ts";

export function readNamedAgentMaxSubagentDepthFromCards(cards: readonly AgentAssetCard[], id: string): number | undefined {
	const card = findNamedAgentCard(cards, id);
	return normalizeMaxSubagentDepth(card?.maxSubagentDepth);
}

export interface ResolveDelegatedRunMaxSubagentDepthInput {
	parentModeMaxSubagentDepth?: number;
	childAgentMaxSubagentDepth?: number;
	currentDepth?: number;
}

/**
 * Convert relative frontmatter settings into the absolute depth ceiling consumed
 * by subagent-mode.
 *
 * Semantics:
 * - parent mode config: how many subagent levels may exist below the current agent
 * - child subagent config: how many subagent levels may exist below that child
 * - inherited PI_SUBAGENT_MAX_DEPTH always wins over a looser parent mode config
 * - the effective ceiling is the stricter of the inherited/parent ceiling and
 *   the child agent's own ceiling
 */
export function resolveDelegatedRunMaxSubagentDepth(input: ResolveDelegatedRunMaxSubagentDepthInput = {}): number {
	const currentDepth = input.currentDepth ?? currentSubagentDepth();
	const normalizedParent = normalizeMaxSubagentDepth(input.parentModeMaxSubagentDepth);
	const parentAbsoluteCeiling = resolveCurrentMaxSubagentDepth(
		normalizedParent === undefined ? undefined : currentDepth + normalizedParent,
	);

	const normalizedChild = normalizeMaxSubagentDepth(input.childAgentMaxSubagentDepth);
	if (normalizedChild === undefined) return parentAbsoluteCeiling;

	const childAbsoluteCeiling = currentDepth + normalizedChild + 1;
	return Math.min(parentAbsoluteCeiling, childAbsoluteCeiling);
}

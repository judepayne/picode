/**
 * Depth enforcement and identity-propagation env helpers.
 *
 * Env contract:
 *   PI_SUBAGENT_DEPTH             — current nesting depth (0 = top level)
 *   PI_SUBAGENT_MAX_DEPTH         — ceiling; runner refuses to spawn when depth >= max
 *   PI_SUBAGENT_TOP_RUN_ID        — root run id, propagated unchanged through nesting
 *   PI_SUBAGENT_PARENT_CHILD_ID   — direct parent child id for grandchild lineage
 *
 * Depth algorithm ported from agent/extensions/pi-subagents/types.ts:409-441
 * so async state remains discoverable across the cutover.
 */

export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export const ENV_DEPTH = "PI_SUBAGENT_DEPTH";
export const ENV_MAX_DEPTH = "PI_SUBAGENT_MAX_DEPTH";
export const ENV_TOP_RUN_ID = "PI_SUBAGENT_TOP_RUN_ID";
export const ENV_PARENT_CHILD_ID = "PI_SUBAGENT_PARENT_CHILD_ID";

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string"
			? Number(value)
			: Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return (
		normalizeMaxSubagentDepth(process.env[ENV_MAX_DEPTH])
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_MAX_SUBAGENT_DEPTH
	);
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_MAX_SUBAGENT_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export interface DepthCheck {
	blocked: boolean;
	depth: number;
	maxDepth: number;
}

export function checkSubagentDepth(configMaxDepth?: number): DepthCheck {
	const depth = Number(process.env[ENV_DEPTH] ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function currentSubagentDepth(): number {
	const depth = Number(process.env[ENV_DEPTH] ?? "0");
	return Number.isFinite(depth) ? depth : 0;
}

export function currentTopLevelRunId(): string | undefined {
	return process.env[ENV_TOP_RUN_ID] || undefined;
}

export function currentParentChildId(): string | undefined {
	return process.env[ENV_PARENT_CHILD_ID] || undefined;
}

export interface ChildDepthEnvInput {
	maxDepth?: number;
	topLevelRunId: string;
	parentChildId: string;
}

/**
 * Build the child env fragment that propagates depth and nesting identity.
 * Caller merges this with the gate-profile + request-specific env.
 */
export function buildChildDepthEnv(input: ChildDepthEnvInput): Record<string, string> {
	const parentDepth = Number(process.env[ENV_DEPTH] ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	const effectiveMax = normalizeMaxSubagentDepth(input.maxDepth) ?? resolveCurrentMaxSubagentDepth();
	return {
		[ENV_DEPTH]: String(nextDepth),
		[ENV_MAX_DEPTH]: String(effectiveMax),
		[ENV_TOP_RUN_ID]: input.topLevelRunId,
		[ENV_PARENT_CHILD_ID]: input.parentChildId,
	};
}

import type { DelegationContext } from "./types.ts";

export const DEFAULT_ORCHESTRATOR_CHILD_AGENT = "scout" as const;
export const ORCHESTRATOR_ALLOWED_CONTEXTS = ["fresh", "fork", "continue"] as const satisfies readonly DelegationContext[];

export function isAllowedContext(value: unknown): value is DelegationContext {
	return value === "fresh" || value === "fork" || value === "continue";
}

export function childEnv(agent: string): Record<string, string> {
	return {
		GATE_PROFILE: agent,
		GATE_PROFILE_LOCK: "1",
	};
}

import { DEFAULT_ORCHESTRATOR_CHILD_AGENT, isAllowedContext } from "./policy.ts";
import { MAX_SYNC_TIMEOUT_SECONDS } from "./timeout.ts";
import type { NormalizedDelegationRequest } from "./types.ts";

function requestedDelegatedAgent(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : DEFAULT_ORCHESTRATOR_CHILD_AGENT;
}

function normalizeTaskItems(value: unknown, field: "tasks" | "chain"): { items?: Array<{ task: string }>; error?: string } {
	if (!Array.isArray(value) || value.length === 0) return { error: `${field} must be a non-empty array.` };
	const items: Array<{ task: string }> = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${field}[${i}] must be an object.` };
		const task = (item as { task?: unknown }).task;
		if (typeof task !== "string" || !task.trim()) return { error: `${field}[${i}].task must be a non-empty string.` };
		items.push({ task: task.trim() });
	}
	return { items };
}

export function normalizeDelegateInput(input: {
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
	chain?: unknown;
	async?: unknown;
	context?: unknown;
	showRunCard?: unknown;
	timeoutSeconds?: unknown;
	childSessionId?: unknown;
}): { request?: NormalizedDelegationRequest; error?: string } {
	const hasTask = typeof input.task === "string" && input.task.trim().length > 0;
	const hasTasks = input.tasks !== undefined;
	const hasChain = input.chain !== undefined;
	if (Number(hasTask) + Number(hasTasks) + Number(hasChain) !== 1) {
		return { error: "Provide exactly one of task, tasks, or chain." };
	}
	if (input.context !== undefined && !isAllowedContext(input.context)) {
		return { error: 'context must be one of "fresh", "fork", or "continue".' };
	}
	const normalizedAsync = input.async === true;
	const context = input.context === "fork" ? "fork" : input.context === "continue" ? "continue" : "fresh";
	const showRunCard = input.showRunCard === true;
	const timeoutSeconds = input.timeoutSeconds === undefined
		? undefined
		: typeof input.timeoutSeconds === "number"
			&& Number.isInteger(input.timeoutSeconds)
			&& input.timeoutSeconds > 0
			&& input.timeoutSeconds <= MAX_SYNC_TIMEOUT_SECONDS
				? input.timeoutSeconds
				: null;
	if (timeoutSeconds === null) {
		return { error: `timeoutSeconds must be a positive integer no greater than ${MAX_SYNC_TIMEOUT_SECONDS}.` };
	}
	const childSessionId = typeof input.childSessionId === "string" && input.childSessionId.trim()
		? input.childSessionId.trim()
		: undefined;
	if (context === "continue") {
		if (!hasTask) {
			return { error: 'context "continue" currently supports only single-task delegation via `task`.' };
		}
		if (!childSessionId) {
			return { error: 'childSessionId is required when context is "continue".' };
		}
	} else if (childSessionId) {
		return { error: 'childSessionId is only supported when context is "continue".' };
	}
	const agent = requestedDelegatedAgent(input.agent);
	if (hasTask) {
		return { request: { shape: "single", agent, async: normalizedAsync, context, showRunCard, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}), ...(childSessionId ? { childSessionId } : {}), task: (input.task as string).trim() } };
	}
	if (hasTasks) {
		const normalized = normalizeTaskItems(input.tasks, "tasks");
		if (!normalized.items) return { error: normalized.error };
		return { request: { shape: "parallel", agent, async: normalizedAsync, context, showRunCard, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}), tasks: normalized.items } };
	}
	const normalized = normalizeTaskItems(input.chain, "chain");
	if (!normalized.items) return { error: normalized.error };
	return { request: { shape: "chain", agent, async: normalizedAsync, context, showRunCard, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}), chain: normalized.items } };
}

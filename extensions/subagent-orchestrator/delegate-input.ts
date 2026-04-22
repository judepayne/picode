import { DEFAULT_ORCHESTRATOR_CHILD_AGENT, isAllowedContext } from "./policy.ts";
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
	if (input.context === "continue") {
		return { error: 'context "continue" is only supported for direct user `~subagent` dispatch. Use "fresh" or "fork" here.' };
	}
	const normalizedAsync = input.async === true;
	const context = input.context === "fork" ? "fork" : "fresh";
	const showRunCard = input.showRunCard === true;
	const agent = requestedDelegatedAgent(input.agent);
	if (hasTask) {
		return { request: { shape: "single", agent, async: normalizedAsync, context, showRunCard, task: (input.task as string).trim() } };
	}
	if (hasTasks) {
		const normalized = normalizeTaskItems(input.tasks, "tasks");
		if (!normalized.items) return { error: normalized.error };
		return { request: { shape: "parallel", agent, async: normalizedAsync, context, showRunCard, tasks: normalized.items } };
	}
	const normalized = normalizeTaskItems(input.chain, "chain");
	if (!normalized.items) return { error: normalized.error };
	return { request: { shape: "chain", agent, async: normalizedAsync, context, showRunCard, chain: normalized.items } };
}

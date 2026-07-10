import { DEFAULT_ORCHESTRATOR_CHILD_AGENT } from "./policy.ts";
import type { SubagentModeRunResult } from "./event-handlers.ts";
import type { NormalizedDelegationRequest, OrchestratorChildSessionRecord } from "./types.ts";
import { truncateDisplayText } from "./run-status.ts";

export function isEnvEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

export function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function warnOrchestratorDiagnostic(message: string, error?: unknown): void {
	const suffix = error === undefined ? "" : `: ${formatUnknownError(error)}`;
	console.warn(`[subagent-orchestrator] ${message}${suffix}`);
}

export function lastNonEmptyLine(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.at(-1);
}

export function summarizeAsyncFailure(result: SubagentModeRunResult, fallback: string, limit = 1000): string {
	const lines = result.results
		.map((child, index) => {
			if (child.status !== "failed" && !child.error) return undefined;
			const label = `${child.agent || DEFAULT_ORCHESTRATOR_CHILD_AGENT}[${index}]`;
			return `${label}: ${child.error || lastNonEmptyLine(child.finalText) || child.status}`;
		})
		.filter((line): line is string => Boolean(line));
	return truncateDisplayText(lines.join("\n") || fallback, limit) ?? fallback;
}

export function summarizeTasks(request: NormalizedDelegationRequest): string {
	switch (request.shape) {
		case "single": return request.task ?? "Scout task";
		case "parallel": return request.tasks!.map((item) => item.task).join(" | ");
		case "chain": return request.chain!.map((item) => item.task).join(" -> ");
	}
}

export function getRequestedModeLabel(request: Pick<NormalizedDelegationRequest, "shape">): "single" | "parallel" | "chain" {
	return request.shape;
}

export function buildChildSessionDetails(children: OrchestratorChildSessionRecord[]): Array<Record<string, unknown>> {
	return children.map((child) => ({
		childSessionId: child.childSessionId,
		agent: child.agent,
		childIndex: child.childIndex,
		status: child.status,
		taskSummary: child.taskSummary,
		...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
	}));
}

export function stickyUserSubagentBusyMessage(agent: string): string {
	return `${agent} is busy`;
}

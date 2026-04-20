export interface FailedAgentGroup {
	agent: string;
	count: number;
}

export interface FooterStatusInput {
	activeRuns: number;
	activeChildren: number;
	queuedHandbacks: number;
	failedAgents?: FailedAgentGroup[];
}

function normalizeAgent(agent: string | undefined): string {
	const trimmed = agent?.trim().toLowerCase();
	return trimmed || "subagent";
}

function pluralizeAgent(agent: string, count: number): string {
	return count === 1 ? agent : `${agent}s`;
}

function titleizeAgent(agent: string | undefined): string {
	return normalizeAgent(agent)
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function summarizeFailedAgents(groups: FailedAgentGroup[]): string | undefined {
	const normalized = groups
		.map((group) => ({ agent: normalizeAgent(group.agent), count: group.count }))
		.filter((group) => group.count > 0)
		.sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
	if (normalized.length === 0) return undefined;
	if (normalized.length === 1 && normalized[0]!.count === 1) return normalized[0]!.agent;
	return normalized
		.map((group) => `${group.count} ${pluralizeAgent(group.agent, group.count)}`)
		.join(", ");
}

export function formatFooterStatus(input: FooterStatusInput, emphasizeFailed: (text: string) => string = (text) => text): string | undefined {
	const failedSummary = summarizeFailedAgents(input.failedAgents ?? []);
	const activeParts: string[] = [];
	if (input.activeChildren > 0) activeParts.push(`${input.activeChildren} active`);
	if (input.queuedHandbacks > 0) activeParts.push(`${input.queuedHandbacks} waiting`);
	if (failedSummary) {
		const parts = [`${emphasizeFailed("failed")} ${failedSummary}`, ...activeParts];
		return `subagents: ${parts.join(" · ")}`;
	}
	if (input.activeRuns > 0) activeParts.unshift(`${input.activeRuns} run${input.activeRuns === 1 ? "" : "s"}`);
	return activeParts.length > 0 ? `subagents:${activeParts.join(" · ")}` : undefined;
}

export function formatUserLaunchNotification(agent: string | undefined): string {
	return `${titleizeAgent(agent)} running in background`;
}

export function formatBackgroundFailureNotification(agent: string | undefined, summary: string | undefined): string {
	const subject = normalizeAgent(agent);
	return summary?.trim()
		? `Background ${subject} failed: ${summary}`
		: `Background ${subject} failed.`;
}

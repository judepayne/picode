function normalizeAgent(agent: string | undefined): string {
	const trimmed = agent?.trim().toLowerCase();
	return trimmed || "subagent";
}

function titleizeAgent(agent: string | undefined): string {
	return normalizeAgent(agent)
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
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

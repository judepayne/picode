export const DEFAULT_SYNC_TIMEOUT_SECONDS = 40;
export const MAX_SYNC_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

export function formatSyncIdleTimeoutMessage(timeoutSeconds: number): string {
	return `delegated subagent timed out after ${timeoutSeconds}s of inactivity`;
}

export function nextSyncIdleTimeoutDelayMs(lastActivityAt: number, now: number, timeoutSeconds: number): number | undefined {
	const timeoutMs = timeoutSeconds * 1000;
	const idleForMs = Math.max(0, now - lastActivityAt);
	if (idleForMs >= timeoutMs) return undefined;
	return Math.max(1, timeoutMs - idleForMs);
}

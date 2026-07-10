import type { NormalizedDelegationRequest, OrchestratorChildSessionRecord, RunStatus } from "./types.ts";

export const STATUS_LIST_TEXT_LIMIT = 300;
export function toRunStatus(status: string | undefined, success: boolean | undefined, cancelled: boolean | undefined): RunStatus {
	if (cancelled || status === "cancelled") return "cancelled";
	if (status === "failed" || success === false) return "failed";
	if (status === "complete" || success === true) return "complete";
	if (status === "running") return "running";
	return "queued";
}
export function isTerminal(status: RunStatus): boolean { return status === "complete" || status === "failed" || status === "cancelled"; }
export function isRunning(status: RunStatus): boolean { return status === "running"; }
export function shouldMarkChildRunningAtLaunch(request: NormalizedDelegationRequest, child: OrchestratorChildSessionRecord): boolean {
	return request.async && (request.shape !== "chain" || (child.stepIndex ?? child.childIndex) === 0);
}
export function truncateDisplayText(text: string | undefined, limit = STATUS_LIST_TEXT_LIMIT): string | undefined {
	if (typeof text !== "string" || !text.trim()) return undefined;
	const normalized = text.trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
export function boundedRecentOutput(lines: string[] | undefined, limit = 6): string[] | undefined {
	if (!Array.isArray(lines)) return undefined;
	const normalized = lines.map((line) => line.trim()).filter(Boolean).slice(-limit);
	return normalized.length ? normalized : undefined;
}
export function finalAnswerRecentOutput(text: string | undefined, limit = 4): string[] | undefined {
	return typeof text === "string" ? boundedRecentOutput(text.split(/\r?\n/), limit) : undefined;
}

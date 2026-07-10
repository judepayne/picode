import type { SubagentModeRunResult } from "./event-handlers.ts";
import type { ProgrammaticSubagentResponse } from "./types.ts";

export function adaptSubagentModeResponse(
	requestId: string,
	result: SubagentModeRunResult | null,
	ok: boolean,
	errorText: string | undefined,
	asyncMeta?: { asyncDir?: string; asyncId?: string; pid?: number },
): ProgrammaticSubagentResponse {
	const overallError = !ok || result?.status === "failed";
	const combinedText = result
		? result.results.map((entry) => entry.finalText ?? "").filter(Boolean).join("\n\n---\n\n")
		: "";
	const details: Record<string, unknown> = {
		mode: result?.mode ?? "single",
		results: result
			? result.results.map((entry) => ({
				agent: entry.agent,
				output: entry.finalText,
				finalOutput: entry.finalText,
				success: entry.status === "complete",
				sessionFile: entry.sessionFile,
			}))
			: [],
	};
	if (asyncMeta?.asyncDir) details.asyncDir = asyncMeta.asyncDir;
	if (asyncMeta?.asyncId) details.asyncId = asyncMeta.asyncId;
	if (asyncMeta?.pid !== undefined) details.pid = asyncMeta.pid;
	return {
		requestId,
		isError: Boolean(overallError),
		errorText: errorText ?? result?.results.find((entry) => entry.error)?.error,
		result: {
			content: [{ type: "text", text: combinedText }],
			isError: Boolean(overallError),
			details,
		},
	} as ProgrammaticSubagentResponse;
}

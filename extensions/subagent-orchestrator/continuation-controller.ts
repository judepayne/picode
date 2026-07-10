import { SessionManager, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildSessionLineage, sessionReferenceInLineage } from "./session-lineage.ts";
import {
	findStickyUserSubagentSession,
	updateStickyUserSubagentSessionByRun,
	upsertStickyUserSubagentSession,
	type StickyUserSubagentSession,
} from "./sticky-user-sessions.ts";
import type { StateStore } from "./state.ts";
import { errorResult } from "./tool-results.ts";
import type { NormalizedDelegationRequest, ProgrammaticSubagentResponse, RunOrigin } from "./types.ts";

interface ContinuePreparation {
	response?: ProgrammaticSubagentResponse;
	sessionFiles?: string[];
}

function errorResponse(requestId: string, message: string): ContinuePreparation {
	return {
		response: {
			requestId,
			isError: true,
			errorText: message,
			result: { ...errorResult(message), isError: true },
		},
	};
}

export function createContinuationController(state: StateStore) {
	let sticky: StickyUserSubagentSession[] = [];
	const lineage = (ctx: ExtensionContext) => buildSessionLineage(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());

	function findUser(ctx: ExtensionContext, agent: string): StickyUserSubagentSession | undefined {
		return findStickyUserSubagentSession(sticky, agent, lineage(ctx));
	}

	function upsertUser(ctx: ExtensionContext, next: StickyUserSubagentSession): StickyUserSubagentSession {
		sticky = upsertStickyUserSubagentSession(sticky, lineage(ctx), next);
		return findUser(ctx, next.agent) ?? next;
	}

	function createSessionFile(ctx: ExtensionContext): string {
		const dir = (ctx.sessionManager as { getSessionDir?: () => string })?.getSessionDir?.();
		const file = SessionManager.create(ctx.cwd, dir).getSessionFile();
		if (!file) throw new Error("Failed to create a persisted child session for continued subagent context.");
		return file;
	}

	function validateAgent(ctx: ExtensionContext, request: NormalizedDelegationRequest): { error?: string; sessionFiles?: string[] } {
		if (request.context !== "continue") return {};
		if (request.shape !== "single") return { error: 'context "continue" currently supports only single-task delegation via `task`.' };
		if (!request.childSessionId) return { error: 'childSessionId is required when context is "continue".' };
		const target = state.getChildSession(request.childSessionId);
		if (!target) return { error: `Child session ${request.childSessionId} was not found.` };
		const current = lineage(ctx);
		if (!sessionReferenceInLineage(target.parentSessionFile, current) && !sessionReferenceInLineage(target.parentSessionId, current)) {
			return { error: `Child session ${request.childSessionId} is not part of the current session lineage.` };
		}
		if (target.agent !== request.agent) return { error: `Child session ${request.childSessionId} belongs to subagent ${target.agent}, not ${request.agent}.` };
		if (!target.sessionFile) return { error: `Child session ${request.childSessionId} cannot be continued because no persisted session file was recorded.` };
		const busy = state.listChildSessions().some((child) => child.sessionFile === target.sessionFile && !["complete", "failed", "cancelled"].includes(child.status));
		if (busy) return { error: `${request.agent} continuation ${request.childSessionId} is busy.` };
		return { sessionFiles: [target.sessionFile] };
	}

	function prepareUser(
		ctx: ExtensionContext,
		request: NormalizedDelegationRequest,
		origin: RunOrigin,
		runId: string,
		now: number,
		childSessionId?: string,
	): ContinuePreparation {
		if (origin !== "user" || request.context !== "continue" || request.shape !== "single") return {};
		const existing = findUser(ctx, request.agent);
		if (existing?.activeRunId) return errorResponse(runId, `${request.agent} is busy`);
		const sessionFile = existing?.sessionFile ?? createSessionFile(ctx);
		upsertUser(ctx, {
			agent: request.agent,
			parentSessionId: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined,
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			sessionFile,
			...(childSessionId ? { childSessionId } : {}),
			activeRunId: runId,
			createdAt: existing?.createdAt ?? now,
			lastUsedAt: now,
		});
		return { sessionFiles: [sessionFile] };
	}

	function prepareAgent(
		ctx: ExtensionContext,
		request: NormalizedDelegationRequest,
		origin: RunOrigin,
		runId: string,
	): ContinuePreparation {
		if (origin !== "agent" || request.context !== "continue") return {};
		const result = validateAgent(ctx, request);
		return result.error ? errorResponse(runId, result.error) : { sessionFiles: result.sessionFiles };
	}

	return {
		findUser,
		upsertUser,
		bindRun(runId: string, patch: Partial<StickyUserSubagentSession>) {
			sticky = updateStickyUserSubagentSessionByRun(sticky, runId, patch);
		},
		releaseRun(runId: string, updatedAt: number) {
			sticky = updateStickyUserSubagentSessionByRun(sticky, runId, { activeRunId: undefined, lastUsedAt: updatedAt });
		},
		createSessionFile,
		validateAgent,
		prepareUser,
		prepareAgent,
		dispose() { sticky = []; },
	};
}

export type ContinuationController = ReturnType<typeof createContinuationController>;

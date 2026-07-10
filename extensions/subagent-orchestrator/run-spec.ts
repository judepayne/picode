import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createForkContextResolver, type ForkableSessionManager } from "../subagent-mode/fork-context.ts";
import { resolveDefaultChildExtensionPaths } from "../subagent-mode/runner.ts";
import { resolveDelegatedRunMaxSubagentDepth } from "./max-subagent-depth.ts";
import { childEnv } from "./policy.ts";
import type { SubagentCardConfigResolver } from "./card-config-resolver.ts";
import type { NormalizedDelegationRequest } from "./types.ts";

export function createRunSpecBuilder(cards: SubagentCardConfigResolver) {
	const mergeExtensions = (additional: string[] | undefined): string[] | undefined => additional === undefined
		? undefined
		: [...new Set([...resolveDefaultChildExtensionPaths(), ...additional])];

	return {
		precomputeForkSessionFiles(ctx: ExtensionContext, request: NormalizedDelegationRequest, count: number): string[] | undefined {
			if (!request.async || request.context !== "fork" || count <= 0) return undefined;
			const sessionManager = ctx.sessionManager as ForkableSessionManager;
			if (
				!sessionManager
				|| typeof sessionManager.getSessionFile !== "function"
				|| typeof sessionManager.getLeafId !== "function"
				|| typeof sessionManager.createBranchedSession !== "function"
			) {
				throw new Error("Forked subagent context requires a persisted parent session.");
			}
			const resolver = createForkContextResolver(sessionManager, request.context);
			return Array.from({ length: count }, (_, index) => resolver.sessionFileForIndex(index))
				.filter((value): value is string => Boolean(value));
		},

		build(
			ctx: ExtensionContext,
			modeId: string,
			request: NormalizedDelegationRequest,
			currentThinking?: string,
			childIds?: string[],
			sessionFiles?: string[],
			nodeLog?: { nodeLogsDir: string; runId: string; rootRunId?: string },
		) {
			const model = request.model ?? cards.resolveModel(ctx, request.agent);
			const thinking = request.thinking ?? cards.resolveThinking(request.agent, currentThinking);
			const common = {
				...(thinking ? { thinking } : {}),
				context: request.context,
				async: request.async,
				env: childEnv(request.agent),
				maxSubagentDepth: resolveDelegatedRunMaxSubagentDepth({
					parentModeMaxSubagentDepth: cards.modeDepth(modeId),
					childAgentMaxSubagentDepth: cards.subagentDepth(request.agent),
				}),
				...(model ? { model } : {}),
				...(request.tools !== undefined ? { tools: request.tools } : {}),
				...(request.extensions !== undefined ? { extensions: mergeExtensions(request.extensions) } : {}),
				...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
				...(childIds?.length ? { childIds } : {}),
				...(sessionFiles?.length ? { sessionFiles } : {}),
				...(nodeLog ? { nodeLog } : {}),
			};
			if (request.shape === "single") return { ...common, mode: "single", agent: request.agent, task: request.task };
			if (request.shape === "parallel") {
				return { ...common, mode: "parallel", tasks: request.tasks!.map((item) => ({ agent: request.agent, task: item.task })) };
			}
			return {
				...common,
				mode: "chain",
				task: request.chain?.[0]?.task ?? "",
				chain: request.chain!.map((step) => ({ agent: request.agent, task: step.task })),
			};
		},
	};
}

export type RunSpecBuilder = ReturnType<typeof createRunSpecBuilder>;

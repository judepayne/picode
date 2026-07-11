import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectAgentAssetSnapshot } from "../agent-assets/contract.ts";
import { resolveToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { resolveDefaultChildExtensionPaths } from "../subagent-mode/runner.ts";
import { readNamedAgentMaxSubagentDepthFromCards } from "./max-subagent-depth.ts";
import {
	formatModelReference,
	readNamedAgentExtensionPathsFromCards,
	readNamedAgentModelFromCards,
	readNamedAgentPromptFromCards,
	readNamedAgentThinkingFromCards,
	readNamedAgentToolSelectionFromCards,
} from "./subagent-model.ts";
import type { NormalizedDelegationRequest } from "./types.ts";

export function createSubagentCardConfigResolver(pi: ExtensionAPI) {
	let snapshot: ReturnType<typeof collectAgentAssetSnapshot> | undefined;
	const caches = {
		modeDepth: new Map<string, number | undefined>(),
		depth: new Map<string, number | undefined>(),
		model: new Map<string, string | undefined>(),
		thinking: new Map<string, string | undefined>(),
		tools: new Map<string, ToolSelectionSpec | undefined>(),
		extensions: new Map<string, string[] | undefined>(),
		prompt: new Map<string, string | undefined>(),
	};

	const getSnapshot = () => snapshot ??= collectAgentAssetSnapshot(pi);
	const agentCards = () => getSnapshot().agents;
	const subagentCards = () => getSnapshot().subagents;
	const cached = <T>(map: Map<string, T>, key: string, read: () => T): T => {
		if (map.has(key)) return map.get(key)!;
		const value = read();
		map.set(key, value);
		return value;
	};
	const modeDepth = (id: string) => cached(caches.modeDepth, id, () => readNamedAgentMaxSubagentDepthFromCards(agentCards(), id));
	const subagentDepth = (id: string) => cached(caches.depth, id, () => readNamedAgentMaxSubagentDepthFromCards(subagentCards(), id));
	const model = (id: string) => cached(caches.model, id, () => readNamedAgentModelFromCards(subagentCards(), id));
	const thinking = (id: string) => cached(caches.thinking, id, () => readNamedAgentThinkingFromCards(subagentCards(), id));
	const toolSelection = (id: string) => cached(caches.tools, id, () => readNamedAgentToolSelectionFromCards(subagentCards(), id));
	const extensions = (id: string) => cached(caches.extensions, id, () => readNamedAgentExtensionPathsFromCards(subagentCards(), id));
	const prompt = (id: string) => cached(caches.prompt, id, () => readNamedAgentPromptFromCards(subagentCards(), id));

	const canonicalExistingPath = (value: string): string => {
		try {
			return fs.realpathSync.native(value);
		} catch {
			return path.resolve(value);
		}
	};

	const availableTools = (additionalExtensionPaths: string[] = []): string[] => {
		const extensionRoots = [...resolveDefaultChildExtensionPaths(), ...additionalExtensionPaths].map(canonicalExistingPath);
		const seen = new Set<string>();
		const result: string[] = [];
		for (const tool of pi.getAllTools()) {
			if (!tool?.name || seen.has(tool.name)) continue;
			const toolPath = tool.sourceInfo?.path && canonicalExistingPath(tool.sourceInfo.path);
			if (tool.sourceInfo?.source !== "builtin" && (!toolPath || !extensionRoots.some((root) => toolPath === root || toolPath.startsWith(`${root}${path.sep}`)))) {
				continue;
			}
			seen.add(tool.name);
			result.push(tool.name);
		}
		return result;
	};

	const resolveTools = (ctx: ExtensionContext, agent: string, additionalExtensionPaths?: string[]): string[] => {
		const selection = toolSelection(agent);
		const resolved = resolveToolSelection(selection, {
			defaultMode: "inherit",
			availableTools: availableTools(additionalExtensionPaths),
			inheritedTools: pi.getActiveTools(),
		});
		const childOnlyRequestedTools = additionalExtensionPaths?.length && selection?.toolsMode === "list"
			? resolved.unknownRequestedTools.filter((tool) => !(selection.banTools ?? []).includes(tool))
			: [];
		if (ctx.hasUI && childOnlyRequestedTools.length === 0 && resolved.unknownRequestedTools.length > 0) {
			ctx.ui.notify(`Subagent ${agent}: unknown tools ignored: ${resolved.unknownRequestedTools.join(", ")}`, "warning");
		}
		if (ctx.hasUI && resolved.unknownBannedTools.length > 0) {
			ctx.ui.notify(`Subagent ${agent}: unknown ban_tools ignored: ${resolved.unknownBannedTools.join(", ")}`, "warning");
		}
		return [...new Set([...resolved.tools, ...childOnlyRequestedTools])];
	};

	return {
		snapshot: getSnapshot,
		agentCards,
		subagentCards,
		modeDepth,
		subagentDepth,
		resolveModel: (ctx: ExtensionContext, id: string) => model(id) ?? formatModelReference(ctx.model),
		resolveThinking: (id: string, current?: string) => thinking(id) ?? current,
		hydrate(ctx: ExtensionContext, request: NormalizedDelegationRequest, currentThinking?: string): NormalizedDelegationRequest {
			const additionalExtensions = request.extensions ?? extensions(request.agent);
			return {
				...request,
				model: request.model ?? this.resolveModel(ctx, request.agent),
				thinking: request.thinking ?? this.resolveThinking(request.agent, currentThinking),
				tools: request.tools ?? resolveTools(ctx, request.agent, additionalExtensions),
				extensions: additionalExtensions,
				systemPrompt: request.systemPrompt ?? prompt(request.agent),
			};
		},
		dispose() {
			snapshot = undefined;
			for (const map of Object.values(caches)) map.clear();
		},
	};
}

export type SubagentCardConfigResolver = ReturnType<typeof createSubagentCardConfigResolver>;

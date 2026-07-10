import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { currentParentChildId, currentSubagentDepth } from "../subagent-mode/depth.ts";
import { findNamedAgentCard, slugifyCardName } from "./agent-card-lookup.ts";
import { buildSessionLineage, sessionReferenceInLineage } from "./session-lineage.ts";
import type { StateStore } from "./state.ts";
import type { AgentAssetCard } from "../agent-assets/contract.ts";
import type { ModeStateSessionEntry, OrchestratorChildSessionRecord, OrchestratorHandbackRecord, OrchestratorRunRecord, RunOrigin } from "./types.ts";

const MODE_STATE_ENTRY_TYPE = "agent-mode-state";

function normalizeSubagentList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const subagents = value
		.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "")
		.filter(Boolean);
	return subagents.length === 1 && subagents[0] === "-" ? [] : [...new Set(subagents)];
}

function parseSubagentListFrontmatter(value: string | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	const list = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	const entries = list
		.split(",")
		.map((entry) => entry.trim().replace(/^['\"]|['\"]$/g, "").toLowerCase())
		.filter(Boolean);
	return entries.length === 1 && entries[0] === "-" ? [] : [...new Set(entries)];
}

export function normalizeRunOrigin(value: unknown): RunOrigin {
	return value === "user" ? "user" : "agent";
}

export function normalizeHandbackConsumer(value: unknown): "agent" | "user" {
	return value === "user" ? "user" : "agent";
}

export function currentSessionKey(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
}

export function currentSessionLineage(ctx: ExtensionContext) {
	return buildSessionLineage(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
}

type SessionLineage = ReturnType<typeof currentSessionLineage>;

export function runMatchesSessionLineage(
	run: Pick<OrchestratorRunRecord, "parentSessionId" | "parentSessionFile">,
	lineage: SessionLineage,
): boolean {
	return sessionReferenceInLineage(run.parentSessionFile, lineage)
		|| sessionReferenceInLineage(run.parentSessionId, lineage);
}

export function childSessionMatchesSessionLineage(
	child: Pick<OrchestratorChildSessionRecord, "parentSessionId" | "parentSessionFile">,
	lineage: SessionLineage,
): boolean {
	return sessionReferenceInLineage(child.parentSessionFile, lineage)
		|| sessionReferenceInLineage(child.parentSessionId, lineage);
}

export function handbackMatchesSessionLineage(
	handback: Pick<OrchestratorHandbackRecord, "parentSessionId">,
	lineage: SessionLineage,
): boolean {
	return sessionReferenceInLineage(handback.parentSessionId, lineage);
}

export interface DelegationContext {
	modeId?: string;
	knownSubagents: string[];
	bannedSubagents: string[];
	availableSubagents: string[];
}

export function createDelegationContextResolver(
	state: StateStore,
	getSubagentCards: () => AgentAssetCard[],
) {
	const knownSubagentIds = (): string[] => getSubagentCards()
		.map((card) => typeof card.name === "string" ? slugifyCardName(card.name) : "")
		.filter(Boolean);

	const findCurrent = (ctx: ExtensionContext): DelegationContext => {
		const knownSubagents = knownSubagentIds();
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as ModeStateSessionEntry;
			if (entry?.type !== "custom" || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
			const modeId = entry.data?.modeId?.trim().toLowerCase();
			if (!modeId) continue;
			const bannedSubagents = normalizeSubagentList(entry.data?.bannedSubagents);
			const effectiveKnownSubagents = knownSubagents.length > 0 ? knownSubagents : normalizeSubagentList(entry.data?.subagents);
			return {
				modeId,
				knownSubagents: effectiveKnownSubagents,
				bannedSubagents,
				availableSubagents: effectiveKnownSubagents.filter((subagent) => !bannedSubagents.includes(subagent)),
			};
		}

		const currentSubagent = process.env.GATE_PROFILE?.trim().toLowerCase();
		if (currentSubagent && currentSubagentDepth() > 0 && knownSubagents.includes(currentSubagent)) {
			const card = findNamedAgentCard(getSubagentCards(), currentSubagent);
			const bannedSubagents = parseSubagentListFrontmatter(card?.banned_subagents);
			return {
				modeId: currentSubagent,
				knownSubagents,
				bannedSubagents,
				availableSubagents: knownSubagents.filter((subagent) => !bannedSubagents.includes(subagent)),
			};
		}
		return { knownSubagents, bannedSubagents: [], availableSubagents: [] };
	};

	const findModeId = (ctx: ExtensionContext): string | undefined => findCurrent(ctx).modeId;
	const findOwnerModeId = (ctx: ExtensionContext): string | undefined => {
		const parentExecutionChildId = currentParentChildId();
		const directParentChild = parentExecutionChildId
			? state.getChildSession(parentExecutionChildId) ?? state.findChildSessionByExecutionChildId(parentExecutionChildId)
			: undefined;
		return directParentChild?.ownerModeId ?? findModeId(ctx);
	};

	return {
		findCurrent,
		findModeId,
		findOwnerModeId,
		currentAvailableSubagents: (ctx: ExtensionContext): string[] => findCurrent(ctx).availableSubagents,
	};
}

export type DelegationContextResolver = ReturnType<typeof createDelegationContextResolver>;

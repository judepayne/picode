import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_ORCHESTRATOR_CHILD_AGENT, childEnv } from "./policy.ts";
import { collectAgentCards, collectSubagentCards, type AgentAssetCard } from "../agent-assets/contract.ts";
import { resolveToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { createAsyncEventManager } from "./async-events.ts";
import { createChildEventController } from "./child-events.ts";
import { createFooterLifecycleController } from "./footer-lifecycle.ts";
import { extractChildResultPayloads, summarizeHandbackText } from "./handbacks.ts";
import { createHandbackDeliveryController } from "./handback-delivery.ts";
import { buildSessionLineage, sessionReferenceInLineage } from "./session-lineage.ts";
import { formatModelReference, readNamedAgentExtensionPathsFromCards, readNamedAgentModelFromCards, readNamedAgentPromptFromCards, readNamedAgentThinkingFromCards, readNamedAgentToolSelectionFromCards } from "./subagent-model.ts";
import { SubagentEditor } from "./subagent-editor.ts";
import { normalizeDelegateInput } from "./delegate-input.ts";
import { parseUserDispatch } from "./user-dispatch.ts";
import { currentParentChildId, currentSubagentDepth, currentTopLevelRunId } from "../subagent-mode/depth.ts";
import { cancelAsyncRun } from "../subagent-mode/async-executor.ts";
import {
	EVENT_CHILD_CANCELLED as SUBAGENT_MODE_CHILD_CANCELLED_EVENT,
	EVENT_CHILD_COMPLETE as SUBAGENT_MODE_CHILD_COMPLETE_EVENT,
	EVENT_CHILD_ERROR as SUBAGENT_MODE_CHILD_ERROR_EVENT,
	EVENT_CHILD_PROGRESS as SUBAGENT_MODE_CHILD_PROGRESS_EVENT,
	EVENT_CHILD_STARTED as SUBAGENT_MODE_CHILD_STARTED_EVENT,
	EVENT_CHILD_TEXT_DELTA as SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT,
	EVENT_CHILD_TEXT_FINAL as SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT,
	EVENT_CHILD_THINKING_END as SUBAGENT_MODE_CHILD_THINKING_END_EVENT,
	EVENT_CHILD_THINKING_START as SUBAGENT_MODE_CHILD_THINKING_START_EVENT,
	EVENT_CHILD_TOOL_END as SUBAGENT_MODE_CHILD_TOOL_END_EVENT,
	EVENT_CHILD_TOOL_START as SUBAGENT_MODE_CHILD_TOOL_START_EVENT,
	EVENT_MODE_CANCEL as SUBAGENT_MODE_CANCEL_EVENT,
	EVENT_MODE_REQUEST as SUBAGENT_MODE_REQUEST_EVENT,
	EVENT_MODE_REQUEST_RESPONSE as SUBAGENT_MODE_REQUEST_RESPONSE_EVENT,
	EVENT_MODE_REQUEST_STARTED as SUBAGENT_MODE_REQUEST_STARTED_EVENT,
	EVENT_RUN_COMPLETE as SUBAGENT_MODE_RUN_COMPLETE_EVENT,
} from "../subagent-mode/types.ts";
import { resolveDefaultChildExtensionPaths } from "../subagent-mode/runner.ts";
import { createForkContextResolver, type ForkableSessionManager } from "../subagent-mode/fork-context.ts";
import { findNamedAgentCard, slugifyCardName } from "./agent-card-lookup.ts";
import { readNamedAgentMaxSubagentDepthFromCards, resolveDelegatedRunMaxSubagentDepth } from "./max-subagent-depth.ts";
import { rememberRunMessageDetails, ORCHESTRATOR_RUN_MESSAGE_TYPE, resolveRunMessageDetails, restoreRunMessageSnapshots, clearRunMessageSnapshots } from "./run-live-state.ts";
import { formatUserLaunchNotification } from "./footer-status.ts";
import { buildChildSessionEntry, ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, ORCHESTRATOR_COMPLETE_ENTRY_TYPE, ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE } from "./session-entries.ts";
import { buildChildSessionRecords } from "./session-model.ts";
import { createStateStore } from "./state.ts";
import { DEFAULT_SYNC_TIMEOUT_SECONDS, formatSyncIdleTimeoutMessage, MAX_SYNC_TIMEOUT_SECONDS, nextSyncIdleTimeoutDelayMs } from "./timeout.ts";
import { DelegateSubagentParams, DelegateSubagentStatusParams, DevSubagentStreamToFileParams } from "./tool-schemas.ts";
import { buildTreeNodes, filterNodeLogRecords, formatNodeLogLines, formatRunDetails, formatRunList, formatTree, selectRunChild, STATUS_LIST_LIMIT, summarizeRunForListDetails } from "./status-tools.ts";
import { createContinuationMessageComponent, createRunMessageComponent } from "./message-renderers.ts";
import { renderDelegateToolResult, renderStatusToolResult } from "./tool-renderers.ts";
import { createSubagentStreamService, emitSubagentStreamRecord, EVENT_SUBAGENT_TASK, openSubagentStream, setActiveSubagentStreamService, subagentStreamTopic, type OpenSubagentStreamOptions, type SubagentStreamEvent, type SubagentStreamHandler } from "./stream.ts";
import { createJsonlFileSubagentStreamHandler } from "./stream-handlers.ts";
import { createTapController } from "./tap-controller.ts";
import { registerSubagentEventHandlers, type LoggedChildEvent, type PendingRequest, type SubagentModeRunResult } from "./event-handlers.ts";
import {
	findStickyUserSubagentSession,
	upsertStickyUserSubagentSession,
	updateStickyUserSubagentSessionByRun,
	type StickyUserSubagentSession,
} from "./sticky-user-sessions.ts";
import type {
	AsyncCompleteEvent,
	ModeStateSessionEntry,
	NormalizedDelegationRequest,
	OrchestratorChildSessionRecord,
	OrchestratorHandbackRecord,
	OrchestratorLogCursorDetails,
	OrchestratorLogDetails,
	OrchestratorLogNextDetails,
	OrchestratorNodeLogRecord,
	OrchestratorRunMessageDetails,
	OrchestratorRunRecord,
	OrchestratorTreeDetails,
	OrchestratorTreeNodeDetails,
	ProgrammaticResultEntry,
	ProgrammaticSubagentResponse,
	RunOrigin,
	RunStatus,
} from "./types.ts";

const SUBAGENT_NOTIFY_SUPPRESS_EVENT = "subagent:notify:suppress";
const SUBAGENT_WIDGET_SUPPRESS_EVENT = "subagent:widget:suppress";
const SUBAGENT_STARTED_EVENT = "subagent:started";
const SUBAGENT_COMPLETE_EVENT = "subagent:complete";
const MODE_STATE_ENTRY_TYPE = "agent-mode-state";

const STATUS_LIST_TEXT_LIMIT = 300;
const ASYNC_ERROR_SUMMARY_LIMIT = 1000;
const DEV_STREAM_TO_FILE_ENV = "PICODE_ENABLE_DEV_STREAM_TO_FILE";

export { openSubagentStream, subagentStreamTopic, createJsonlFileSubagentStreamHandler, type OpenSubagentStreamOptions, type SubagentStreamEvent, type SubagentStreamHandler };

function isEnvEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}


function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warnOrchestratorDiagnostic(message: string, error?: unknown): void {
	const suffix = error === undefined ? "" : `: ${formatUnknownError(error)}`;
	console.warn(`[subagent-orchestrator] ${message}${suffix}`);
}

function errorResult(message: string, mode: "single" | "parallel" | "chain" = "single") {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

function successText(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: message }],
		details,
	};
}

function firstTextContent(content: Array<{ type?: string; text?: string }> | undefined): string | undefined {
	for (const item of content ?? []) {
		if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
	}
	return undefined;
}

function isToolNullResult(result: unknown): result is null {
	return result === null;
}

function lastNonEmptyLine(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

function truncateDisplayText(text: string | undefined, limit = STATUS_LIST_TEXT_LIMIT): string | undefined {
	if (typeof text !== "string" || !text.trim()) return undefined;
	const normalized = text.trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function summarizeAsyncFailure(result: SubagentModeRunResult, fallback: string): string {
	const lines = result.results
		.map((child, index) => {
			if (child.status !== "failed" && !child.error) return undefined;
			const label = `${child.agent || DEFAULT_ORCHESTRATOR_CHILD_AGENT}[${index}]`;
			const reason = child.error || lastNonEmptyLine(child.finalText) || child.status;
			return `${label}: ${reason}`;
		})
		.filter((line): line is string => Boolean(line));
	return truncateDisplayText(lines.join("\n") || fallback, ASYNC_ERROR_SUMMARY_LIMIT) ?? fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedRecentOutput(lines: string[] | undefined, limit = 6): string[] | undefined {
	if (!Array.isArray(lines)) return undefined;
	const normalized = lines.map((line) => line.trim()).filter(Boolean).slice(-limit);
	return normalized.length > 0 ? normalized : undefined;
}

function finalAnswerRecentOutput(text: string | undefined, limit = 4): string[] | undefined {
	if (typeof text !== "string") return undefined;
	return boundedRecentOutput(text.split(/\r?\n/), limit);
}

function resolveSelectedChildIndex(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[]): number | undefined {
	if (children.length === 0) return undefined;
	if (typeof run.selectedChildIndex === "number" && children.some((child) => child.childIndex === run.selectedChildIndex)) {
		return run.selectedChildIndex;
	}
	const active = children.find((child) => isRunning(child.status)) ?? children.find((child) => !isTerminal(child.status));
	return active?.childIndex ?? children[0]?.childIndex;
}

function buildRunMessageDetails(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[]): OrchestratorRunMessageDetails {
	const selectedChildIndex = resolveSelectedChildIndex(run, children);
	return {
		runId: run.orchestratorRunId,
		ownerModeId: run.ownerModeId,
		...(run.parentSessionId ? { parentSessionId: run.parentSessionId } : {}),
		requestShape: run.requestShape,
		async: run.async,
		context: run.context,
		origin: normalizeRunOrigin(run.origin),
		...(run.agent ? { agent: run.agent } : {}),
		status: run.status,
		taskSummary: run.taskSummary,
		updatedAt: run.updatedAt,
		...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
		...(run.error ? { error: run.error } : {}),
		childSessionCount: run.childSessionCount ?? children.length,
		activeChildCount: run.activeChildCount ?? children.filter((child) => isRunning(child.status)).length,
		queuedHandbackCount: run.queuedHandbackCount ?? 0,
		consumedHandbackCount: run.consumedHandbackCount ?? 0,
		...(selectedChildIndex !== undefined ? { selectedChildIndex } : {}),
		children: children.map((child) => ({
			childSessionId: child.childSessionId,
			childIndex: child.childIndex,
			status: child.status,
			taskSummary: child.taskSummary,
			...(child.currentTool ? { currentTool: child.currentTool } : {}),
			...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
			...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
			...(child.asyncDir ? { asyncDir: child.asyncDir } : {}),
			...(child.recentOutput && child.recentOutput.length > 0 ? { recentOutput: child.recentOutput } : {}),
			...(child.resultSummary ? { resultSummary: child.resultSummary } : {}),
			...(child.error ? { error: child.error } : {}),
		})),
	};
}

function summarizeTasks(request: NormalizedDelegationRequest): string {
	switch (request.shape) {
		case "single":
			return request.task ?? "Scout task";
		case "parallel":
			return request.tasks!.map((item) => item.task).join(" | ");
		case "chain":
			return request.chain!.map((item) => item.task).join(" -> ");
	}
}

function getRequestedModeLabel(request: NormalizedDelegationRequest): "single" | "parallel" | "chain" {
	return request.shape;
}

function shouldMarkChildRunningAtLaunch(request: NormalizedDelegationRequest, child: OrchestratorChildSessionRecord): boolean {
	if (!request.async) return false;
	if (request.shape !== "chain") return true;
	return (child.stepIndex ?? child.childIndex) === 0;
}

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

function knownSubagentIds(): string[] {
	return currentSubagentCards()
		.map((card) => typeof card.name === "string" ? slugifyCardName(card.name) : "")
		.filter(Boolean);
}

function findCurrentDelegationContext(ctx: ExtensionContext): { modeId?: string; knownSubagents: string[]; bannedSubagents: string[]; availableSubagents: string[] } {
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
		const card = findNamedAgentCard(currentSubagentCards(), currentSubagent);
		const bannedSubagents = parseSubagentListFrontmatter(card?.banned_subagents);
		return {
			modeId: currentSubagent,
			knownSubagents,
			bannedSubagents,
			availableSubagents: knownSubagents.filter((subagent) => !bannedSubagents.includes(subagent)),
		};
	}

	return { knownSubagents, bannedSubagents: [], availableSubagents: [] };
}

function findCurrentModeId(ctx: ExtensionContext): string | undefined {
	return findCurrentDelegationContext(ctx).modeId;
}

function normalizeRunOrigin(value: unknown): RunOrigin {
	return value === "user" ? "user" : "agent";
}

function normalizeHandbackConsumer(value: unknown): "agent" | "user" {
	return value === "user" ? "user" : "agent";
}

function currentSessionKey(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
}

function currentSessionLineage(ctx: ExtensionContext) {
	return buildSessionLineage(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
}

function runMatchesSessionLineage(
	run: Pick<OrchestratorRunRecord, "parentSessionId" | "parentSessionFile">,
	lineage: ReturnType<typeof currentSessionLineage>,
): boolean {
	return sessionReferenceInLineage(run.parentSessionFile, lineage)
		|| sessionReferenceInLineage(run.parentSessionId, lineage);
}

function childSessionMatchesSessionLineage(
	child: Pick<OrchestratorChildSessionRecord, "parentSessionId" | "parentSessionFile">,
	lineage: ReturnType<typeof currentSessionLineage>,
): boolean {
	return sessionReferenceInLineage(child.parentSessionFile, lineage)
		|| sessionReferenceInLineage(child.parentSessionId, lineage);
}

function handbackMatchesSessionLineage(
	handback: Pick<OrchestratorHandbackRecord, "parentSessionId">,
	lineage: ReturnType<typeof currentSessionLineage>,
): boolean {
	return sessionReferenceInLineage(handback.parentSessionId, lineage);
}

function stickyUserSubagentBusyMessage(agent: string): string {
	return `${agent} is busy`;
}

function createFreshPersistedUserSubagentSessionFile(ctx: ExtensionContext): string {
	const sessionDir = (ctx.sessionManager as SessionDirCapableSessionManager | undefined)?.getSessionDir?.();
	const manager = SessionManager.create(ctx.cwd, sessionDir);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		throw new Error("Failed to create a persisted child session for continued subagent context.");
	}
	return sessionFile;
}

function resolveStickyUserSubagentSession(
	ctx: ExtensionContext,
	agent: string,
): StickyUserSubagentSession | undefined {
	return findStickyUserSubagentSession(stickyUserSubagentSessions, agent, currentSessionLineage(ctx));
}

function setStickyUserSubagentSession(
	ctx: ExtensionContext,
	next: StickyUserSubagentSession,
): StickyUserSubagentSession {
	stickyUserSubagentSessions = upsertStickyUserSubagentSession(stickyUserSubagentSessions, currentSessionLineage(ctx), next);
	return resolveStickyUserSubagentSession(ctx, next.agent) ?? next;
}

function clearStickyUserSubagentRun(runId: string, updatedAt: number): void {
	stickyUserSubagentSessions = updateStickyUserSubagentSessionByRun(stickyUserSubagentSessions, runId, {
		activeRunId: undefined,
		lastUsedAt: updatedAt,
	});
}

function bindStickyUserSubagentSessionToRun(
	runId: string,
	patch: Partial<StickyUserSubagentSession>,
): void {
	stickyUserSubagentSessions = updateStickyUserSubagentSessionByRun(stickyUserSubagentSessions, runId, patch);
}

function currentAvailableSubagents(ctx: ExtensionContext): string[] {
	return findCurrentDelegationContext(ctx).availableSubagents;
}

interface SessionDirCapableSessionManager {
	getSessionDir?: () => string | undefined;
}

const modeDepthCache = new Map<string, number | undefined>();
const subagentDepthCache = new Map<string, number | undefined>();
const subagentModelCache = new Map<string, string | undefined>();
const subagentThinkingCache = new Map<string, string | undefined>();
const subagentToolSelectionCache = new Map<string, ToolSelectionSpec | undefined>();
const subagentExtensionPathsCache = new Map<string, string[] | undefined>();
const subagentInstructionsCache = new Map<string, string | undefined>();

let resolveAgentCards: (() => AgentAssetCard[]) | undefined;
let resolveSubagentCards: (() => AgentAssetCard[]) | undefined;
let stickyUserSubagentSessions: StickyUserSubagentSession[] = [];

function currentAgentCards(): AgentAssetCard[] {
	return resolveAgentCards?.() ?? [];
}

function currentSubagentCards(): AgentAssetCard[] {
	return resolveSubagentCards?.() ?? [];
}

function readModeMaxDepth(modeId: string): number | undefined {
	if (modeDepthCache.has(modeId)) return modeDepthCache.get(modeId);
	const value = readNamedAgentMaxSubagentDepthFromCards(currentAgentCards(), modeId);
	modeDepthCache.set(modeId, value);
	return value;
}

function readSubagentMaxDepth(agent: string): number | undefined {
	if (subagentDepthCache.has(agent)) return subagentDepthCache.get(agent);
	const value = readNamedAgentMaxSubagentDepthFromCards(currentSubagentCards(), agent);
	subagentDepthCache.set(agent, value);
	return value;
}

function readSubagentConfiguredModel(agent: string): string | undefined {
	if (subagentModelCache.has(agent)) return subagentModelCache.get(agent);
	const value = readNamedAgentModelFromCards(currentSubagentCards(), agent);
	subagentModelCache.set(agent, value);
	return value;
}

function resolveDelegatedSubagentModel(ctx: ExtensionContext, agent: string): string | undefined {
	return readSubagentConfiguredModel(agent) ?? formatModelReference(ctx.model);
}

function readSubagentConfiguredThinking(agent: string): string | undefined {
	if (subagentThinkingCache.has(agent)) return subagentThinkingCache.get(agent);
	const value = readNamedAgentThinkingFromCards(currentSubagentCards(), agent);
	subagentThinkingCache.set(agent, value);
	return value;
}

function resolveDelegatedSubagentThinking(agent: string, currentThinking: string | undefined): string | undefined {
	return readSubagentConfiguredThinking(agent) ?? currentThinking;
}

function readSubagentConfiguredToolSelection(agent: string): ToolSelectionSpec | undefined {
	if (subagentToolSelectionCache.has(agent)) return subagentToolSelectionCache.get(agent);
	const value = readNamedAgentToolSelectionFromCards(currentSubagentCards(), agent);
	subagentToolSelectionCache.set(agent, value);
	return value;
}

function readSubagentConfiguredExtensions(agent: string): string[] | undefined {
	if (subagentExtensionPathsCache.has(agent)) return subagentExtensionPathsCache.get(agent);
	const value = readNamedAgentExtensionPathsFromCards(currentSubagentCards(), agent);
	subagentExtensionPathsCache.set(agent, value);
	return value;
}

function pathIncludesExtension(toolPath: string, extensionPath: string): boolean {
	const normalizedToolPath = path.resolve(toolPath);
	const normalizedExtensionPath = path.resolve(extensionPath);
	return normalizedToolPath === normalizedExtensionPath || normalizedToolPath.startsWith(`${normalizedExtensionPath}${path.sep}`);
}

function getChildAvailableToolNames(pi: ExtensionAPI, additionalExtensionPaths: string[] = []): string[] {
	const childExtensionPaths = [...resolveDefaultChildExtensionPaths(), ...additionalExtensionPaths];
	const availableTools: string[] = [];
	const seen = new Set<string>();
	for (const tool of pi.getAllTools()) {
		if (!tool?.name || seen.has(tool.name)) continue;
		if (tool.sourceInfo?.source === "builtin") {
			seen.add(tool.name);
			availableTools.push(tool.name);
			continue;
		}
		const toolPath = tool.sourceInfo?.path;
		if (typeof toolPath !== "string") continue;
		if (!childExtensionPaths.some((extensionPath) => pathIncludesExtension(toolPath, extensionPath))) continue;
		seen.add(tool.name);
		availableTools.push(tool.name);
	}
	return availableTools;
}

function notifySubagentToolWarnings(ctx: ExtensionContext, agent: string, unknownTools: string[], unknownBannedTools: string[]): void {
	if (!ctx.hasUI) return;
	if (unknownTools.length > 0) {
		ctx.ui.notify(`Subagent ${agent}: unknown tools ignored: ${unknownTools.join(", ")}`, "warning");
	}
	if (unknownBannedTools.length > 0) {
		ctx.ui.notify(`Subagent ${agent}: unknown ban_tools ignored: ${unknownBannedTools.join(", ")}`, "warning");
	}
}

function resolveDelegatedSubagentTools(pi: ExtensionAPI, ctx: ExtensionContext, agent: string, additionalExtensionPaths?: string[]): string[] {
	const selection = readSubagentConfiguredToolSelection(agent);
	const resolved = resolveToolSelection(selection, {
		defaultMode: "inherit",
		availableTools: getChildAvailableToolNames(pi, additionalExtensionPaths),
		inheritedTools: pi.getActiveTools(),
	});
	const childOnlyRequestedTools = additionalExtensionPaths && additionalExtensionPaths.length > 0 && selection?.toolsMode === "list"
		? resolved.unknownRequestedTools.filter((tool) => !(selection.banTools ?? []).includes(tool))
		: [];
	const unknownRequestedTools = childOnlyRequestedTools.length > 0 ? [] : resolved.unknownRequestedTools;
	notifySubagentToolWarnings(ctx, agent, unknownRequestedTools, resolved.unknownBannedTools);
	return [...new Set([...resolved.tools, ...childOnlyRequestedTools])];
}

function readSubagentInstructions(agent: string): string | undefined {
	if (subagentInstructionsCache.has(agent)) return subagentInstructionsCache.get(agent);
	const value = readNamedAgentPromptFromCards(currentSubagentCards(), agent);
	subagentInstructionsCache.set(agent, value);
	return value;
}

function hydrateDelegationRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: NormalizedDelegationRequest,
	currentThinking?: string,
): NormalizedDelegationRequest {
	const extensions = request.extensions ?? readSubagentConfiguredExtensions(request.agent);
	return {
		...request,
		model: request.model ?? resolveDelegatedSubagentModel(ctx, request.agent),
		thinking: request.thinking ?? resolveDelegatedSubagentThinking(request.agent, currentThinking),
		tools: request.tools ?? resolveDelegatedSubagentTools(pi, ctx, request.agent, extensions),
		extensions,
		systemPrompt: request.systemPrompt ?? readSubagentInstructions(request.agent),
	};
}

function precomputeAsyncForkSessionFiles(
	ctx: ExtensionContext,
	request: NormalizedDelegationRequest,
	childCount: number,
): string[] | undefined {
	if (!request.async || request.context !== "fork" || childCount <= 0) return undefined;
	const sessionManager = ctx.sessionManager as ForkableSessionManager | undefined;
	if (!sessionManager
		|| typeof sessionManager.getSessionFile !== "function"
		|| typeof sessionManager.getLeafId !== "function"
		|| typeof sessionManager.createBranchedSession !== "function") {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}
	const resolver = createForkContextResolver(sessionManager, request.context);
	return Array.from({ length: childCount }, (_value, index) => resolver.sessionFileForIndex(index)).filter((value): value is string => typeof value === "string" && value.length > 0);
}

function mergeDefaultChildExtensions(additionalExtensions: string[] | undefined): string[] | undefined {
	if (additionalExtensions === undefined) return undefined;
	return [...new Set([...resolveDefaultChildExtensionPaths(), ...additionalExtensions])];
}

function buildSubagentModeRunSpec(
	ctx: ExtensionContext,
	modeId: string,
	request: NormalizedDelegationRequest,
	currentThinking?: string,
	childIds?: string[],
	sessionFiles?: string[],
	nodeLog?: { nodeLogsDir: string; runId: string; rootRunId?: string },
): Record<string, unknown> {
	const env = childEnv(request.agent);
	const maxSubagentDepth = resolveDelegatedRunMaxSubagentDepth({
		parentModeMaxSubagentDepth: readModeMaxDepth(modeId),
		childAgentMaxSubagentDepth: readSubagentMaxDepth(request.agent),
	});
	const model = request.model ?? resolveDelegatedSubagentModel(ctx, request.agent);
	const thinking = request.thinking ?? resolveDelegatedSubagentThinking(request.agent, currentThinking);
	const common = {
		...(thinking ? { thinking } : {}),
		context: request.context,
		async: request.async,
		env,
		maxSubagentDepth,
		...(model ? { model } : {}),
		...(request.tools !== undefined ? { tools: request.tools } : {}),
		...(request.extensions !== undefined ? { extensions: mergeDefaultChildExtensions(request.extensions) } : {}),
		...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
		...(Array.isArray(childIds) && childIds.length > 0 ? { childIds } : {}),
		...(Array.isArray(sessionFiles) && sessionFiles.length > 0 ? { sessionFiles } : {}),
		...(nodeLog ? { nodeLog } : {}),
	};
	if (request.shape === "single") {
		return {
			...common,
			mode: "single",
			agent: request.agent,
			task: request.task,
		};
	}
	if (request.shape === "parallel") {
		return {
			...common,
			mode: "parallel",
			tasks: request.tasks!.map((item) => ({ agent: request.agent, task: item.task })),
		};
	}
	return {
		...common,
		mode: "chain",
		task: request.chain?.[0]?.task ?? "",
		chain: request.chain!.map((step) => ({ agent: request.agent, task: step.task })),
	};
}

function prepareUserContinueSessionFiles(
	ctx: ExtensionContext,
	request: NormalizedDelegationRequest,
	origin: RunOrigin,
	orchestratorRunId: string,
	now: number,
	childSessionId?: string,
): { response?: ProgrammaticSubagentResponse; sessionFiles?: string[] } {
	if (origin !== "user" || request.context !== "continue" || request.shape !== "single") return {};
	const existing = resolveStickyUserSubagentSession(ctx, request.agent);
	if (existing?.activeRunId) {
		const message = stickyUserSubagentBusyMessage(request.agent);
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: {
					...errorResult(message),
					isError: true,
				},
			},
		};
	}
	const parentSessionId = currentSessionKey(ctx);
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	const sessionFile = existing?.sessionFile ?? createFreshPersistedUserSubagentSessionFile(ctx);
	setStickyUserSubagentSession(ctx, {
		agent: request.agent,
		parentSessionId,
		parentSessionFile,
		sessionFile,
		...(childSessionId ? { childSessionId } : {}),
		activeRunId: orchestratorRunId,
		createdAt: existing?.createdAt ?? now,
		lastUsedAt: now,
	});
	return { sessionFiles: [sessionFile] };
}

function buildChildSessionDetails(children: OrchestratorChildSessionRecord[]): Array<Record<string, unknown>> {
	return children.map((child) => ({
		childSessionId: child.childSessionId,
		agent: child.agent,
		childIndex: child.childIndex,
		status: child.status,
		taskSummary: child.taskSummary,
		...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
	}));
}

function prepareAgentContinueSessionFiles(
	ctx: ExtensionContext,
	request: NormalizedDelegationRequest,
	origin: RunOrigin,
	orchestratorRunId: string,
): { response?: ProgrammaticSubagentResponse; sessionFiles?: string[] } {
	if (origin !== "agent" || request.context !== "continue") return {};
	if (request.shape !== "single") {
		const message = 'context "continue" currently supports only single-task delegation via `task`.';
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	if (!request.childSessionId) {
		const message = 'childSessionId is required when context is "continue".';
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	const target = state.getChildSession(request.childSessionId);
	if (!target) {
		const message = `Child session ${request.childSessionId} was not found.`;
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	if (!childSessionMatchesSessionLineage(target, currentSessionLineage(ctx))) {
		const message = `Child session ${request.childSessionId} is not part of the current session lineage.`;
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	if (target.agent !== request.agent) {
		const message = `Child session ${request.childSessionId} belongs to subagent ${target.agent}, not ${request.agent}.`;
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	if (!target.sessionFile) {
		const message = `Child session ${request.childSessionId} cannot be continued because no persisted session file was recorded.`;
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	const busy = state.listChildSessions().find((child) => child.sessionFile === target.sessionFile && !isTerminal(child.status));
	if (busy) {
		const message = `${request.agent} continuation ${request.childSessionId} is busy.`;
		return {
			response: {
				requestId: orchestratorRunId,
				isError: true,
				errorText: message,
				result: { ...errorResult(message), isError: true },
			},
		};
	}
	return { sessionFiles: [target.sessionFile] };
}

/**
 * Adapt a subagent-mode normalized run result into the legacy
 * ProgrammaticSubagentResponse shape the orchestrator state machine already
 * consumes. Letting the V2 listener resolve `pending` with this shape keeps the
 * downstream code path unchanged across the flag.
 *
 * For async launches, the event carries `asyncDir`/`asyncId`/`pid` metadata
 * which must appear under `result.details` so the orchestrator's existing
 * async-launch handling (detecting `details.asyncId`) fires unchanged.
 */
function adaptSubagentModeResponse(
	requestId: string,
	result: SubagentModeRunResult | null,
	ok: boolean,
	errorText: string | undefined,
	asyncMeta?: { asyncDir?: string; asyncId?: string; pid?: number },
): ProgrammaticSubagentResponse {
	const overallError = !ok || (result?.status === "failed");
	const combinedText = result
		? result.results
			.map((r) => r.finalText ?? "")
			.filter((s) => s.length > 0)
			.join("\n\n---\n\n")
		: "";
	const details: Record<string, unknown> = {
		mode: result?.mode ?? "single",
		results: result
			? result.results.map((r) => ({
				agent: r.agent,
				output: r.finalText,
				finalOutput: r.finalText,
				success: r.status === "complete",
				sessionFile: r.sessionFile,
			}))
			: [],
	};
	if (asyncMeta?.asyncDir) details.asyncDir = asyncMeta.asyncDir;
	if (asyncMeta?.asyncId) details.asyncId = asyncMeta.asyncId;
	if (asyncMeta?.pid !== undefined) details.pid = asyncMeta.pid;

	return {
		requestId,
		isError: Boolean(overallError),
		errorText: errorText ?? result?.results.find((r) => r.error)?.error,
		result: {
			content: [{ type: "text", text: combinedText }],
			isError: Boolean(overallError),
			details,
		},
	} as ProgrammaticSubagentResponse;
}

function toRunStatus(status: string | undefined, success: boolean | undefined, cancelled: boolean | undefined): RunStatus {
	if (cancelled || status === "cancelled") return "cancelled";
	if (status === "failed" || success === false) return "failed";
	if (status === "complete" || success === true) return "complete";
	if (status === "running") return "running";
	return "queued";
}

function isTerminal(status: RunStatus): boolean {
	return status === "complete" || status === "failed" || status === "cancelled";
}

function isRunning(status: RunStatus): boolean {
	return status === "running";
}

export default function subagentOrchestratorExtension(pi: ExtensionAPI) {
	const state = createStateStore(path.join(process.cwd(), ".pi", "state", "subagent-orchestrator"));
	state.ensureReady();
	setActiveSubagentStreamService(createSubagentStreamService(pi, state));
	modeDepthCache.clear();
	subagentDepthCache.clear();
	subagentModelCache.clear();
	subagentThinkingCache.clear();
	subagentToolSelectionCache.clear();
	subagentExtensionPathsCache.clear();
	subagentInstructionsCache.clear();
	resolveAgentCards = () => collectAgentCards(pi);
	resolveSubagentCards = () => collectSubagentCards(pi);

	pi.registerMessageRenderer<OrchestratorRunMessageDetails>(ORCHESTRATOR_RUN_MESSAGE_TYPE, (message, _options, theme) => {
		const details = resolveRunMessageDetails(message.details);
		if (!details) return undefined;
		return createRunMessageComponent(details, theme);
	});

	pi.registerMessageRenderer(ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE, (message, options, theme) => {
		return createContinuationMessageComponent(message, options, theme);
	});

	const pending = new Map<string, PendingRequest>();
	const asyncFallbackWarnings = new Set<string>();
	const uiStatusKey = "subagent-orchestrator";
	let latestCtx: ExtensionContext | null = null;
	const devStreamFileClosers = new Map<string, () => void>();
	let asyncEvents!: ReturnType<typeof createAsyncEventManager>;
	let childEvents!: ReturnType<typeof createChildEventController>;
	let eventHandlersDisposer: (() => void) | undefined;
	let footerLifecycle!: ReturnType<typeof createFooterLifecycleController<ReturnType<typeof currentSessionLineage>>>;
	let handbackDelivery!: ReturnType<typeof createHandbackDeliveryController<ReturnType<typeof currentSessionLineage>>>;
	const tapController = createTapController({
		getRoots: (ctx) => footerLifecycle.buildVisibleTapRoots(ctx, { includeUserRuns: true }),
		openStream: (childSessionId, handler) => openSubagentStream(childSessionId, handler),
		onPoll: (ctx, selectedChildSessionId) => {
			reconcileTapAsyncRuns(ctx, selectedChildSessionId);
			handbackDelivery.flushQueuedHandbacks(ctx, { forceAgentDelivery: false });
		},
		pollIntervalMs: 2_000,
		warn: warnOrchestratorDiagnostic,
		onClose: () => {
			footerLifecycle.resetLastUiStatusText();
			footerLifecycle.updateUiStatus(latestCtx, true);
		},
	});

	childEvents = createChildEventController({
		pi,
		state,
		isTerminal,
		appendChildEntry,
		refreshRunAggregates,
		refreshRunMessageSnapshot,
		bindStickyUserSubagentSessionToRun,
	});
	asyncEvents = createAsyncEventManager({
		state,
		handleChildEvent: childEvents.handleChildEvent,
		warnDroppedChildEvent: childEvents.warnDroppedChildEvent,
		warnDiagnostic: warnOrchestratorDiagnostic,
		isTerminal,
	});
	footerLifecycle = createFooterLifecycleController({
		state,
		getLatestCtx: () => latestCtx,
		findCurrentModeId,
		currentSessionLineage,
		runMatchesSessionLineage,
		childSessionMatchesSessionLineage,
		handbackMatchesSessionLineage,
		normalizeRunOrigin,
		normalizeHandbackConsumer,
		isTerminal,
		tapController,
		uiStatusKey,
	});
	handbackDelivery = createHandbackDeliveryController({
		pi,
		state,
		getLatestCtx: () => latestCtx,
		findCurrentModeId,
		currentSessionLineage,
		handbackMatchesSessionLineage,
		normalizeHandbackConsumer,
		refreshRunAggregates,
	});

	function resolveTreeRootRun(ownerModeId: string, runId?: string): { rootRun: OrchestratorRunRecord; selectedRunId?: string } | { error: string } {
		if (typeof runId === "string" && runId.trim()) {
			const run = state.getRun(runId.trim());
			if (!run) return { error: `Subagent orchestrator run ${runId.trim()} was not found.` };
			const rootRunId = run.rootRunId ?? run.orchestratorRunId;
			const rootRun = state.getRun(rootRunId);
			if (!rootRun || rootRun.ownerModeId !== ownerModeId) {
				return { error: `Subagent orchestrator tree ${runId.trim()} is not available for mode ${ownerModeId}.` };
			}
			return { rootRun, selectedRunId: run.orchestratorRunId };
		}
		const rootRun = state.getLatestTopLevelRunForMode(ownerModeId);
		if (!rootRun) return { error: `No subagent orchestrator runs found for mode ${ownerModeId}.` };
		return { rootRun };
	}

	function buildTreeDetails(rootRun: OrchestratorRunRecord, selectedRunId?: string): OrchestratorTreeDetails {
		const children = state.listChildSessionsByRootRunId(rootRun.orchestratorRunId)
			.map((child) => ({
				childSessionId: child.childSessionId,
				runId: child.runId,
				...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
				...(child.parentChildSessionId ? { parentChildSessionId: child.parentChildSessionId } : {}),
				agent: child.agent,
				childIndex: child.childIndex,
				...(child.stepIndex !== undefined ? { stepIndex: child.stepIndex } : {}),
				...(child.taskIndex !== undefined ? { taskIndex: child.taskIndex } : {}),
				status: child.status,
				taskSummary: child.taskSummary,
				...(child.currentTool ? { currentTool: child.currentTool } : {}),
				...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
				...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
				...(child.recentOutput ? { recentOutput: child.recentOutput } : {}),
				...(child.resultSummary ? { resultSummary: child.resultSummary } : {}),
				...(child.error ? { error: child.error } : {}),
				children: [],
			})) satisfies OrchestratorTreeNodeDetails[];
		return {
			rootRunId: rootRun.orchestratorRunId,
			ownerModeId: rootRun.ownerModeId,
			status: rootRun.status,
			async: rootRun.async,
			context: rootRun.context,
			origin: normalizeRunOrigin(rootRun.origin),
			...(rootRun.agent ? { agent: rootRun.agent } : {}),
			taskSummary: rootRun.taskSummary,
			...(selectedRunId ? { selectedRunId } : {}),
			nodes: buildTreeNodes(children),
		};
	}

	function resolveCurrentTreeChild(ownerModeId: string, childSessionId: string): { child: OrchestratorChildSessionRecord; rootRun: OrchestratorRunRecord } | { error: string } {
		const child = state.getChildSession(childSessionId);
		if (!child) return { error: `Child session ${childSessionId} was not found.` };
		const currentRoot = state.getLatestTopLevelRunForMode(ownerModeId);
		if (!currentRoot) return { error: `No subagent orchestrator runs found for mode ${ownerModeId}.` };
		const childRootRunId = child.rootRunId ?? child.runId;
		if (childRootRunId !== currentRoot.orchestratorRunId) {
			return { error: `Child session ${childSessionId} is not part of the current or last delegated tree for mode ${ownerModeId}.` };
		}
		return { child, rootRun: currentRoot };
	}

	function refreshAsyncRunState(run: OrchestratorRunRecord, options?: { ingestEvents?: boolean }): OrchestratorRunRecord | undefined {
		if (options?.ingestEvents !== false) asyncEvents.ingestAsyncEventLines(run);
		const latest = state.getRun(run.orchestratorRunId) ?? run;
		if (isTerminal(latest.status)) return latest;
		return reconcileRunFromAsyncArtifacts(latest.orchestratorRunId);
	}

	function refreshRunAggregates(runId: string): void {
		const run = state.getRun(runId);
		if (!run) return;
		const children = state.listChildSessionsByRun(runId);
		const handbacks = state.listHandbacksByRun(runId);
		state.updateRun(runId, {
			childSessionCount: children.length,
			activeChildCount: children.filter((child) => isRunning(child.status)).length,
			queuedHandbackCount: handbacks.filter((entry) => entry.status === "queued").length,
			consumedHandbackCount: handbacks.filter((entry) => entry.status === "consumed").length,
			updatedAt: Date.now(),
		});
		refreshRunMessageSnapshot(runId);
		tapController.refresh();
		footerLifecycle.updateUiStatus();
	}

	function appendChildEntry(child: OrchestratorChildSessionRecord, event: "created" | "updated" | "completed" | "cancelled"): void {
		pi.appendEntry(ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, buildChildSessionEntry(child, event));
	}

	function refreshRunMessageSnapshot(runId: string): OrchestratorRunMessageDetails | undefined {
		const run = state.getRun(runId);
		if (!run) return undefined;
		return rememberRunMessageDetails(buildRunMessageDetails(run, state.listChildSessionsByRun(runId)));
	}

	function publishRunMessage(runId: string, display: boolean, ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx?.hasUI) return;
		let run = state.getRun(runId);
		if (!run) return;
		if (!run.async && !display) return;
		const details = refreshRunMessageSnapshot(runId);
		if (!display) return;
		const lineage = currentSessionLineage(runtimeCtx);
		if (!runMatchesSessionLineage(run, lineage)) return;
		pi.sendMessage({
			customType: ORCHESTRATOR_RUN_MESSAGE_TYPE,
			content: `Orchestrator status update (system-generated, not user input): delegated run ${runId} is ${run.status}.`,
			display,
			details,
		}, { triggerTurn: false });
	}

	function warnAsyncFallbackOnce(filePath: string, error: unknown): void {
		const key = `${filePath}:${formatUnknownError(error)}`;
		if (asyncFallbackWarnings.has(key)) return;
		asyncFallbackWarnings.add(key);
		warnOrchestratorDiagnostic(`could not read async completion artifact ${filePath}`, error);
	}

	function readAsyncCompletionFallback(run: OrchestratorRunRecord): AsyncCompleteEvent | undefined {
		if (!run.asyncDir) return undefined;
		const resultPath = path.join(run.asyncDir, "result.json");
		if (fs.existsSync(resultPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
					endedAt?: number;
					result?: {
						status?: RunStatus;
						results?: Array<{ agent?: string; status?: string; finalText?: string; error?: string; sessionFile?: string }>;
					};
				};
				const result = parsed.result;
				if (result && (result.status === "complete" || result.status === "failed" || result.status === "cancelled")) {
					const textSummary = (result.results ?? []).map((entry) => entry.finalText ?? entry.error ?? "").filter(Boolean).join("\n\n---\n\n");
					return {
						id: run.underlyingRunId,
						agent: result.results?.[0]?.agent ?? state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT,
						status: result.status,
						cancelled: result.status === "cancelled",
						success: result.status === "complete",
						summary: lastNonEmptyLine(textSummary) ?? `${run.taskSummary} ${result.status}`,
						results: (result.results ?? []).map((entry) => ({
							agent: entry.agent,
							output: entry.finalText,
							finalOutput: entry.finalText,
							success: entry.status === "complete",
							sessionFile: entry.sessionFile,
						})),
						timestamp: typeof parsed.endedAt === "number" ? parsed.endedAt : Date.now(),
						asyncDir: run.asyncDir,
						sessionFile: result.results?.[0]?.sessionFile,
					};
				}
			} catch (error) {
				warnAsyncFallbackOnce(resultPath, error);
				// fall through to legacy fallback
			}
		}
		const statusPath = path.join(run.asyncDir, "status.json");
		if (!fs.existsSync(statusPath)) return undefined;
		try {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8")) as {
				state?: string;
				endedAt?: number;
				sessionFile?: string;
				outputFile?: string;
				steps?: Array<{ agent?: string; status?: string }>;
			};
			const finalStatus = status.state;
			if (finalStatus !== "complete" && finalStatus !== "failed" && finalStatus !== "cancelled") return undefined;
			let output: string | undefined;
			if (typeof status.outputFile === "string" && fs.existsSync(status.outputFile)) {
				output = fs.readFileSync(status.outputFile, "utf8").trim() || undefined;
			}
			const childAgent = state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT;
			const summary = lastNonEmptyLine(output) ?? `${childAgent} ${finalStatus}`;
			return {
				id: run.underlyingRunId,
				agent: status.steps?.[0]?.agent ?? childAgent,
				status: finalStatus,
				cancelled: finalStatus === "cancelled",
				success: finalStatus === "complete",
				summary,
				results: [{
					agent: status.steps?.[0]?.agent ?? childAgent,
					output,
					success: finalStatus === "complete",
					sessionFile: status.sessionFile,
				}],
				timestamp: typeof status.endedAt === "number" ? status.endedAt : Date.now(),
				asyncDir: run.asyncDir,
				sessionFile: status.sessionFile,
			};
		} catch (error) {
			warnAsyncFallbackOnce(statusPath, error);
			return undefined;
		}
	}

	function reconcileRunFromAsyncArtifacts(runId: string): OrchestratorRunRecord | undefined {
		const run = state.getRun(runId);
		if (!run || isTerminal(run.status) || !run.async) return run;
		const fallback = readAsyncCompletionFallback(run);
		if (!fallback) return run;
		const status = toRunStatus(fallback.status, fallback.success, fallback.cancelled);
		state.updateRun(run.orchestratorRunId, {
			status,
			updatedAt: Date.now(),
			completedAt: typeof fallback.timestamp === "number" ? fallback.timestamp : Date.now(),
			resultSummary: fallback.summary,
			...(status === "failed" ? { error: fallback.summary } : {}),
		});
		finalizeChildrenFromResults(run.orchestratorRunId, fallback.results, fallback.summary, status, typeof fallback.timestamp === "number" ? fallback.timestamp : Date.now());
		pi.appendEntry(ORCHESTRATOR_COMPLETE_ENTRY_TYPE, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary: fallback.summary,
			underlyingRunId: fallback.id,
		});
		if (status !== "cancelled") handbackDelivery.queueHandback(state.getRun(run.orchestratorRunId) ?? run, fallback);
		return state.getRun(run.orchestratorRunId) ?? run;
	}

	function findCurrentOwnerModeId(ctx: ExtensionContext): string | undefined {
		const parentExecutionChildId = currentParentChildId();
		const directParentChild = parentExecutionChildId
			? state.getChildSession(parentExecutionChildId) ?? state.findChildSessionByExecutionChildId(parentExecutionChildId)
			: undefined;
		return directParentChild?.ownerModeId ?? findCurrentModeId(ctx);
	}

	function reconcileOwnedAsyncRuns(ctx: ExtensionContext, options?: { ingestEvents?: boolean }): void {
		const ownerModeId = findCurrentOwnerModeId(ctx);
		if (!ownerModeId) return;
		for (const run of state.listOwnedRuns(ownerModeId)) {
			if (!run.async) continue;
			asyncEvents.startAsyncEventTailer(run);
			refreshAsyncRunState(run, { ingestEvents: options?.ingestEvents ?? !asyncEvents.hasAsyncEventTailer(run.orchestratorRunId) });
		}
	}

	function reconcileTapAsyncRuns(ctx: ExtensionContext, selectedChildSessionId?: string): void {
		const ownerModeId = findCurrentOwnerModeId(ctx);
		if (!ownerModeId) return;
		if (!selectedChildSessionId) {
			for (const run of state.listOwnedRuns(ownerModeId)) {
				if (!run.async) continue;
				asyncEvents.startAsyncEventTailer(run);
				refreshAsyncRunState(run, { ingestEvents: !asyncEvents.hasAsyncEventTailer(run.orchestratorRunId) });
			}
			return;
		}
		const child = state.getChildSession(selectedChildSessionId);
		if (!child || child.ownerModeId !== ownerModeId) return;
		const rootRunId = child.rootRunId ?? child.runId;
		for (const run of state.listRunsByRootRunId(rootRunId)) {
			if (!run.async) continue;
			asyncEvents.startAsyncEventTailer(run);
			refreshAsyncRunState(run, { ingestEvents: !asyncEvents.hasAsyncEventTailer(run.orchestratorRunId) });
		}
	}

	function finalizeChildrenFromResults(runId: string, results: ProgrammaticResultEntry[] | undefined, fallbackText: string | undefined, status: RunStatus, now: number): void {
		const children = state.listChildSessionsByRun(runId);
		const extracted = extractChildResultPayloads(results);
		for (const child of children) {
			const result = extracted[child.childIndex];
			const finalAnswer = result?.output ?? result?.finalOutput ?? (children.length === 1 ? fallbackText : undefined);
			const nextStatus = (() => {
				if (child.status === "cancelled") return child.status;
				if (result?.success === true) return "complete";
				if (result?.success === false) return "failed";
				if (!result && child.requestShape === "chain" && child.status === "queued") return "queued";
				return status;
			})();
			const nextSessionFile = result?.sessionFile ?? child.sessionFile;
			const nextResultSummary = finalAnswer ? summarizeHandbackText(finalAnswer, 120) : child.resultSummary;
			const nextError = result?.success === false && finalAnswer
				? finalAnswer
				: status === "failed" && !result && finalAnswer
					? finalAnswer
					: child.error;
			const alreadyFinalized = isTerminal(child.status)
				&& child.status === nextStatus
				&& child.sessionFile === nextSessionFile
				&& child.resultSummary === nextResultSummary
				&& child.error === nextError;
			if (alreadyFinalized) continue;
			const updated = state.updateChildSession(child.childSessionId, {
				status: nextStatus,
				updatedAt: now,
				...(isTerminal(nextStatus) ? { completedAt: now } : {}),
				...(result?.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(finalAnswer ? { finalAnswer, resultSummary: nextResultSummary, recentOutput: finalAnswerRecentOutput(finalAnswer) } : {}),
				...(nextError ? { error: nextError } : {}),
			});
			if (updated?.sessionFile) {
				bindStickyUserSubagentSessionToRun(runId, {
					sessionFile: updated.sessionFile,
					childSessionId: updated.childSessionId,
					lastUsedAt: now,
				});
			}
			if (updated) appendChildEntry(updated, nextStatus === "cancelled" ? "cancelled" : isTerminal(nextStatus) ? "completed" : "updated");
		}
		clearStickyUserSubagentRun(runId, now);
		refreshRunAggregates(runId);
	}

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		if (event.source !== "interactive") return { action: "continue" };
		footerLifecycle.acknowledgeVisibleTerminalRuns(ctx);
		footerLifecycle.updateUiStatus(ctx, true);
		if ((event.images?.length ?? 0) > 0) return { action: "continue" };
		const currentMode = findCurrentDelegationContext(ctx);
		if (!currentMode.modeId || currentMode.availableSubagents.length === 0) return { action: "continue" };
		const parsed = parseUserDispatch(event.text, currentMode.availableSubagents, ctx.cwd);
		if (!parsed) return { action: "continue" };
		const request = hydrateDelegationRequest(pi, ctx, {
			shape: "single",
			agent: parsed.agent,
			async: true,
			context: parsed.context,
			showRunCard: false,
			task: parsed.task,
		}, pi.getThinkingLevel());
		const launched = await launchDelegatedRun(ctx, currentMode.modeId, request, { origin: "user" });
		const responseText = firstTextContent(launched.response.result.content);
		if (launched.response.isError) {
			if (ctx.hasUI) {
				ctx.ui.notify(responseText ?? launched.response.errorText ?? "Background subagent launch failed.", "warning");
			}
			return { action: "handled" };
		}
		if (ctx.hasUI) {
			const message = formatUserLaunchNotification(parsed.agent);
			ctx.ui.notify(ctx.ui.theme.fg("accent", ctx.ui.theme.bold(message)), "info");
		}
		return { action: "handled" };
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		tapController.handleCtx(ctx);
		state.ensureReady();
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new SubagentEditor(
				tui,
				theme,
				keybindings,
				() => currentAvailableSubagents(latestCtx ?? ctx),
			));
		}
		restoreRunMessageSnapshots(ctx.sessionManager.getBranch());
		reconcileOwnedAsyncRuns(ctx);
		handbackDelivery.reconcileDuplicateHandbacks(ctx);
		handbackDelivery.flushQueuedHandbacks(ctx, { forceAgentDelivery: true });
		footerLifecycle.updateUiStatus(ctx, true);
		handbackDelivery.scheduleQueuedHandbackFlush();
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		tapController.handleCtx(ctx);
		reconcileOwnedAsyncRuns(ctx);
		handbackDelivery.reconcileDuplicateHandbacks(ctx);
		handbackDelivery.flushQueuedHandbacks(ctx, { forceAgentDelivery: true });
		footerLifecycle.updateUiStatus(ctx, true);
		handbackDelivery.scheduleQueuedHandbackFlush();
	});

	pi.on("session_shutdown", async () => {
		eventHandlersDisposer?.();
		eventHandlersDisposer = undefined;
		tapController.dispose();
		latestCtx?.ui.setStatus(uiStatusKey, undefined);
		latestCtx?.ui.setEditorComponent(undefined);
		latestCtx = null;
		pending.clear();
		childEvents.clearPendingTextDeltaFlushes();
		for (const close of devStreamFileClosers.values()) close();
		devStreamFileClosers.clear();
		asyncEvents.stopAllAsyncEventTailers();
		handbackDelivery.clearQueuedHandbackFlushTimer();
		footerLifecycle.clearUiStatusTimer();
		clearRunMessageSnapshots();
		modeDepthCache.clear();
		subagentDepthCache.clear();
		subagentModelCache.clear();
		subagentThinkingCache.clear();
		subagentToolSelectionCache.clear();
		subagentExtensionPathsCache.clear();
		subagentInstructionsCache.clear();
		stickyUserSubagentSessions = [];
		resolveAgentCards = undefined;
		resolveSubagentCards = undefined;
	});

	async function launchDelegatedRun(
		ctx: ExtensionContext,
		currentModeId: string,
		request: NormalizedDelegationRequest,
		options: {
			origin: RunOrigin;
			onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void;
			signal?: AbortSignal;
		},
	): Promise<{ orchestratorRunId: string; response: ProgrammaticSubagentResponse }> {
		const orchestratorRunId = randomUUID();
		const now = Date.now();
		const parentSessionId = currentSessionKey(ctx);
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const parentExecutionChildId = currentParentChildId();
		const directParentChild = parentExecutionChildId
			? state.getChildSession(parentExecutionChildId) ?? state.findChildSessionByExecutionChildId(parentExecutionChildId)
			: undefined;
		const directParentChildSessionId = directParentChild?.childSessionId;
		const rootRunId = directParentChild?.rootRunId ?? directParentChild?.runId ?? currentTopLevelRunId() ?? orchestratorRunId;
		const parentRunId = directParentChild?.runId;
		const effectiveOwnerModeId = directParentChild?.ownerModeId ?? currentModeId;
		const depth = currentSubagentDepth();
		const baseChildSessions = buildChildSessionRecords({
			runId: orchestratorRunId,
			rootRunId,
			parentChildSessionId: directParentChildSessionId,
			ownerModeId: effectiveOwnerModeId,
			parentSessionId,
			parentSessionFile,
			agent: request.agent,
			request,
			now,
		});
		const continuePreparation = options.origin === "user"
			? prepareUserContinueSessionFiles(
				ctx,
				request,
				options.origin,
				orchestratorRunId,
				now,
				baseChildSessions[0]?.childSessionId,
			)
			: prepareAgentContinueSessionFiles(
				ctx,
				request,
				options.origin,
				orchestratorRunId,
			);
		if (continuePreparation.response) {
			return { orchestratorRunId, response: continuePreparation.response };
		}
		const sessionFiles = continuePreparation.sessionFiles ?? precomputeAsyncForkSessionFiles(ctx, request, baseChildSessions.length);
		const childSessions = sessionFiles && sessionFiles.length > 0
			? baseChildSessions.map((child, index) => ({
				...child,
				...(typeof sessionFiles[index] === "string" ? { sessionFile: sessionFiles[index] } : {}),
			}))
			: baseChildSessions;
		const launchChildSessions = childSessions.map((child) => ({
			...child,
			...(request.async && shouldMarkChildRunningAtLaunch(request, child) ? { status: "running" as RunStatus } : {}),
		}));
		const initialRunStatus: RunStatus = request.async ? "running" : "queued";

		state.createRun({
			orchestratorRunId,
			ownerModeId: effectiveOwnerModeId,
			parentSessionId,
			parentSessionFile,
			rootRunId,
			...(parentRunId ? { parentRunId } : {}),
			...(directParentChildSessionId ? { parentChildSessionId: directParentChildSessionId } : {}),
			depth,
			launchedAt: now,
			updatedAt: now,
			requestShape: request.shape,
			async: request.async,
			context: request.context,
			origin: options.origin,
			agent: request.agent,
			status: initialRunStatus,
			taskSummary: summarizeTasks(request),
			underlyingRequestId: orchestratorRunId,
			childSessionCount: launchChildSessions.length,
			activeChildCount: launchChildSessions.filter((child) => child.status === "running").length,
			queuedHandbackCount: 0,
			consumedHandbackCount: 0,
			selectedChildIndex: launchChildSessions[0]?.childIndex,
		} satisfies OrchestratorRunRecord);
		for (const child of launchChildSessions) {
			const created = state.createChildSession(child);
			childEvents.appendNodeLogForChild(created, {
				type: EVENT_SUBAGENT_TASK,
				agent: created.agent,
				timestamp: created.createdAt,
				task: created.taskSummary,
			});
			appendChildEntry(created, "created");
		}
		footerLifecycle.updateUiStatus(ctx, true);

		let settled = false;
		const settleResponse = (response: ProgrammaticSubagentResponse): void => {
			if (settled) return;
			settled = true;
			pending.delete(orchestratorRunId);
			resolveResponse(response);
		};
		let resolveResponse!: (response: ProgrammaticSubagentResponse) => void;
		const responsePromise = new Promise<ProgrammaticSubagentResponse>((resolve) => {
			resolveResponse = resolve;
			pending.set(orchestratorRunId, { orchestratorRunId, onUpdate: options.onUpdate, resolve: settleResponse });
		});
		const syncTimeoutSeconds = Math.min(request.timeoutSeconds ?? DEFAULT_SYNC_TIMEOUT_SECONDS, MAX_SYNC_TIMEOUT_SECONDS);
		const timeoutMessage = formatSyncIdleTimeoutMessage(syncTimeoutSeconds);
		let syncTimeout: ReturnType<typeof setTimeout> | undefined;
		const scheduleSyncIdleTimeout = (): void => {
			if (settled) return;
			const run = state.getRun(orchestratorRunId);
			if (run && isTerminal(run.status)) return;
			const lastActivityAt = typeof run?.updatedAt === "number" ? run.updatedAt : now;
			const delayMs = nextSyncIdleTimeoutDelayMs(lastActivityAt, Date.now(), syncTimeoutSeconds);
			if (delayMs === undefined) {
				settleResponse({
					requestId: orchestratorRunId,
					isError: true,
					errorText: timeoutMessage,
					result: {
						content: [{ type: "text", text: timeoutMessage }],
						isError: true,
						details: { mode: getRequestedModeLabel(request), results: [] },
					},
				});
				pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: orchestratorRunId });
				return;
			}
			syncTimeout = setTimeout(scheduleSyncIdleTimeout, delayMs);
			syncTimeout.unref?.();
		};
		if (!request.async) scheduleSyncIdleTimeout();

		const cancelRequest = () => {
			pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: orchestratorRunId });
			settleResponse({
				requestId: orchestratorRunId,
				isError: true,
				errorText: "delegated subagent cancelled",
				result: {
					content: [{ type: "text", text: "delegated subagent cancelled" }],
					isError: true,
					details: { mode: getRequestedModeLabel(request), results: [] },
				},
			});
		};
		if (options.signal?.aborted) cancelRequest();
		else options.signal?.addEventListener("abort", cancelRequest, { once: true });

		pi.events.emit(SUBAGENT_MODE_REQUEST_EVENT, {
			requestId: orchestratorRunId,
			spec: buildSubagentModeRunSpec(
				ctx,
				currentModeId,
				request,
				pi.getThinkingLevel(),
				launchChildSessions.map((child) => child.childSessionId),
				sessionFiles,
				{
					nodeLogsDir: state.nodeLogsDir,
					runId: orchestratorRunId,
					...(rootRunId ? { rootRunId } : {}),
				},
			),
		});

		const response = await responsePromise;
		options.signal?.removeEventListener("abort", cancelRequest);
		if (syncTimeout) clearTimeout(syncTimeout);

		response.result.details = {
			...(asRecord(response.result.details) ?? {}),
			childSessions: buildChildSessionDetails(state.listChildSessionsByRun(orchestratorRunId).length > 0
				? state.listChildSessionsByRun(orchestratorRunId)
				: launchChildSessions),
		};

		const responseText = firstTextContent(response.result.content);
		if (!request.async) {
			const finalStatus: RunStatus = response.isError ? (options.signal?.aborted ? "cancelled" : "failed") : "complete";
			state.updateRun(orchestratorRunId, {
				status: finalStatus,
				updatedAt: Date.now(),
				completedAt: Date.now(),
				...(responseText ? { resultSummary: responseText } : {}),
				...(response.isError ? { error: response.errorText ?? responseText ?? "Delegated subagent failed." } : {}),
			});
			finalizeChildrenFromResults(orchestratorRunId, response.result.details?.results, responseText, finalStatus, Date.now());
			return { orchestratorRunId, response };
		}

		if (response.isError) {
			const finalStatus: RunStatus = options.signal?.aborted ? "cancelled" : "failed";
			state.updateRun(orchestratorRunId, {
				status: finalStatus,
				updatedAt: Date.now(),
				completedAt: Date.now(),
				...(responseText ? { resultSummary: responseText } : {}),
				...(response.errorText ? { error: response.errorText } : {}),
			});
			finalizeChildrenFromResults(orchestratorRunId, response.result.details?.results, responseText, finalStatus, Date.now());
			return { orchestratorRunId, response };
		}

		const details = response.result.details ?? {};
		const existing = state.getRun(orchestratorRunId);
		state.updateRun(orchestratorRunId, {
			status: existing?.status === "cancelled" ? existing.status : "running",
			updatedAt: Date.now(),
			...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
			...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
			...(typeof details.pid === "number" ? { pid: details.pid } : {}),
			...(responseText ? { resultSummary: responseText } : {}),
		});
		if (typeof details.asyncId === "string") {
			pi.events.emit(SUBAGENT_NOTIFY_SUPPRESS_EVENT, { asyncId: details.asyncId });
			pi.events.emit(SUBAGENT_WIDGET_SUPPRESS_EVENT, { asyncId: details.asyncId });
		}
		for (const child of state.listChildSessionsByRun(orchestratorRunId)) {
			state.updateChildSession(child.childSessionId, {
				updatedAt: Date.now(),
				...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
				...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
			});
		}
		publishRunMessage(orchestratorRunId, request.showRunCard, ctx);
		refreshRunAggregates(orchestratorRunId);
		asyncEvents.startAsyncEventTailer(state.getRun(orchestratorRunId));

		return { orchestratorRunId, response };
	}

	eventHandlersDisposer = registerSubagentEventHandlers(pi, {
		events: {
			requestStarted: SUBAGENT_MODE_REQUEST_STARTED_EVENT,
			requestResponse: SUBAGENT_MODE_REQUEST_RESPONSE_EVENT,
			runComplete: SUBAGENT_MODE_RUN_COMPLETE_EVENT,
			childStarted: SUBAGENT_MODE_CHILD_STARTED_EVENT,
			childThinkingStart: SUBAGENT_MODE_CHILD_THINKING_START_EVENT,
			childThinkingEnd: SUBAGENT_MODE_CHILD_THINKING_END_EVENT,
			childTextDelta: SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT,
			childTextFinal: SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT,
			childToolStart: SUBAGENT_MODE_CHILD_TOOL_START_EVENT,
			childToolEnd: SUBAGENT_MODE_CHILD_TOOL_END_EVENT,
			childProgress: SUBAGENT_MODE_CHILD_PROGRESS_EVENT,
			childError: SUBAGENT_MODE_CHILD_ERROR_EVENT,
			childComplete: SUBAGENT_MODE_CHILD_COMPLETE_EVENT,
			childCancelled: SUBAGENT_MODE_CHILD_CANCELLED_EVENT,
			legacyStarted: SUBAGENT_STARTED_EVENT,
			legacyComplete: SUBAGENT_COMPLETE_EVENT,
			notifySuppress: SUBAGENT_NOTIFY_SUPPRESS_EVENT,
			widgetSuppress: SUBAGENT_WIDGET_SUPPRESS_EVENT,
		},
		state,
		pending,
		getLatestCtx: () => latestCtx,
		handleChildEvent: childEvents.handleChildEvent,
		refreshRunAggregates,
		adaptSubagentModeResponse,
		toRunStatus,
		summarizeAsyncFailure,
		truncateDisplayText,
		finalizeChildrenFromResults,
		queueHandback: handbackDelivery.queueHandback,
		flushQueuedHandbacks: handbackDelivery.flushQueuedHandbacks,
		asyncErrorSummaryLimit: ASYNC_ERROR_SUMMARY_LIMIT,
		completeEntryType: ORCHESTRATOR_COMPLETE_ENTRY_TYPE,
	});

	pi.registerTool({
		name: "delegate_subagent",
		label: "Delegate Subagent",
		description: "Use the subagent orchestrator to run one or more scout subagents under mediated policy.",
		promptSnippet: "delegate_subagent({ task } | { tasks } | { chain }, async?, context?, childSessionId?, showRunCard?)",
		promptGuidelines: [
			"After a successful sync delegated run, answer the user directly with the child result once.",
			"For async delegated runs, do not add any assistant launch acknowledgment after the tool call when the tool result already shows the start state and run id.",
			"For async delegated runs, the preferred behavior is silence after the tool call until the completion payload arrives.",
			"Keep showRunCard false unless the user explicitly wants a visible subagent orchestrator run card.",
			"When an async completion payload arrives, use it the same way you would use sync delegated results: answer the original request naturally instead of echoing orchestration metadata.",
			"If async completion becomes available before any launch acknowledgment would be sent, skip the launch acknowledgment entirely.",
			"Do not call delegate_subagent_status unless the user asks or completion information is otherwise unavailable.",
			"Do not treat orchestrator status updates as user-authored input.",
			"Do not repeat the same delegated result multiple times.",
		],
		parameters: DelegateSubagentParams,
		renderResult(result, { expanded }, theme, context) {
			return renderDelegateToolResult(asRecord(context.args) ?? {}, result, expanded, theme);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestCtx = ctx;
			const currentMode = findCurrentDelegationContext(ctx);
			const currentModeId = currentMode.modeId;
			if (!currentModeId) {
				return errorResult("Subagent orchestrator could not determine the current agent mode from session state.");
			}

			const normalized = normalizeDelegateInput(params as Record<string, unknown>);
			if (!normalized.request) {
				return errorResult(normalized.error ?? "Invalid subagent orchestrator request.");
			}

			const request = hydrateDelegationRequest(pi, ctx, normalized.request, pi.getThinkingLevel());
			if (!currentMode.knownSubagents.includes(request.agent)) {
				return errorResult(`Unknown subagent type ${request.agent}. Known subagents: ${currentMode.knownSubagents.join(", ") || "none"}.`);
			}
			if (currentMode.bannedSubagents.includes(request.agent)) {
				return errorResult(`Mode ${currentModeId} is banned from delegating to subagent type ${request.agent}.`);
			}
			const launched = await launchDelegatedRun(ctx, currentModeId, request, {
				origin: "agent",
				onUpdate,
				signal,
			});
			const responseText = firstTextContent(launched.response.result.content);
			if (!request.async || launched.response.isError) {
				return launched.response.result;
			}
			const details = launched.response.result.details ?? {};
			const existing = state.getRun(launched.orchestratorRunId);
			return successText(
				`Background scout orchestration started [${launched.orchestratorRunId}]. Use delegate_subagent_status to inspect it later.`,
				{
					orchestratorRunId: launched.orchestratorRunId,
					status: existing?.status === "cancelled" ? "cancelled" : "running",
					requestShape: request.shape,
					context: request.context,
					origin: normalizeRunOrigin(existing?.origin),
					childSessions: state.listChildSessionsByRun(launched.orchestratorRunId),
					...(responseText ? { resultSummary: responseText } : {}),
					...(typeof details.asyncId === "string" ? { underlyingRunId: details.asyncId } : {}),
					...(typeof details.asyncDir === "string" ? { asyncDir: details.asyncDir } : {}),
					...(typeof details.pid === "number" ? { pid: details.pid } : {}),
				},
			);
		},
	});

	if (isEnvEnabled(process.env[DEV_STREAM_TO_FILE_ENV])) {
		pi.registerTool({
			name: "dev_subagent_stream_to_file",
			label: "Dev Subagent Stream To File",
			description: `Development helper enabled by ${DEV_STREAM_TO_FILE_ENV}: open a sanitized subagent stream and append events to a JSONL file.`,
			parameters: DevSubagentStreamToFileParams,
			async execute(_toolCallId, params) {
				if (typeof params.childSessionId !== "string" || !params.childSessionId.trim()) return errorResult("childSessionId is required.");
				if (typeof params.filePath !== "string" || !params.filePath.trim()) return errorResult("filePath is required.");
				const childSessionId = params.childSessionId.trim();
				const filePath = path.resolve(process.cwd(), params.filePath.trim());
				devStreamFileClosers.get(childSessionId)?.();
				const close = openSubagentStream(
					childSessionId,
					createJsonlFileSubagentStreamHandler(filePath),
					{ includeThinking: params.includeThinking === true },
				);
				devStreamFileClosers.set(childSessionId, close);
				return successText(`Opened subagent stream ${childSessionId} to ${filePath}.`, {
					childSessionId,
					filePath,
					topic: subagentStreamTopic(childSessionId),
				});
			},
		});
	}

	pi.registerTool({
		name: "delegate_subagent_status",
		label: "Delegated Subagent Status",
		description: "List, inspect, focus, cancel, or inspect trees/logs for orchestrated scout runs owned by the current mode.",
		promptSnippet: 'delegate_subagent_status({ action: "list" | "get" | "cancel" | "next" | "prev" | "select" | "tree" | "log" | "log_cursor" | "log_next", runId?, childIndex?, childSessionId?, cursor?, includeThinking? })',
		promptGuidelines: [
			"Use this only when the user explicitly asks to inspect, focus, or cancel a delegated run, or when completion information is otherwise unavailable.",
			"Do not poll this tool immediately after an orchestrator handback or visible completion result unless you need extra metadata.",
		],
		parameters: DelegateSubagentStatusParams,
		renderResult(result, options, theme, context) {
			return renderStatusToolResult(asRecord(context.args) ?? {}, result, options.expanded, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const currentModeId = findCurrentOwnerModeId(ctx);
			if (!currentModeId) {
				return errorResult("Subagent orchestrator status could not determine the current agent mode from session state.");
			}
			const action = params.action;
			if (
				action !== "list"
				&& action !== "get"
				&& action !== "cancel"
				&& action !== "next"
				&& action !== "prev"
				&& action !== "select"
				&& action !== "tree"
				&& action !== "log"
				&& action !== "log_cursor"
				&& action !== "log_next"
			) {
				return errorResult('action must be one of "list", "get", "cancel", "next", "prev", "select", "tree", "log", "log_cursor", or "log_next".');
			}
			reconcileOwnedAsyncRuns(ctx);
			if (action === "list") {
				const runs = state.listOwnedRuns(currentModeId);
				return successText(
					formatRunList(runs, currentModeId, (runId) => state.listChildSessionsByRun(runId)),
					{
						totalRuns: runs.length,
						runs: runs.slice(0, STATUS_LIST_LIMIT).map(summarizeRunForListDetails),
					},
				);
			}
			if (action === "tree") {
				const resolved = resolveTreeRootRun(currentModeId, typeof params.runId === "string" ? params.runId : undefined);
				if ("error" in resolved) return errorResult(resolved.error);
				const details = buildTreeDetails(resolved.rootRun, resolved.selectedRunId);
				return {
					content: [{ type: "text", text: formatTree(details) }],
					details,
				};
			}
			if (action === "log" || action === "log_cursor" || action === "log_next") {
				if (typeof params.childSessionId !== "string" || !params.childSessionId.trim()) {
					return errorResult(`childSessionId is required for ${action}.`);
				}
				const includeThinking = params.includeThinking === true;
				const resolved = resolveCurrentTreeChild(currentModeId, params.childSessionId.trim());
				if ("error" in resolved) return errorResult(resolved.error);
				const { child } = resolved;
				if (action === "log") {
					const details: OrchestratorLogDetails = {
						childSessionId: child.childSessionId,
						runId: child.runId,
						...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
						status: child.status,
						includeThinking,
						records: filterNodeLogRecords(state.readNodeLog(child.childSessionId), includeThinking),
					};
					return {
						content: [{ type: "text", text: formatNodeLogLines(details.records) }],
						details,
					};
				}
				if (action === "log_cursor") {
					if (isTerminal(child.status)) {
						const details: OrchestratorLogCursorDetails = {
							childSessionId: child.childSessionId,
							runId: child.runId,
							...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
							status: child.status,
							includeThinking,
							terminal: true,
							cursor: null,
						};
						return {
							content: [{ type: "text", text: "null" }],
							details,
						};
					}
					const currentCursor = state.readNodeLogSince(child.childSessionId).cursor;
					const details: OrchestratorLogCursorDetails = {
						childSessionId: child.childSessionId,
						runId: child.runId,
						...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
						status: child.status,
						includeThinking,
						terminal: false,
						cursor: currentCursor,
					};
					return {
						content: [{ type: "text", text: `cursor: ${details.cursor}` }],
						details,
					};
				}
				let next;
				try {
					next = state.readNodeLogSince(child.childSessionId, typeof params.cursor === "string" ? params.cursor : undefined);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return errorResult(message);
				}
				const details: OrchestratorLogNextDetails = {
					childSessionId: child.childSessionId,
					runId: child.runId,
					...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
					status: child.status,
					includeThinking,
					terminal: isTerminal(child.status),
					cursor: next.cursor,
					records: filterNodeLogRecords(next.records, includeThinking),
				};
				return {
					content: [{ type: "text", text: formatNodeLogLines(details.records) }],
					details,
				};
			}
			if (typeof params.runId !== "string" || !params.runId.trim()) {
				return errorResult("runId is required for get, cancel, next, prev, and select.");
			}
			const runId = params.runId.trim();
			const run = state.getOwnedRun(currentModeId, runId);
			if (!run) {
				return errorResult(`Subagent orchestrator run ${runId} was not found for mode ${currentModeId}.`);
			}
			if (action === "get") {
				if (run.async && isTerminal(run.status)) {
					handbackDelivery.consumeQueuedHandbacksForRun(run.orchestratorRunId);
				}
				const refreshedRun = state.getOwnedRun(currentModeId, runId) ?? run;
				const children = state.listChildSessionsByRun(refreshedRun.orchestratorRunId);
				const handbacks = state.listHandbacksByRun(refreshedRun.orchestratorRunId);
				return successText(formatRunDetails(refreshedRun, children, handbacks), { run: refreshedRun, children, handbacks });
			}

			if (action === "next" || action === "prev" || action === "select") {
				const selection = selectRunChild(state, runId, action, typeof params.childIndex === "number" ? params.childIndex : undefined);
				if (selection.error) return errorResult(selection.error);
				return successText(
					selection.child
						? `Focused child [${selection.child.childIndex}] for run ${runId}.`
						: `Updated child focus for run ${runId}.`,
					{ run: selection.run, child: selection.child },
				);
			}

			if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
				return successText(`Run ${runId} is already ${run.status}.`, { run });
			}

			let cancelMessage = `Cancellation requested for run ${runId}.`;
			if (run.async) {
				const asyncRunId = run.underlyingRunId;
				if (!asyncRunId) {
					return errorResult(`Run ${runId} cannot be cancelled because no async run id is available.`, getRequestedModeLabel({ shape: run.requestShape, async: run.async, context: run.context } as NormalizedDelegationRequest));
				}
				if (run.underlyingRequestId) pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: run.underlyingRequestId });
				const cancelled = cancelAsyncRun(asyncRunId, { pid: run.pid, allowUnverifiedPid: true });
				if (!cancelled.ok) return errorResult(`Run ${runId} cancellation failed: ${cancelled.message ?? "unknown error"}`);
				if (cancelled.alreadyFinished) {
					const refreshed = refreshAsyncRunState(run, { ingestEvents: true });
					return successText(`Run ${runId} ${cancelled.message ?? "already finished"}.`, { run: refreshed });
				}
				cancelMessage = `Cancellation requested for run ${runId}. ${cancelled.message ?? ""}`.trim();
			} else {
				// underlyingRequestId is the orchestrator-run-id that the bridge's
				// `active` map is keyed by. It exists for live sync runs.
				if (!run.underlyingRequestId) {
					return errorResult(`Run ${runId} cannot be cancelled because no live cancellation handle is available.`, getRequestedModeLabel({ shape: run.requestShape, async: run.async, context: run.context } as NormalizedDelegationRequest));
				}
				pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: run.underlyingRequestId });
			}

			const updated = state.updateRun(runId, {
				status: "cancelled",
				updatedAt: Date.now(),
				completedAt: Date.now(),
				resultSummary: "Cancelled by delegate_subagent_status.",
			});
			for (const child of state.listChildSessionsByRun(runId)) {
				state.updateChildSession(child.childSessionId, {
					status: "cancelled",
					updatedAt: Date.now(),
					completedAt: Date.now(),
					resultSummary: "Cancelled by delegate_subagent_status.",
				});
			}
			refreshRunAggregates(runId);
			return successText(cancelMessage ?? `Cancelled run ${runId}.`, { run: updated ?? run });
		},
	});
}

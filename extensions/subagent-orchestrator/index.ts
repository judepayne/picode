import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { keyHint, SessionManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { DEFAULT_ORCHESTRATOR_CHILD_AGENT, childEnv } from "./policy.ts";
import { collectAgentFiles, collectSubagentFiles, type AgentAssetFile } from "../agent-assets/contract.ts";
import { resolveToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { buildHandbackDeduplicationKey, buildQueuedHandback, extractChildResultPayloads, partitionHandbackDuplicates, summarizeHandbackText } from "./handbacks.ts";
import { buildSessionLineage, sessionReferenceInLineage } from "./session-lineage.ts";
import { formatModelReference, readNamedAgentInstructionsFromFiles, readNamedAgentModelFromFiles, readNamedAgentThinkingFromFiles, readNamedAgentToolSelectionFromFiles } from "./subagent-model.ts";
import { SubagentEditor } from "./subagent-editor.ts";
import { normalizeDelegateInput } from "./delegate-input.ts";
import { parseUserDispatch } from "./user-dispatch.ts";
import { currentParentChildId, currentSubagentDepth, currentTopLevelRunId } from "../subagent-mode/depth.ts";
import { resolveDefaultChildExtensionPaths } from "../subagent-mode/runner.ts";
import { createForkContextResolver, type ForkableSessionManager } from "../subagent-mode/fork-context.ts";
import { readNamedAgentMaxSubagentDepthFromFiles, resolveDelegatedRunMaxSubagentDepth } from "./max-subagent-depth.ts";
import { rememberRunMessageDetails, getRenderableRunSnapshot, ORCHESTRATOR_RUN_MESSAGE_TYPE, resolveRunMessageDetails, restoreRunMessageSnapshots, clearRunMessageSnapshots } from "./run-live-state.ts";
import { formatRunCardLines, shortenDisplayPath } from "./run-ui.ts";
import { formatBackgroundFailureNotification, formatFooterStatus, formatUserLaunchNotification } from "./footer-status.ts";
import { buildChildSessionEntry, buildContinuationEntry, buildHandbackEntry, formatContinuationTitle, ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, ORCHESTRATOR_COMPLETE_ENTRY_TYPE, ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE, ORCHESTRATOR_HANDBACK_ENTRY_TYPE } from "./session-entries.ts";
import { buildChildSessionRecords } from "./session-model.ts";
import { createStateStore } from "./state.ts";
import { DEFAULT_SYNC_TIMEOUT_SECONDS, MAX_SYNC_TIMEOUT_SECONDS } from "./timeout.ts";
import {
	findStickyUserSubagentSession,
	upsertStickyUserSubagentSession,
	updateStickyUserSubagentSessionByRun,
	type StickyUserSubagentSession,
} from "./sticky-user-sessions.ts";
import type {
	AsyncCompleteEvent,
	AsyncStartedEvent,
	ModeStateSessionEntry,
	NormalizedDelegationRequest,
	OrchestratorChildSessionRecord,
	OrchestratorContinuationMessageDetails,
	OrchestratorContinuationRecord,
	OrchestratorHandbackRecord,
	OrchestratorLogDetails,
	OrchestratorNodeLogRecord,
	OrchestratorRunMessageDetails,
	OrchestratorRunRecord,
	OrchestratorStreamDetails,
	OrchestratorStreamNextDetails,
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

// Runner contract — delegation flows through agent/extensions/subagent-mode/.
const SUBAGENT_MODE_REQUEST_EVENT = "subagent:mode:request";
const SUBAGENT_MODE_REQUEST_STARTED_EVENT = "subagent:mode:request.started";
const SUBAGENT_MODE_REQUEST_RESPONSE_EVENT = "subagent:mode:request.response";
const SUBAGENT_MODE_CANCEL_EVENT = "subagent:mode:cancel";
const SUBAGENT_MODE_CHILD_STARTED_EVENT = "subagent:mode:child.started";
const SUBAGENT_MODE_CHILD_THINKING_START_EVENT = "subagent:mode:child.thinking.start";
const SUBAGENT_MODE_CHILD_THINKING_END_EVENT = "subagent:mode:child.thinking.end";
const SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT = "subagent:mode:child.text.delta";
const SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT = "subagent:mode:child.text.final";
const SUBAGENT_MODE_CHILD_TOOL_START_EVENT = "subagent:mode:child.tool.start";
const SUBAGENT_MODE_CHILD_TOOL_END_EVENT = "subagent:mode:child.tool.end";
const SUBAGENT_MODE_CHILD_PROGRESS_EVENT = "subagent:mode:child.progress";
const SUBAGENT_MODE_CHILD_ERROR_EVENT = "subagent:mode:child.error";
const SUBAGENT_MODE_CHILD_COMPLETE_EVENT = "subagent:mode:child.complete";
const SUBAGENT_MODE_CHILD_CANCELLED_EVENT = "subagent:mode:child.cancelled";
const SUBAGENT_MODE_RUN_COMPLETE_EVENT = "subagent:mode:run.complete";

interface SubagentModeChildResult {
	childId: string;
	agent: string;
	status: "complete" | "failed" | "cancelled";
	finalText?: string;
	error?: string;
	sessionFile?: string;
	usage?: { input?: number; output?: number; total?: number };
}

interface SubagentModeRunResult {
	runId: string;
	mode: "single" | "parallel" | "chain";
	status: "queued" | "running" | "complete" | "failed" | "cancelled";
	results: SubagentModeChildResult[];
}

const DelegateTaskSchema = Type.Object({
	task: Type.String({ description: "The subagent task to run." }),
}, { additionalProperties: false });

const DelegateSubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "The subagent type to run (defaults to scout)." })),
	task: Type.Optional(Type.String({ description: "Run one subagent task." })),
	tasks: Type.Optional(Type.Array(DelegateTaskSchema, { description: "Run multiple subagents in parallel." })),
	chain: Type.Optional(Type.Array(DelegateTaskSchema, { description: "Run a sequential chain of subagent tasks." })),
	async: Type.Optional(Type.Boolean({ description: "Run in the background and return immediately with a run id." })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SYNC_TIMEOUT_SECONDS, description: `Timeout for synchronous delegated runs in seconds. Defaults to ${DEFAULT_SYNC_TIMEOUT_SECONDS}. Async runs do not use it, but if provided it must still be within range.` })),
	context: Type.Optional(Type.Union([
		Type.Literal("fresh"),
		Type.Literal("fork"),
		Type.Literal("continue"),
	], { description: "Execution context for child subagents." })),
	childSessionId: Type.Optional(Type.String({ description: 'Explicit child session id to continue when context is "continue".' })),
	showRunCard: Type.Optional(Type.Boolean({ description: "Show a visible subagent orchestrator run card in the UI. Defaults to false." })),
}, { additionalProperties: false });

const DelegateSubagentStatusParams = Type.Object({
	action: Type.String({ description: 'One of "list", "get", "cancel", "next", "prev", "select", "tree", "log", "stream", or "stream_next".' }),
	runId: Type.Optional(Type.String({ description: "The orchestrator run id for get/cancel/next/prev/select/tree." })),
	childIndex: Type.Optional(Type.Number({ description: "The child index for action: \"select\"." })),
	childSessionId: Type.Optional(Type.String({ description: 'The child session id for action: "log", "stream", or "stream_next".' })),
	cursor: Type.Optional(Type.String({ description: 'The cursor for action: "stream_next".' })),
	includeThinking: Type.Optional(Type.Boolean({ description: "Include thinking events in log and stream responses." })),
}, { additionalProperties: false });

interface PendingRequest {
	orchestratorRunId: string;
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void;
	resolve: (response: ProgrammaticSubagentResponse) => void;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requestedDelegatedAgent(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : DEFAULT_ORCHESTRATOR_CHILD_AGENT;
}

function delegatedSubject(args: Record<string, unknown>): string {
	const agent = requestedDelegatedAgent(args.agent);
	if (Array.isArray(args.chain)) return `${agent} chain (${args.chain.length} step${args.chain.length === 1 ? "" : "s"})`;
	if (Array.isArray(args.tasks)) return `${args.tasks.length} ${agent}${args.tasks.length === 1 ? "" : "s"}`;
	return agent;
}

function delegatedShapeLabel(args: Record<string, unknown>): string {
	if (Array.isArray(args.chain)) return `chain(${args.chain.length} step${args.chain.length === 1 ? "" : "s"})`;
	if (Array.isArray(args.tasks)) return `parallel(${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"})`;
	return "single";
}

function shortRunId(runId: string | undefined): string | undefined {
	if (typeof runId !== "string" || !runId.trim()) return undefined;
	return runId.slice(0, 8);
}

function renderToolText(text: string | undefined): Text {
	return new Text(text ? `\n${text}` : "", 0, 0);
}

function collapsePreview(text: string | undefined, maxLines = 8, maxChars = 280): string | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const lines = trimmed.split(/\r?\n/);
	const sliced = lines.slice(0, maxLines).join("\n");
	if (trimmed.length <= maxChars && lines.length <= maxLines) return trimmed;
	const shortened = sliced.length > maxChars ? `${sliced.slice(0, maxChars - 1).trimEnd()}…` : sliced;
	return `${shortened}\n…`;
}

function delegateMetaLine(args: Record<string, unknown>, result: { details?: unknown; isError?: boolean }): string {
	const details = asRecord(result.details);
	const runId = typeof details?.orchestratorRunId === "string" ? details.orchestratorRunId : undefined;
	const isAsync = args.async === true || typeof runId === "string";
	const status = typeof details?.status === "string"
		? details.status
		: result.isError
			? "failed"
			: isAsync
				? "running"
				: undefined;
	const context = args.context === "fork"
		? "fork"
		: args.context === "continue"
			? "continue"
			: "fresh";
	const parts = [isAsync ? "async" : "sync"];
	if (isAsync && status) parts.push(status);
	else if (!isAsync && result.isError && status) parts.push(status);
	parts.push(requestedDelegatedAgent(args.agent));
	parts.push(delegatedShapeLabel(args));
	parts.push(`context=${context}`);
	const shortId = shortRunId(runId);
	if (isAsync && shortId) parts.push(`run=${shortId}`);
	return parts.join(" · ");
}

function delegateResultBody(args: Record<string, unknown>, result: { content?: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean }, expanded: boolean): string | undefined {
	const subject = delegatedSubject(args);
	const details = asRecord(result.details);
	const runId = typeof details?.orchestratorRunId === "string" ? details.orchestratorRunId : undefined;
	const text = firstTextContent(result.content);
	// Collapsed delegate results: 2 lines / ~140 chars — child outputs are
	// often long unwrapped paragraphs, so the default 8-line preview shows
	// nearly the whole result. The agent echoes it afterward anyway.
	if (result.isError) return expanded ? text : collapsePreview(text, 2, 140) ?? `Delegated ${subject} failed.`;
	if (args.async === true || typeof runId === "string") return undefined;
	return expanded ? text : collapsePreview(text, 2, 140) ?? `Completed delegated ${subject}.`;
}

function renderDelegateToolResult(
	args: Record<string, unknown>,
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean },
	expanded: boolean,
	theme: ExtensionContext["ui"]["theme"],
): Text {
	const details = asRecord(result.details);
	const runId = typeof details?.orchestratorRunId === "string" ? details.orchestratorRunId : undefined;
	const shortId = shortRunId(runId);
	const plainMeta = delegateMetaLine(args, result);
	const meta = shortId && plainMeta.endsWith(`run=${shortId}`)
		? `${theme.fg("muted", plainMeta.slice(0, -(`run=${shortId}`.length)))}${theme.fg("muted", "run=")}${theme.bold(shortId)}`
		: theme.fg("muted", plainMeta);
	const collapsedBody = delegateResultBody(args, result, false);
	const expandedBody = delegateResultBody(args, result, true);
	const body = expanded ? expandedBody : collapsedBody;
	const showExpandHint = !expanded
		&& typeof collapsedBody === "string"
		&& typeof expandedBody === "string"
		&& collapsedBody !== expandedBody;
	const hint = showExpandHint ? theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`) : undefined;
	const rendered = [
		meta,
		body ? theme.fg("toolOutput", body) : undefined,
	].filter(Boolean).join("\n");
	return new Text(hint ? `${rendered}\n\n${hint}` : rendered, 0, 0);
}

function renderStatusToolResult(
	args: Record<string, unknown>,
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean } | null,
	expanded: boolean,
	theme: ExtensionContext["ui"]["theme"],
): Text {
	if (result === null) return new Text(theme.fg("toolOutput", "null"), 0, 0);
	const details = asRecord(result.details);
	if (details?.terminal === true && details.cursor === null) {
		return new Text(theme.fg("toolOutput", "null"), 0, 0);
	}
	const summary = theme.fg("muted", summarizeStatusToolResult(args, result));
	const text = firstTextContent(result.content);
	if (!text) return new Text(summary, 0, 0);
	const collapsedBody = collapsePreview(text, 8, 280) ?? text;
	const expandedBody = text;
	const body = expanded ? expandedBody : collapsedBody;
	const showExpandHint = !expanded && collapsedBody !== expandedBody;
	const hint = showExpandHint ? theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`) : undefined;
	const rendered = [summary, theme.fg("toolOutput", body)].filter(Boolean).join("\n");
	return new Text(hint ? `${rendered}\n\n${hint}` : rendered, 0, 0);
}

function summarizeStatusToolResult(args: Record<string, unknown>, result: { content?: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean } | null): string {
	if (result === null) return "Loaded delegated child stream terminal state.";
	if (result.isError) return "Delegated subagent status failed.";
	const details = asRecord(result.details);
	if (details?.terminal === true && details.cursor === null) return "Loaded delegated child stream terminal state.";
	const action = typeof args.action === "string" ? args.action : "get";
	const runId = typeof args.runId === "string" ? args.runId : undefined;
	if (action === "list") return "Listed delegated runs.";
	if (action === "cancel") return runId ? `Cancelled delegated run ${runId}.` : "Cancelled delegated run.";
	if (action === "next" || action === "prev" || action === "select") return "Updated delegated child focus.";
	if (action === "get") return runId ? `Loaded delegated run ${runId}.` : "Loaded delegated run details.";
	if (action === "tree") return runId ? `Loaded delegated tree for ${runId}.` : "Loaded delegated tree.";
	if (action === "log") return "Loaded delegated child log.";
	if (action === "stream") return "Loaded delegated child stream cursor.";
	if (action === "stream_next") return "Loaded delegated child stream updates.";
	const fallback = firstTextContent(result.content);
	return fallback ? (lastNonEmptyLine(fallback) ?? fallback) : "Delegated subagent status updated.";
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function childOutputLogPath(child: Pick<OrchestratorChildSessionRecord, "asyncDir" | "childIndex">): string | undefined {
	if (!child.asyncDir) return undefined;
	const outputPath = path.join(child.asyncDir, `output-${child.childIndex}.log`);
	return fs.existsSync(outputPath) ? outputPath : undefined;
}

function childOpenCommand(child: Pick<OrchestratorChildSessionRecord, "sessionFile">): string | undefined {
	return child.sessionFile ? `pi --session ${quoteShellArg(child.sessionFile)}` : undefined;
}

function childViewCommand(child: Pick<OrchestratorChildSessionRecord, "asyncDir" | "childIndex">): string | undefined {
	const outputPath = childOutputLogPath(child);
	return outputPath ? `tail -f ${quoteShellArg(outputPath)}` : undefined;
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

function selectRunChild(stateStore: ReturnType<typeof createStateStore>, runId: string, direction: "next" | "prev" | "select", childIndex?: number): { run?: OrchestratorRunRecord; child?: OrchestratorChildSessionRecord; error?: string } {
	const run = stateStore.getRun(runId);
	if (!run) return { error: `Run ${runId} was not found.` };
	const children = stateStore.listChildSessionsByRun(runId);
	if (children.length === 0) return { error: `Run ${runId} has no child sessions.` };
	const ordered = [...children].sort((a, b) => a.childIndex - b.childIndex);
	const current = resolveSelectedChildIndex(run, ordered) ?? ordered[0]!.childIndex;
	let nextIndex = current;
	if (direction === "select") {
		if (typeof childIndex !== "number" || !Number.isInteger(childIndex)) return { error: "childIndex must be an integer for action: \"select\"." };
		if (!ordered.some((child) => child.childIndex === childIndex)) return { error: `Run ${runId} has no child with index ${childIndex}.` };
		nextIndex = childIndex;
	} else {
		const currentPos = Math.max(0, ordered.findIndex((child) => child.childIndex === current));
		const delta = direction === "next" ? 1 : -1;
		const nextPos = (currentPos + delta + ordered.length) % ordered.length;
		nextIndex = ordered[nextPos]!.childIndex;
	}
	const updated = stateStore.updateRun(runId, { selectedChildIndex: nextIndex, updatedAt: Date.now() }) ?? run;
	const selectedChild = ordered.find((child) => child.childIndex === nextIndex);
	return { run: updated, child: selectedChild };
}

function createRunMessageComponent(
	details: OrchestratorRunMessageDetails,
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getRenderableRunSnapshot(details);
		if (snapshot.version !== lastVersion) {
			lastVersion = snapshot.version;
			container.clear();
			container.addChild(new Spacer(1));
			const boxTheme = snapshot.details.status === "failed"
				? "toolErrorBg"
				: snapshot.details.status === "complete"
					? "toolSuccessBg"
					: "toolPendingBg";
			const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
			const inner = new Container();
			inner.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent orchestrator run card")), 0, 0));
			inner.addChild(new Text("", 0, 0));
			for (const line of formatRunCardLines(snapshot.details)) {
				inner.addChild(new Text(line, 0, 0));
			}
			box.addChild(inner);
			container.addChild(box);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
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

function normalizeAllowedSubagents(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const subagents = value
		.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "")
		.filter(Boolean);
	return subagents.length > 0 ? subagents : undefined;
}

function findCurrentModeState(ctx: ExtensionContext): { modeId?: string; subagents?: string[] } {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as ModeStateSessionEntry;
		if (entry?.type !== "custom" || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
		const modeId = entry.data?.modeId?.trim().toLowerCase();
		if (!modeId) continue;
		const subagents = normalizeAllowedSubagents(entry.data?.subagents);
		return {
			modeId,
			...(subagents ? { subagents } : {}),
		};
	}
	return {};
}

function findCurrentModeId(ctx: ExtensionContext): string | undefined {
	return findCurrentModeState(ctx).modeId;
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

function currentAllowedSubagents(ctx: ExtensionContext): string[] {
	return findCurrentModeState(ctx).subagents ?? [];
}

interface SessionDirCapableSessionManager {
	getSessionDir?: () => string | undefined;
}

const modeDepthCache = new Map<string, number | undefined>();
const subagentDepthCache = new Map<string, number | undefined>();
const subagentModelCache = new Map<string, string | undefined>();
const subagentThinkingCache = new Map<string, string | undefined>();
const subagentToolSelectionCache = new Map<string, ToolSelectionSpec | undefined>();
const subagentInstructionsCache = new Map<string, string | undefined>();

let resolveAgentAssetFiles: (() => AgentAssetFile[]) | undefined;
let resolveSubagentAssetFiles: (() => AgentAssetFile[]) | undefined;
let stickyUserSubagentSessions: StickyUserSubagentSession[] = [];

function currentAgentAssetFiles(): AgentAssetFile[] {
	return resolveAgentAssetFiles?.() ?? [];
}

function currentSubagentAssetFiles(): AgentAssetFile[] {
	return resolveSubagentAssetFiles?.() ?? [];
}

function readModeMaxDepth(modeId: string): number | undefined {
	if (modeDepthCache.has(modeId)) return modeDepthCache.get(modeId);
	const value = readNamedAgentMaxSubagentDepthFromFiles(currentAgentAssetFiles(), modeId);
	modeDepthCache.set(modeId, value);
	return value;
}

function readSubagentMaxDepth(agent: string): number | undefined {
	if (subagentDepthCache.has(agent)) return subagentDepthCache.get(agent);
	const value = readNamedAgentMaxSubagentDepthFromFiles(currentSubagentAssetFiles(), agent);
	subagentDepthCache.set(agent, value);
	return value;
}

function readSubagentConfiguredModel(agent: string): string | undefined {
	if (subagentModelCache.has(agent)) return subagentModelCache.get(agent);
	const value = readNamedAgentModelFromFiles(currentSubagentAssetFiles(), agent);
	subagentModelCache.set(agent, value);
	return value;
}

function resolveDelegatedSubagentModel(ctx: ExtensionContext, agent: string): string | undefined {
	return readSubagentConfiguredModel(agent) ?? formatModelReference(ctx.model);
}

function readSubagentConfiguredThinking(agent: string): string | undefined {
	if (subagentThinkingCache.has(agent)) return subagentThinkingCache.get(agent);
	const value = readNamedAgentThinkingFromFiles(currentSubagentAssetFiles(), agent);
	subagentThinkingCache.set(agent, value);
	return value;
}

function resolveDelegatedSubagentThinking(agent: string, currentThinking: string | undefined): string | undefined {
	return readSubagentConfiguredThinking(agent) ?? currentThinking;
}

function readSubagentConfiguredToolSelection(agent: string): ToolSelectionSpec | undefined {
	if (subagentToolSelectionCache.has(agent)) return subagentToolSelectionCache.get(agent);
	const value = readNamedAgentToolSelectionFromFiles(currentSubagentAssetFiles(), agent);
	subagentToolSelectionCache.set(agent, value);
	return value;
}

function pathIncludesExtension(toolPath: string, extensionPath: string): boolean {
	const normalizedToolPath = path.resolve(toolPath);
	const normalizedExtensionPath = path.resolve(extensionPath);
	return normalizedToolPath === normalizedExtensionPath || normalizedToolPath.startsWith(`${normalizedExtensionPath}${path.sep}`);
}

function getChildAvailableToolNames(pi: ExtensionAPI): string[] {
	const childExtensionPaths = resolveDefaultChildExtensionPaths();
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

function resolveDelegatedSubagentTools(pi: ExtensionAPI, ctx: ExtensionContext, agent: string): string[] {
	const resolved = resolveToolSelection(readSubagentConfiguredToolSelection(agent), {
		defaultMode: "inherit",
		availableTools: getChildAvailableToolNames(pi),
		inheritedTools: pi.getActiveTools(),
	});
	notifySubagentToolWarnings(ctx, agent, resolved.unknownRequestedTools, resolved.unknownBannedTools);
	return resolved.tools;
}

function readSubagentInstructions(agent: string): string | undefined {
	if (subagentInstructionsCache.has(agent)) return subagentInstructionsCache.get(agent);
	const value = readNamedAgentInstructionsFromFiles(currentSubagentAssetFiles(), agent);
	subagentInstructionsCache.set(agent, value);
	return value;
}

function hydrateDelegationRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: NormalizedDelegationRequest,
	currentThinking?: string,
): NormalizedDelegationRequest {
	return {
		...request,
		model: request.model ?? resolveDelegatedSubagentModel(ctx, request.agent),
		thinking: request.thinking ?? resolveDelegatedSubagentThinking(request.agent, currentThinking),
		tools: request.tools ?? resolveDelegatedSubagentTools(pi, ctx, request.agent),
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

function buildSubagentModeRunSpec(
	ctx: ExtensionContext,
	modeId: string,
	request: NormalizedDelegationRequest,
	currentThinking?: string,
	childIds?: string[],
	sessionFiles?: string[],
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
		...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
		...(Array.isArray(childIds) && childIds.length > 0 ? { childIds } : {}),
		...(Array.isArray(sessionFiles) && sessionFiles.length > 0 ? { sessionFiles } : {}),
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

function formatRunList(
	runs: OrchestratorRunRecord[],
	ownerModeId: string,
	childLookup?: (runId: string) => OrchestratorChildSessionRecord[],
): string {
	if (runs.length === 0) return `No subagent orchestrator runs found for mode ${ownerModeId}.`;
	const lines = [`Subagent orchestrator runs for mode ${ownerModeId}:`, ""];
	for (const run of runs) {
		lines.push(`- ${run.orchestratorRunId} | ${run.status} | ${run.requestShape} | async=${run.async} | context=${run.context} | origin=${normalizeRunOrigin(run.origin)}${run.agent ? ` | agent=${run.agent}` : ""}`);
		lines.push(`  task: ${run.taskSummary}`);
		lines.push(`  children: ${run.activeChildCount ?? 0}/${run.childSessionCount ?? 0} running | queued handbacks: ${run.queuedHandbackCount ?? 0}`);
		if (run.selectedChildIndex !== undefined) lines.push(`  focused child: [${run.selectedChildIndex}]`);
		const children = childLookup?.(run.orchestratorRunId) ?? [];
		const activeChildren = children.filter((child) => isRunning(child.status));
		if (activeChildren.length > 0) {
			lines.push("  running child sessions:");
			for (const child of activeChildren) {
				const childBits = [`[${child.childIndex}]`, child.status, child.taskSummary];
				if (child.currentTool) childBits.push(`tool=${child.currentTool}${child.toolCount !== undefined ? `(${child.toolCount})` : ""}`);
				lines.push(`    - ${childBits.join(" | ")}`);
				if (child.sessionFile) lines.push(`      session: ${shortenDisplayPath(child.sessionFile)}`);
				const open = childOpenCommand(child);
				if (open) lines.push(`      open: ${open}`);
				const view = childViewCommand(child);
				if (view) lines.push(`      view: ${view}`);
			}
		}
		if (run.resultSummary) lines.push(`  result: ${run.resultSummary}`);
		if (run.error) lines.push(`  error: ${run.error}`);
	}
	return lines.join("\n");
}

function formatRunDetails(run: OrchestratorRunRecord, children: OrchestratorChildSessionRecord[], handbacks: OrchestratorHandbackRecord[]): string {
	const lines = [
		`runId: ${run.orchestratorRunId}`,
		`ownerModeId: ${run.ownerModeId}`,
		`status: ${run.status}`,
		`shape: ${run.requestShape}`,
		`async: ${run.async}`,
		`context: ${run.context}`,
		`origin: ${normalizeRunOrigin(run.origin)}`,
		run.agent ? `agent: ${run.agent}` : undefined,
		`taskSummary: ${run.taskSummary}`,
		run.underlyingRequestId ? `underlyingRequestId: ${run.underlyingRequestId}` : undefined,
		run.underlyingRunId ? `underlyingRunId: ${run.underlyingRunId}` : undefined,
		run.pid !== undefined ? `pid: ${run.pid}` : undefined,
		run.asyncDir ? `asyncDir: ${run.asyncDir}` : undefined,
		run.resultSummary ? `resultSummary: ${run.resultSummary}` : undefined,
		run.error ? `error: ${run.error}` : undefined,
		`childSessions: ${children.length}`,
		`queuedHandbacks: ${handbacks.filter((entry) => entry.status === "queued").length}`,
		run.selectedChildIndex !== undefined ? `selectedChildIndex: ${run.selectedChildIndex}` : undefined,
	].filter(Boolean);
	if (children.length > 0) {
		lines.push("", "Child sessions:");
		for (const child of children) {
			lines.push(`- [${child.childIndex}] ${child.status} | ${child.taskSummary}`);
			if (child.currentTool) lines.push(`  tool: ${child.currentTool}${child.toolCount !== undefined ? ` (${child.toolCount})` : ""}`);
			if (child.sessionFile) lines.push(`  session: ${shortenDisplayPath(child.sessionFile)}`);
			const open = childOpenCommand(child);
			if (open) lines.push(`  open: ${open}`);
			const view = childViewCommand(child);
			if (view) lines.push(`  view: ${view}`);
			if (child.recentOutput && child.recentOutput.length > 0) {
				lines.push("  recentOutput:");
				for (const line of child.recentOutput.slice(-4)) lines.push(`    ${line}`);
			}
			if (child.resultSummary) lines.push(`  result: ${child.resultSummary}`);
			if (child.error) lines.push(`  error: ${child.error}`);
		}
	}
	if (handbacks.length > 0) {
		lines.push("", "Handbacks:");
		for (const handback of handbacks) {
			lines.push(`- ${handback.handbackId} | ${handback.status} | ${handback.summary}`);
		}
	}
	return lines.join("\n");
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

interface LoggedChildEvent extends Record<string, unknown> {
	type?: string;
	runId?: string;
	childId?: string;
	parentChildId?: string;
	agent?: string;
	timestamp?: number;
	stepIndex?: number;
	taskIndex?: number;
	sessionFile?: string;
	toolName?: string;
	toolCount?: number;
	currentTool?: string;
	recentOutput?: string;
	ok?: boolean;
	resultSummary?: string;
	text?: string;
	delta?: string;
	summary?: string;
	message?: string;
	reason?: string;
	result?: Record<string, unknown>;
}

function isThinkingEventType(type: string | undefined): boolean {
	return type === SUBAGENT_MODE_CHILD_THINKING_START_EVENT || type === SUBAGENT_MODE_CHILD_THINKING_END_EVENT;
}

function filterNodeLogRecords(records: OrchestratorNodeLogRecord[], includeThinking: boolean): OrchestratorNodeLogRecord[] {
	return includeThinking ? records : records.filter((record) => !isThinkingEventType(record.eventType));
}

function formatNodeLogLines(records: OrchestratorNodeLogRecord[]): string {
	if (records.length === 0) return "No log records found.";
	const lines: string[] = [];
	let textBuffer = "";

	const flushTextBuffer = (): void => {
		if (!textBuffer) return;
		lines.push(`assistant: ${textBuffer}`);
		textBuffer = "";
	};

	for (const record of records) {
		const event = record.event as LoggedChildEvent;
		switch (record.eventType) {
			case SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT:
				textBuffer += typeof event.delta === "string" ? event.delta : "";
				continue;
			case SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT:
				if (typeof event.text === "string") textBuffer = event.text;
				flushTextBuffer();
				continue;
			default:
				flushTextBuffer();
		}

		switch (record.eventType) {
			case SUBAGENT_MODE_CHILD_STARTED_EVENT:
				lines.push(`started ${event.agent ?? "child"}`);
				break;
			case SUBAGENT_MODE_CHILD_THINKING_START_EVENT:
				lines.push("thinking started");
				break;
			case SUBAGENT_MODE_CHILD_THINKING_END_EVENT:
				lines.push(typeof event.summary === "string" && event.summary.trim() ? `thinking ended: ${event.summary}` : "thinking ended");
				break;
			case SUBAGENT_MODE_CHILD_TOOL_START_EVENT:
				lines.push(`tool start: ${typeof event.toolName === "string" ? event.toolName : "unknown"}`);
				break;
			case SUBAGENT_MODE_CHILD_TOOL_END_EVENT:
				lines.push(`tool end: ${typeof event.toolName === "string" ? event.toolName : "unknown"}${event.ok === false ? " (error)" : ""}${typeof event.resultSummary === "string" && event.resultSummary.trim() ? ` — ${event.resultSummary}` : ""}`);
				break;
			case SUBAGENT_MODE_CHILD_PROGRESS_EVENT:
				lines.push(`progress: ${typeof event.currentTool === "string" ? event.currentTool : "running"}${typeof event.recentOutput === "string" && event.recentOutput.trim() ? ` — ${event.recentOutput}` : ""}`);
				break;
			case SUBAGENT_MODE_CHILD_ERROR_EVENT:
				lines.push(`error: ${typeof event.message === "string" ? event.message : "child error"}`);
				break;
			case SUBAGENT_MODE_CHILD_CANCELLED_EVENT:
				lines.push(typeof event.reason === "string" && event.reason.trim() ? `cancelled: ${event.reason}` : "cancelled");
				break;
			case SUBAGENT_MODE_CHILD_COMPLETE_EVENT: {
				const result = event.result;
				const status = typeof result?.status === "string" ? result.status : "complete";
				const finalText = typeof result?.finalText === "string" ? result.finalText.trim() : "";
				lines.push(finalText ? `complete: ${status} — ${finalText}` : `complete: ${status}`);
				break;
			}
		}
	}

	flushTextBuffer();
	return lines.join("\n");
}

function buildTreeNodes(children: OrchestratorTreeNodeDetails[]): OrchestratorTreeNodeDetails[] {
	const byParent = new Map<string | undefined, OrchestratorTreeNodeDetails[]>();
	for (const child of children) {
		const key = child.parentChildSessionId;
		const bucket = byParent.get(key) ?? [];
		bucket.push(child);
		byParent.set(key, bucket);
	}
	const sortChildren = (items: OrchestratorTreeNodeDetails[]): OrchestratorTreeNodeDetails[] => items.sort((a, b) => a.childIndex - b.childIndex || (a.taskIndex ?? a.stepIndex ?? 0) - (b.taskIndex ?? b.stepIndex ?? 0));
	const attach = (parentId?: string): OrchestratorTreeNodeDetails[] => sortChildren([...(byParent.get(parentId) ?? [])]).map((child) => ({ ...child, children: attach(child.childSessionId) }));
	return attach(undefined);
}

function formatTree(details: OrchestratorTreeDetails): string {
	const lines = [
		`rootRunId: ${details.rootRunId}`,
		`ownerModeId: ${details.ownerModeId}`,
		`status: ${details.status}`,
		`shape: ${details.async ? "async" : "sync"} ${details.context}`,
		`taskSummary: ${details.taskSummary}`,
		"",
		"Tree:",
	];
	if (details.nodes.length === 0) {
		lines.push("(no child nodes)");
		return lines.join("\n");
	}
	const visit = (nodes: OrchestratorTreeNodeDetails[], prefix: string): void => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index]!;
			const branch = index === nodes.length - 1 ? "└─" : "├─";
			const nextPrefix = `${prefix}${index === nodes.length - 1 ? "  " : "│ "}`;
			const parts = [`[${node.childIndex}]`, node.agent, node.status, node.taskSummary];
			if (node.currentTool) parts.push(`tool=${node.currentTool}${node.toolCount !== undefined ? `(${node.toolCount})` : ""}`);
			lines.push(`${prefix}${branch} ${parts.join(" | ")}`);
			lines.push(`${nextPrefix}childSessionId: ${node.childSessionId}`);
			if (node.resultSummary) lines.push(`${nextPrefix}result: ${node.resultSummary}`);
			if (node.error) lines.push(`${nextPrefix}error: ${node.error}`);
			visit(node.children, nextPrefix);
		}
	};
	visit(details.nodes, "");
	return lines.join("\n");
}

export default function subagentOrchestratorExtension(pi: ExtensionAPI) {
	const stateRoot = path.join(process.cwd(), ".pi", "state", "subagent-orchestrator");
	const state = createStateStore(stateRoot);
	state.ensureReady();
	modeDepthCache.clear();
	subagentDepthCache.clear();
	subagentModelCache.clear();
	subagentThinkingCache.clear();
	subagentToolSelectionCache.clear();
	subagentInstructionsCache.clear();
	resolveAgentAssetFiles = () => collectAgentFiles(pi);
	resolveSubagentAssetFiles = () => collectSubagentFiles(pi);

	pi.registerMessageRenderer<OrchestratorRunMessageDetails>(ORCHESTRATOR_RUN_MESSAGE_TYPE, (message, _options, theme) => {
		const details = resolveRunMessageDetails(message.details);
		if (!details) return undefined;
		return createRunMessageComponent(details, theme);
	});

	pi.registerMessageRenderer(ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as Partial<OrchestratorContinuationMessageDetails>;
		const childCount = typeof details.childCount === "number"
			? details.childCount
			: Array.isArray(details.handbackIds) ? details.handbackIds.length : 1;
		const consumer = details.consumer === "user" ? "user" : "agent";
		const title = formatContinuationTitle(childCount, consumer, details.agent);
		const runIds = Array.isArray(details.runIds)
			? details.runIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			: [];
		const titleRunId = consumer === "agent" && runIds.length === 1 ? shortRunId(runIds[0]) : undefined;
		const content = typeof message.content === "string" ? message.content.trim() : "";
		const boxBg = consumer === "user" ? "toolPendingBg" : "customMessageBg";
		const box = new Box(1, 1, (text: string) => theme.bg(boxBg, text));
		const titleColor = consumer === "user" ? "accent" : "success";
		const titleText = `${theme.fg(titleColor, title)}${titleRunId ? ` ${theme.bold(titleRunId)}` : ""}`;
		if (!content) {
			box.addChild(new Text(titleText, 0, 0));
			return box;
		}
		if (options.expanded) {
			box.addChild(new Text(`${titleText}\n\n${content}`, 0, 0));
			return box;
		}
		if (consumer === "user") {
			const preview = collapsePreview(content, 8, 700) ?? content;
			const hint = preview !== content
				? theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)
				: undefined;
			const body = hint ? `${titleText}\n\n${preview}\n\n${hint}` : `${titleText}\n\n${preview}`;
			box.addChild(new Text(body, 0, 0));
			return box;
		}
		const hint = theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
		box.addChild(new Text(`${titleText} ${hint}`, 0, 0));
		return box;
	});

	const pending = new Map<string, PendingRequest>();
	const uiStatusKey = "subagent-orchestrator";
	let latestCtx: ExtensionContext | null = null;
	let queuedHandbackFlushTimer: ReturnType<typeof setTimeout> | null = null;
	let uiStatusTimer: ReturnType<typeof setTimeout> | null = null;

	function findEventChildByIndex(runId: string, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		const children = state.listChildSessionsByRun(runId);
		if (children.length === 0) return undefined;
		if (typeof event.taskIndex === "number") {
			const taskMatches = children.filter((child) => child.taskIndex === event.taskIndex);
			if (taskMatches.length === 1) return taskMatches[0];
		}
		if (typeof event.stepIndex === "number") {
			const stepMatches = children.filter((child) => child.stepIndex === event.stepIndex && (typeof event.taskIndex !== "number" || child.taskIndex === event.taskIndex));
			if (stepMatches.length === 1) return stepMatches[0];
		}
		return children.length === 1 ? children[0] : undefined;
	}

	function resolveChildSessionForEvent(runId: string, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		if (typeof event.childId === "string") {
			const existing = state.findChildSessionByRunAndExecutionChildId(runId, event.childId);
			if (existing) return existing;
		}
		return findEventChildByIndex(runId, event);
	}

	function warnDroppedChildEvent(runId: string, event: LoggedChildEvent, reason: string): void {
		if (process.env.PI_DEBUG_SUBAGENT_ORCHESTRATOR !== "1") return;
		const eventType = typeof event.type === "string" ? event.type : "unknown";
		console.warn(`[subagent-orchestrator] dropped child event for run ${runId}: ${eventType} (${reason})`);
	}

	function appendNodeLogForChild(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): OrchestratorNodeLogRecord {
		return state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			...(child.rootRunId ? { rootRunId: child.rootRunId } : {}),
			timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
			eventType: typeof event.type === "string" ? event.type : "unknown",
			event,
		});
	}

	function updateChildSessionFromEvent(child: OrchestratorChildSessionRecord, event: LoggedChildEvent): OrchestratorChildSessionRecord | undefined {
		const now = typeof event.timestamp === "number" ? event.timestamp : Date.now();
		switch (event.type) {
			case SUBAGENT_MODE_CHILD_STARTED_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "running",
					updatedAt: now,
					...(typeof event.childId === "string" ? { executionChildId: event.childId } : {}),
					...(typeof event.sessionFile === "string" ? { sessionFile: event.sessionFile } : {}),
				});
			case SUBAGENT_MODE_CHILD_TOOL_START_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "running",
					updatedAt: now,
					...(typeof event.toolName === "string" ? { currentTool: event.toolName } : {}),
					toolCount: (child.toolCount ?? 0) + 1,
				});
			case SUBAGENT_MODE_CHILD_TOOL_END_EVENT:
				return state.updateChildSession(child.childSessionId, {
					updatedAt: now,
					...(typeof event.toolName === "string" ? { currentTool: event.toolName } : {}),
				});
			case SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "running",
					updatedAt: now,
					recentOutput: boundedRecentOutput([...(child.recentOutput ?? []), typeof event.delta === "string" ? event.delta : ""]),
				});
			case SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "running",
					updatedAt: now,
					...(typeof event.text === "string" ? { recentOutput: finalAnswerRecentOutput(event.text) } : {}),
				});
			case SUBAGENT_MODE_CHILD_PROGRESS_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "running",
					updatedAt: now,
					...(typeof event.currentTool === "string" ? { currentTool: event.currentTool } : {}),
					...(typeof event.toolCount === "number" ? { toolCount: event.toolCount } : {}),
					...(typeof event.recentOutput === "string" ? { recentOutput: boundedRecentOutput([...(child.recentOutput ?? []), event.recentOutput]) } : {}),
				});
			case SUBAGENT_MODE_CHILD_ERROR_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: child.status === "cancelled" ? child.status : "failed",
					updatedAt: now,
					...(typeof event.message === "string" ? { error: event.message } : {}),
				});
			case SUBAGENT_MODE_CHILD_CANCELLED_EVENT:
				return state.updateChildSession(child.childSessionId, {
					status: "cancelled",
					updatedAt: now,
					completedAt: now,
					...(typeof event.reason === "string" ? { resultSummary: event.reason } : {}),
				});
			case SUBAGENT_MODE_CHILD_COMPLETE_EVENT: {
				const result = event.result as Record<string, unknown> | undefined;
				const status = typeof result?.status === "string" ? result.status : "complete";
				const finalText = typeof result?.finalText === "string" ? result.finalText : undefined;
				const error = typeof result?.error === "string" ? result.error : undefined;
				const sessionFile = typeof result?.sessionFile === "string" ? result.sessionFile : undefined;
				return state.updateChildSession(child.childSessionId, {
					status: status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "complete",
					updatedAt: now,
					completedAt: now,
					...(sessionFile ? { sessionFile } : {}),
					...(finalText ? { finalAnswer: finalText, resultSummary: summarizeHandbackText(finalText, 120), recentOutput: finalAnswerRecentOutput(finalText) } : {}),
					...(error ? { error } : {}),
				});
			}
			default:
				return undefined;
		}
	}

	function handleChildEvent(runId: string, event: LoggedChildEvent, appendEntryOnUpdate = true): void {
		const child = resolveChildSessionForEvent(runId, event);
		if (!child) {
			warnDroppedChildEvent(runId, event, "could not correlate to a child session");
			return;
		}
		appendNodeLogForChild(child, event);
		const updated = updateChildSessionFromEvent(child, event);
		if (updated?.sessionFile) {
			bindStickyUserSubagentSessionToRun(runId, {
				sessionFile: updated.sessionFile,
				childSessionId: updated.childSessionId,
				lastUsedAt: updated.updatedAt,
			});
		}
		if (updated && appendEntryOnUpdate && event.type && event.type !== SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT) {
			appendChildEntry(updated, isTerminal(updated.status) ? (updated.status === "cancelled" ? "cancelled" : "completed") : "updated");
		}
		refreshRunAggregates(runId);
	}

	function ingestAsyncEventLines(run: OrchestratorRunRecord): void {
		if (!run.asyncDir) return;
		const eventsPath = path.join(run.asyncDir, "events.jsonl");
		if (!fs.existsSync(eventsPath)) return;
		const buffer = fs.readFileSync(eventsPath);
		let offset = run.asyncEventCursor ?? 0;
		if (isTerminal(run.status) && offset < buffer.length) {
			state.updateRun(run.orchestratorRunId, { asyncEventCursor: buffer.length, updatedAt: Date.now() });
			return;
		}
		if (offset >= buffer.length) return;
		while (offset < buffer.length) {
			const newlineIndex = buffer.indexOf(0x0a, offset);
			if (newlineIndex < 0) break;
			const rawLine = buffer.subarray(offset, newlineIndex).toString("utf8").trim();
			if (!rawLine) {
				offset = newlineIndex + 1;
				continue;
			}
			let event: LoggedChildEvent;
			try {
				event = JSON.parse(rawLine) as LoggedChildEvent;
			} catch {
				warnDroppedChildEvent(run.orchestratorRunId, { type: "unknown" }, "encountered malformed async event line");
				break;
			}
			if (typeof event.type !== "string") {
				warnDroppedChildEvent(run.orchestratorRunId, event, "missing event type");
				break;
			}
			if (event.type.startsWith("subagent:mode:child.")) {
				handleChildEvent(run.orchestratorRunId, event, false);
			}
			offset = newlineIndex + 1;
		}
		state.updateRun(run.orchestratorRunId, { asyncEventCursor: offset, updatedAt: Date.now() });
	}

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

	function refreshAsyncRunState(run: OrchestratorRunRecord): OrchestratorRunRecord | undefined {
		ingestAsyncEventLines(run);
		if (isTerminal(run.status)) return state.getRun(run.orchestratorRunId) ?? run;
		return reconcileRunFromAsyncArtifacts(run.orchestratorRunId);
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
		updateUiStatus();
	}

	function appendChildEntry(child: OrchestratorChildSessionRecord, event: "created" | "updated" | "completed" | "cancelled"): void {
		pi.appendEntry(ORCHESTRATOR_CHILD_SESSION_ENTRY_TYPE, buildChildSessionEntry(child, event));
	}

	function clearUiStatusTimer(): void {
		if (!uiStatusTimer) return;
		clearTimeout(uiStatusTimer);
		uiStatusTimer = null;
	}

	function applyUiStatus(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx?.hasUI) return;
		const ownerModeId = findCurrentModeId(runtimeCtx);
		if (!ownerModeId) {
			runtimeCtx.ui.setStatus(uiStatusKey, undefined);
			return;
		}
		const lineage = currentSessionLineage(runtimeCtx);
		const runs = state.listOwnedRuns(ownerModeId).filter((run) =>
			runMatchesSessionLineage(run, lineage) && normalizeRunOrigin(run.origin) !== "user"
		);
		const activeChildren = runs.reduce((total, run) => total + (run.activeChildCount ?? 0), 0);
		const queuedHandbacks = state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& handbackMatchesSessionLineage(record, lineage)
			&& normalizeHandbackConsumer(record.consumer) !== "user"
		).length;
		const activeRuns = runs.filter((run) => !isTerminal(run.status)).length;
		const failedAgents = Array.from(runs
			.filter((run) => run.status === "failed" && run.failureAcknowledgedAt === undefined)
			.reduce((counts, run) => {
				const agent = run.agent?.trim().toLowerCase() || "subagent";
				counts.set(agent, (counts.get(agent) ?? 0) + 1);
				return counts;
			}, new Map<string, number>())
			.entries())
			.map(([agent, count]) => ({ agent, count }));
		const statusText = formatFooterStatus({
			activeRuns,
			activeChildren,
			queuedHandbacks,
			failedAgents,
		}, (text) => runtimeCtx.ui.theme.fg("error", runtimeCtx.ui.theme.bold(text)));
		runtimeCtx.ui.setStatus(uiStatusKey, statusText);
	}

	function updateUiStatus(ctx?: ExtensionContext | null, immediate = false): void {
		if (immediate) {
			clearUiStatusTimer();
			applyUiStatus(ctx);
			return;
		}
		clearUiStatusTimer();
		uiStatusTimer = setTimeout(() => {
			uiStatusTimer = null;
			applyUiStatus(ctx);
		}, 75);
		uiStatusTimer.unref?.();
	}

	function acknowledgeVisibleFailedRuns(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx) return;
		const ownerModeId = findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return;
		const lineage = currentSessionLineage(runtimeCtx);
		const now = Date.now();
		for (const run of state.listOwnedRuns(ownerModeId)) {
			if (!runMatchesSessionLineage(run, lineage)) continue;
			if (normalizeRunOrigin(run.origin) === "user") continue;
			if (run.status !== "failed" || run.failureAcknowledgedAt !== undefined) continue;
			state.updateRun(run.orchestratorRunId, { failureAcknowledgedAt: now, updatedAt: now });
		}
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
		if (!display) {
			if (run.async && isTerminal(run.status) && run.terminalStatusNotifiedAt === undefined) {
				state.updateRun(runId, { terminalStatusNotifiedAt: Date.now() });
			}
			return;
		}
		const lineage = currentSessionLineage(runtimeCtx);
		if (!runMatchesSessionLineage(run, lineage)) return;
		pi.sendMessage({
			customType: ORCHESTRATOR_RUN_MESSAGE_TYPE,
			content: `Orchestrator status update (system-generated, not user input): delegated run ${runId} is ${run.status}.`,
			display,
			details,
		}, { triggerTurn: false });
	}

	function consumeQueuedHandbacksForRun(runId: string, consumedAt = Date.now()): void {
		for (const handback of state.listHandbacksByRun(runId).filter((entry) => entry.status === "queued")) {
			state.markHandbackConsumed(handback.handbackId, consumedAt);
		}
		refreshRunAggregates(runId);
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
			} catch {
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
		} catch {
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
		if (status !== "cancelled") queueHandback(state.getRun(run.orchestratorRunId) ?? run, fallback);
		return state.getRun(run.orchestratorRunId) ?? run;
	}

	function reconcileOwnedAsyncRuns(ctx: ExtensionContext): void {
		const ownerModeId = findCurrentModeId(ctx);
		if (!ownerModeId) return;
		const roots = state.listTopLevelRunsByMode(ownerModeId);
		for (const root of roots) {
			for (const run of state.listRunsByRootRunId(root.orchestratorRunId)) {
				if (run.async) refreshAsyncRunState(run);
			}
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

	function clearQueuedHandbackFlushTimer(): void {
		if (!queuedHandbackFlushTimer) return;
		clearTimeout(queuedHandbackFlushTimer);
		queuedHandbackFlushTimer = null;
	}

	function queuedHandbackCountForContext(ctx?: ExtensionContext | null): number {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx) return 0;
		const ownerModeId = findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return 0;
		const lineage = currentSessionLineage(runtimeCtx);
		return state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& handbackMatchesSessionLineage(record, lineage)
		).length;
	}

	function scheduleQueuedHandbackFlush(delayMs = 250, attemptsRemaining = 20): void {
		clearQueuedHandbackFlushTimer();
		queuedHandbackFlushTimer = setTimeout(() => {
			queuedHandbackFlushTimer = null;
				const queuedBeforeFlush = queuedHandbackCountForContext();
			if (queuedBeforeFlush === 0) return;
			reconcileDuplicateHandbacks(latestCtx);
			flushQueuedHandbacks(latestCtx);
			if (queuedHandbackCountForContext() > 0 && attemptsRemaining > 1) {
				scheduleQueuedHandbackFlush(Math.min(delayMs * 2, 1000), attemptsRemaining - 1);
			}
		}, delayMs);
		queuedHandbackFlushTimer.unref?.();
	}

	function reconcileDuplicateHandbacks(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx) return;
		const ownerModeId = findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return;
		const lineage = currentSessionLineage(runtimeCtx);
		const activeHandbacks = state.listHandbacks().filter((record) =>
			record.ownerModeId === ownerModeId
			&& record.status !== "dismissed"
			&& handbackMatchesSessionLineage(record, lineage)
		);
		const { duplicates } = partitionHandbackDuplicates(activeHandbacks);
		if (duplicates.length === 0) return;
		const now = Date.now();
		for (const duplicate of duplicates) {
			state.markHandbackDismissed(duplicate.handbackId, now);
			refreshRunAggregates(duplicate.runId);
		}
	}

	function formatAgentVisibleContinuationContent(content: string): string {
		return `Summary result of delegated run:\n\n${content}`;
	}

	function formatAgentHiddenContinuationContent(content: string): string {
		return `Orchestrator async completion trigger for the pending delegated request. Answer using this result directly.\n\n${formatAgentVisibleContinuationContent(content)}`;
	}

	function formatUserHiddenContinuationContent(agent: string | undefined, content: string): string {
		const source = agent ?? "subagent";
		return (
			`Background user-addressed exchange from ${source}. `
			+ "This is provided for context only. It is not a user request to comment on, summarize, or act on unless the user later refers to it."
			+ `\n\n${content}`
		);
	}

	function buildContinuationDetails(
		continuation: OrchestratorContinuationRecord,
		handbacks: OrchestratorHandbackRecord[],
	): OrchestratorContinuationMessageDetails {
		return {
			continuationId: continuation.continuationId,
			handbackIds: continuation.handbackIds,
			childCount: handbacks.reduce((total, entry) => total + entry.childSessionIds.length, 0),
			runIds: [...new Set(handbacks.map((entry) => entry.runId))],
			consumer: continuation.consumer,
			...(continuation.agent ? { agent: continuation.agent } : {}),
		};
	}

	function createContinuationRecord(
		parentSessionId: string,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): OrchestratorContinuationRecord {
		const first = handbacks[0];
		return state.createContinuation({
			continuationId: randomUUID(),
			parentSessionId,
			ownerModeId,
			handbackIds: handbacks.map((entry) => entry.handbackId),
			consumer: normalizeHandbackConsumer(first?.consumer),
			...(first?.agent ? { agent: first.agent } : {}),
			status: "launched",
			content: handbacks.map((entry) => entry.content).join("\n\n---\n\n"),
			createdAt: now,
			updatedAt: now,
			launchedAt: now,
		});
	}

	function consumeHandbacks(handbacks: OrchestratorHandbackRecord[], consumedAt: number): void {
		for (const handback of handbacks) {
			state.markHandbackConsumed(handback.handbackId, consumedAt);
			refreshRunAggregates(handback.runId);
		}
	}

	function sendDeferredCustomMessage(
		runtimeCtx: ExtensionContext,
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: OrchestratorContinuationMessageDetails;
		},
	): void {
		if (runtimeCtx.isIdle() && !runtimeCtx.hasPendingMessages()) {
			pi.sendMessage(message, { triggerTurn: false });
			return;
		}
		pi.sendMessage(message, { triggerTurn: false, deliverAs: "followUp" });
	}

	function deliverUserHandbacks(
		runtimeCtx: ExtensionContext,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): void {
		for (const handback of handbacks) {
			const continuation = createContinuationRecord(handback.parentSessionId, ownerModeId, [handback], now);
			consumeHandbacks([handback], now);
			pi.appendEntry(ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, buildContinuationEntry(continuation));
			const details = buildContinuationDetails(continuation, [handback]);
			sendDeferredCustomMessage(runtimeCtx, {
				customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
				content: continuation.content,
				display: true,
				details,
			});
			sendDeferredCustomMessage(runtimeCtx, {
				customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
				content: formatUserHiddenContinuationContent(continuation.agent, continuation.content),
				display: false,
				details,
			});
		}
	}

	function deliverAgentHandbacks(
		parentSessionId: string,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): void {
		if (handbacks.length === 0) return;
		const continuation = createContinuationRecord(parentSessionId, ownerModeId, handbacks, now);
		consumeHandbacks(handbacks, now);
		pi.appendEntry(ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, buildContinuationEntry(continuation));
		const details = buildContinuationDetails(continuation, handbacks);
		pi.sendMessage({
			customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
			content: formatAgentVisibleContinuationContent(continuation.content),
			display: true,
			details,
		}, { triggerTurn: false });
		pi.sendMessage({
			customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
			content: formatAgentHiddenContinuationContent(continuation.content),
			display: false,
			details,
		}, { triggerTurn: true });
	}

	function queueHandback(run: OrchestratorRunRecord, event: AsyncCompleteEvent): OrchestratorHandbackRecord | undefined {
		const now = Date.now();
		const children = state.listChildSessionsByRun(run.orchestratorRunId);
		const handback = buildQueuedHandback(run, children, event, now);
		if (!handback) return undefined;
		const dedupeKey = buildHandbackDeduplicationKey(handback);
		const existing = state.listHandbacksByRun(run.orchestratorRunId)
			.find((entry) => buildHandbackDeduplicationKey(entry) === dedupeKey && entry.status !== "dismissed");
		if (existing) {
			refreshRunAggregates(run.orchestratorRunId);
			scheduleQueuedHandbackFlush();
			return existing;
		}
		const created = state.createHandback(handback);
		pi.appendEntry(ORCHESTRATOR_HANDBACK_ENTRY_TYPE, buildHandbackEntry(created));
		refreshRunAggregates(run.orchestratorRunId);
		scheduleQueuedHandbackFlush();
		return created;
	}

	function flushQueuedHandbacks(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? latestCtx;
		if (!runtimeCtx) return;
		const ownerModeId = findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return;
		const lineage = currentSessionLineage(runtimeCtx);
		const queued = state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& handbackMatchesSessionLineage(record, lineage)
		);
		if (queued.length === 0) return;
		const now = Date.now();
		const { unique, duplicates } = partitionHandbackDuplicates(queued);
		for (const duplicate of duplicates) {
			state.markHandbackDismissed(duplicate.handbackId, now);
			refreshRunAggregates(duplicate.runId);
		}
		if (unique.length === 0) return;
		const userHandbacks = unique.filter((entry) => normalizeHandbackConsumer(entry.consumer) === "user");
		if (userHandbacks.length > 0) {
			deliverUserHandbacks(runtimeCtx, ownerModeId, userHandbacks, now);
		}
		const agentHandbacks = unique.filter((entry) => normalizeHandbackConsumer(entry.consumer) !== "user");
		if (agentHandbacks.length === 0) return;
		if (!runtimeCtx.isIdle() || runtimeCtx.hasPendingMessages()) return;
		const agentHandbacksBySession = new Map<string, OrchestratorHandbackRecord[]>();
		for (const handback of agentHandbacks) {
			const sessionKey = handback.parentSessionId || "unknown-session";
			const existing = agentHandbacksBySession.get(sessionKey) ?? [];
			existing.push(handback);
			agentHandbacksBySession.set(sessionKey, existing);
		}
		for (const [parentSessionId, handbacks] of agentHandbacksBySession) {
			deliverAgentHandbacks(parentSessionId, ownerModeId, handbacks, now);
		}
	}

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		if (event.source !== "interactive") return { action: "continue" };
		acknowledgeVisibleFailedRuns(ctx);
		updateUiStatus(ctx, true);
		if ((event.images?.length ?? 0) > 0) return { action: "continue" };
		const currentMode = findCurrentModeState(ctx);
		if (!currentMode.modeId || !currentMode.subagents?.length) return { action: "continue" };
		const parsed = parseUserDispatch(event.text, currentMode.subagents, ctx.cwd);
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
		state.ensureReady();
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new SubagentEditor(
				tui,
				theme,
				keybindings,
				() => currentAllowedSubagents(latestCtx ?? ctx),
			));
		}
		restoreRunMessageSnapshots(ctx.sessionManager.getBranch());
		reconcileOwnedAsyncRuns(ctx);
		reconcileDuplicateHandbacks(ctx);
		flushQueuedHandbacks(ctx);
		updateUiStatus(ctx, true);
		scheduleQueuedHandbackFlush();
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		reconcileOwnedAsyncRuns(ctx);
		reconcileDuplicateHandbacks(ctx);
		flushQueuedHandbacks(ctx);
		updateUiStatus(ctx, true);
		scheduleQueuedHandbackFlush();
	});

	pi.on("session_shutdown", async () => {
		latestCtx?.ui.setStatus(uiStatusKey, undefined);
		latestCtx?.ui.setEditorComponent(undefined);
		latestCtx = null;
		pending.clear();
		clearQueuedHandbackFlushTimer();
		clearUiStatusTimer();
		clearRunMessageSnapshots();
		modeDepthCache.clear();
		subagentDepthCache.clear();
		subagentModelCache.clear();
		subagentThinkingCache.clear();
		subagentToolSelectionCache.clear();
		subagentInstructionsCache.clear();
		stickyUserSubagentSessions = [];
		resolveAgentAssetFiles = undefined;
		resolveSubagentAssetFiles = undefined;
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
		const rootRunId = currentTopLevelRunId() ?? directParentChild?.rootRunId ?? directParentChild?.runId ?? orchestratorRunId;
		const parentRunId = directParentChild?.runId;
		const depth = currentSubagentDepth();
		const baseChildSessions = buildChildSessionRecords({
			runId: orchestratorRunId,
			rootRunId,
			parentChildSessionId: directParentChildSessionId,
			ownerModeId: currentModeId,
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

		state.createRun({
			orchestratorRunId,
			ownerModeId: currentModeId,
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
			status: "queued",
			taskSummary: summarizeTasks(request),
			underlyingRequestId: orchestratorRunId,
			childSessionCount: childSessions.length,
			activeChildCount: 0,
			queuedHandbackCount: 0,
			consumedHandbackCount: 0,
			selectedChildIndex: childSessions[0]?.childIndex,
		} satisfies OrchestratorRunRecord);
		for (const child of childSessions) {
			state.createChildSession(child);
			appendChildEntry(child, "created");
		}

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
		const timeoutMessage = `delegated subagent timed out waiting for a response after ${syncTimeoutSeconds}s`;
		const syncTimeout = request.async
			? undefined
			: setTimeout(() => {
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
			}, syncTimeoutSeconds * 1000);
		syncTimeout?.unref?.();

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
				childSessions.map((child) => child.childSessionId),
				sessionFiles,
			),
		});

		const response = await responsePromise;
		options.signal?.removeEventListener("abort", cancelRequest);
		if (syncTimeout) clearTimeout(syncTimeout);

		response.result.details = {
			...(asRecord(response.result.details) ?? {}),
			childSessions: buildChildSessionDetails(state.listChildSessionsByRun(orchestratorRunId).length > 0
				? state.listChildSessionsByRun(orchestratorRunId)
				: childSessions),
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

		return { orchestratorRunId, response };
	}

	pi.events.on(SUBAGENT_MODE_REQUEST_STARTED_EVENT, (data) => {
		const requestId = (data as { requestId?: unknown })?.requestId;
		if (typeof requestId !== "string") return;
		const existingRun = state.getRun(requestId);
		if (!existingRun || !isTerminal(existingRun.status)) {
			state.updateRun(requestId, { status: "running", updatedAt: Date.now() });
		}
		refreshRunAggregates(requestId);
		const pendingRequest = pending.get(requestId);
		pendingRequest?.onUpdate?.({
			content: [{ type: "text", text: "Delegated scout run started." }],
			details: { status: "running" },
		});
	});

	const forwardLoggedChildEvent = (data: unknown): void => {
		const event = data as LoggedChildEvent & { requestId?: unknown };
		if (typeof event.requestId !== "string") return;
		state.updateRun(event.requestId, { updatedAt: Date.now() });
		handleChildEvent(event.requestId, event);
	};

	pi.events.on(SUBAGENT_MODE_CHILD_STARTED_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_THINKING_START_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_THINKING_END_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_TEXT_DELTA_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_TEXT_FINAL_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_TOOL_START_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_TOOL_END_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_ERROR_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_COMPLETE_EVENT, forwardLoggedChildEvent);
	pi.events.on(SUBAGENT_MODE_CHILD_CANCELLED_EVENT, forwardLoggedChildEvent);

	pi.events.on(SUBAGENT_MODE_CHILD_PROGRESS_EVENT, (data) => {
		const evt = data as LoggedChildEvent & {
			requestId?: unknown;
			currentTool?: unknown;
			toolCount?: unknown;
			recentOutput?: unknown;
			taskIndex?: unknown;
		};
		if (typeof evt.requestId !== "string") return;
		state.updateRun(evt.requestId, { updatedAt: Date.now() });
		handleChildEvent(evt.requestId, evt);
		const pendingRequest = pending.get(evt.requestId);
		pendingRequest?.onUpdate?.({
			content: [{
				type: "text",
				text: typeof evt.currentTool === "string"
					? `Delegated scout update: current tool ${evt.currentTool}${typeof evt.toolCount === "number" ? ` (${evt.toolCount})` : ""}.`
					: "Delegated scout progress update.",
			}],
			details: { status: "running" },
		});
	});

	pi.events.on(SUBAGENT_MODE_REQUEST_RESPONSE_EVENT, (data) => {
		const payload = data as {
			requestId?: unknown;
			result?: SubagentModeRunResult | null;
			ok?: boolean;
			errorText?: string;
			async?: boolean;
			asyncDir?: string;
			asyncId?: string;
			pid?: number;
		};
		if (typeof payload.requestId !== "string") return;
		const pendingRequest = pending.get(payload.requestId);
		if (!pendingRequest) return;
		pending.delete(payload.requestId);
		pendingRequest.resolve(
			adaptSubagentModeResponse(
				payload.requestId,
				payload.result ?? null,
				payload.ok ?? false,
				payload.errorText,
				payload.async
					? { asyncDir: payload.asyncDir, asyncId: payload.asyncId, pid: payload.pid }
					: undefined,
			),
		);
	});

	pi.events.on(SUBAGENT_MODE_RUN_COMPLETE_EVENT, (data) => {
		const payload = data as {
			requestId?: unknown;
			runId?: unknown;
			result?: SubagentModeRunResult;
			async?: boolean;
		};
		// Sync runs resolve via request.response; run.complete during sync is
		// informational only. Async runs rely on run.complete for the terminal
		// transition — correlate by underlyingRunId.
		if (!payload.async) return;
		if (typeof payload.runId !== "string") return;
		const result = payload.result;
		if (!result) return;
		const run = state.findRunByUnderlyingId(payload.runId);
		if (!run) return;
		const status = toRunStatus(result.status, result.status === "complete", result.status === "cancelled");
		const summary = result.results
			.map((r) => r.finalText ?? "")
			.filter(Boolean)
			.join("\n\n---\n\n")
			|| `${result.mode} ${status}`;
		state.updateRun(run.orchestratorRunId, {
			status,
			updatedAt: Date.now(),
			completedAt: Date.now(),
			resultSummary: summary,
			...(status === "failed" ? { error: summary } : {}),
		});
		finalizeChildrenFromResults(
			run.orchestratorRunId,
			result.results.map((r) => ({
				agent: r.agent,
				output: r.finalText,
				finalOutput: r.finalText,
				success: r.status === "complete",
				sessionFile: r.sessionFile,
			})),
			summary,
			status,
			Date.now(),
		);
		pi.appendEntry(ORCHESTRATOR_COMPLETE_ENTRY_TYPE, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary,
			underlyingRunId: payload.runId,
		});
		if (status !== "cancelled") {
			const updated = state.getRun(run.orchestratorRunId) ?? run;
			queueHandback(updated, {
				id: payload.runId,
				status,
				success: status === "complete",
				cancelled: status === "cancelled",
				summary,
				results: result.results.map((r) => ({
					agent: r.agent,
					output: r.finalText,
					finalOutput: r.finalText,
					success: r.status === "complete",
					sessionFile: r.sessionFile,
				})),
				timestamp: Date.now(),
			} as AsyncCompleteEvent);
			flushQueuedHandbacks(latestCtx);
		}
	});

	pi.events.on(SUBAGENT_STARTED_EVENT, (data) => {
		const event = data as AsyncStartedEvent;
		if (typeof event.id !== "string") return;
		pi.events.emit(SUBAGENT_NOTIFY_SUPPRESS_EVENT, { asyncId: event.id });
		pi.events.emit(SUBAGENT_WIDGET_SUPPRESS_EVENT, { asyncId: event.id });
		const run = state.findRunByUnderlyingId(event.id);
		if (!run) return;
		state.updateRun(run.orchestratorRunId, {
			underlyingRunId: event.id,
			status: run.status === "cancelled" ? run.status : "running",
			updatedAt: Date.now(),
			...(typeof event.pid === "number" ? { pid: event.pid } : {}),
			...(typeof event.asyncDir === "string" ? { asyncDir: event.asyncDir } : {}),
		});
		for (const child of state.listChildSessionsByRun(run.orchestratorRunId)) {
			const updated = state.updateChildSession(child.childSessionId, {
				underlyingRunId: event.id,
				updatedAt: Date.now(),
				...(typeof event.asyncDir === "string" ? { asyncDir: event.asyncDir } : {}),
			});
			if (updated) appendChildEntry(updated, "updated");
		}
		refreshRunAggregates(run.orchestratorRunId);
	});

	pi.events.on(SUBAGENT_COMPLETE_EVENT, (data) => {
		const event = data as AsyncCompleteEvent;
		if (typeof event.id !== "string") return;
		const run = state.findRunByUnderlyingId(event.id);
		if (!run) return;
		const status = toRunStatus(event.status, event.success, event.cancelled);
		const summary = event.summary ?? `${event.agent ?? state.listChildSessionsByRun(run.orchestratorRunId)[0]?.agent ?? DEFAULT_ORCHESTRATOR_CHILD_AGENT} ${status}`;
		state.updateRun(run.orchestratorRunId, {
			status,
			updatedAt: Date.now(),
			completedAt: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
			resultSummary: summary,
			...(status === "failed" ? { error: summary } : {}),
		});
		finalizeChildrenFromResults(run.orchestratorRunId, event.results, summary, status, typeof event.timestamp === "number" ? event.timestamp : Date.now());
		pi.appendEntry(ORCHESTRATOR_COMPLETE_ENTRY_TYPE, {
			orchestratorRunId: run.orchestratorRunId,
			ownerModeId: run.ownerModeId,
			status,
			summary,
			underlyingRunId: event.id,
		});
		if (status !== "cancelled") {
			queueHandback(state.getRun(run.orchestratorRunId) ?? run, event);
			flushQueuedHandbacks(latestCtx);
		}
		if (latestCtx?.hasUI && status === "failed") {
			latestCtx.ui.notify(
				formatBackgroundFailureNotification(run.agent ?? event.agent, summary),
				"warning",
			);
		}
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
			const currentMode = findCurrentModeState(ctx);
			const currentModeId = currentMode.modeId;
			if (!currentModeId) {
				return errorResult("Subagent orchestrator could not determine the current agent mode from session state.");
			}

			const normalized = normalizeDelegateInput(params as Record<string, unknown>);
			if (!normalized.request) {
				return errorResult(normalized.error ?? "Invalid subagent orchestrator request.");
			}

			const request = hydrateDelegationRequest(pi, ctx, normalized.request, pi.getThinkingLevel());
			if (!currentMode.subagents?.includes(request.agent)) {
				return errorResult(`Mode ${currentModeId} is not allowed to delegate to subagent type ${request.agent}.`);
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
				},
			);
		},
	});

	pi.registerTool({
		name: "delegate_subagent_status",
		label: "Delegated Subagent Status",
		description: "List, inspect, focus, cancel, or inspect trees/logs/streams for orchestrated scout runs owned by the current mode.",
		promptSnippet: 'delegate_subagent_status({ action: "list" | "get" | "cancel" | "next" | "prev" | "select" | "tree" | "log" | "stream" | "stream_next", runId?, childIndex?, childSessionId?, cursor?, includeThinking? })',
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
			const currentModeId = findCurrentModeId(ctx);
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
				&& action !== "stream"
				&& action !== "stream_next"
			) {
				return errorResult('action must be one of "list", "get", "cancel", "next", "prev", "select", "tree", "log", "stream", or "stream_next".');
			}
			reconcileOwnedAsyncRuns(ctx);
			if (action === "list") {
				const runs = state.listOwnedRuns(currentModeId);
				return successText(
					formatRunList(runs, currentModeId, (runId) => state.listChildSessionsByRun(runId)),
					{ runs },
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
			if (action === "log" || action === "stream" || action === "stream_next") {
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
				if (action === "stream") {
					if (isTerminal(child.status)) {
						const details: OrchestratorStreamDetails = {
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
					const details: OrchestratorStreamDetails = {
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
				const details: OrchestratorStreamNextDetails = {
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
					consumeQueuedHandbacksForRun(run.orchestratorRunId);
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

			// underlyingRequestId is the orchestrator-run-id that the bridge's
			// `active` map is keyed by. It exists for every dispatched run.
			// handleCancel in the bridge aborts the controller (sync) and
			// SIGTERMs the persisted PID (async); both cases are fire-and-forget.
			if (!run.underlyingRequestId) {
				return errorResult(`Run ${runId} cannot be cancelled because no live cancellation handle is available.`, getRequestedModeLabel({ shape: run.requestShape, async: run.async, context: run.context } as NormalizedDelegationRequest));
			}
			pi.events.emit(SUBAGENT_MODE_CANCEL_EVENT, { requestId: run.underlyingRequestId });
			const cancelMessage = `Cancellation requested for run ${runId}.`;

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

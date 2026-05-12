/**
 * subagent-mode — public type surface.
 *
 * Two contracts live here:
 *
 *   1. Normalized event contract — what the runner emits upward. A discriminated
 *      union (`ChildEvent` | `RunEvent`) with a stable base of identity fields
 *      on every entry. Consumed by subagent-orchestrator and persisted to
 *      events.jsonl for replay.
 *
 *   2. Final result shapes — `DelegatedChildResult` and `DelegatedRunResult`
 *      per PI_SUBAGENTS_REWRITE.md. Structured, no presentation text.
 *
 * Per-event payload fields are deliberately draft; Phase 1 Task 1 finalizes
 * them against captured `pi --mode json -p` fixtures.
 */

// ============================================================================
// Run / child execution requests
// ============================================================================

export type RunMode = "single" | "parallel" | "chain";
export type ContextMode = "fresh" | "fork" | "continue";
export type RunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type ChildStatus = "complete" | "failed" | "cancelled";

export interface ChainStep {
	agent: string;
	task?: string;
	model?: string;
	parallel?: ParallelTaskSpec[];
}

export interface ParallelTaskSpec {
	agent: string;
	task?: string;
	model?: string;
	count?: number;
}

export interface RunSpec {
	mode: RunMode;
	context: ContextMode;
	agent?: string;
	task?: string;
	tasks?: ParallelTaskSpec[];
	chain?: ChainStep[];
	parentSessionFile?: string;
	/** Optional child session files keyed by child index/step index. */
	sessionFiles?: string[];
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	systemPrompt?: string;
	maxSubagentDepth?: number;
	env?: Record<string, string>;
	/** Optional stable child ids supplied by the orchestrator, ordered by child index. */
	childIds?: string[];
	/** Optional stable child ids for chain parallel fan-out, keyed by step index. */
	chainParallelChildIds?: Record<string, string[]>;
	/** When true, the bridge spawns a detached async runner and returns an asyncId. */
	async?: boolean;
}

export interface ChildExecutionRequest {
	runId: string;
	topLevelRunId: string;
	childId: string;
	parentChildId?: string;
	agent: string;
	task: string;
	context: ContextMode;
	sessionFile?: string;
	parentSessionFile?: string;
	cwd?: string;
	model?: string;
	stepIndex?: number;
	taskIndex?: number;
	depth: number;
	maxSubagentDepth: number;
	env?: Record<string, string>;
}

// ============================================================================
// Final result shapes (per design doc §"Final result shape")
// ============================================================================

export interface UsageTotals {
	input?: number;
	output?: number;
	total?: number;
}

export interface DelegatedChildResult {
	childId: string;
	agent: string;
	status: ChildStatus;
	finalText?: string;
	error?: string;
	sessionFile?: string;
	usage?: UsageTotals;
}

export interface DelegatedRunResult {
	runId: string;
	mode: RunMode;
	status: RunStatus;
	results: DelegatedChildResult[];
}

// ============================================================================
// Normalized event contract
// ============================================================================

export const EVENT_PREFIX = "subagent:mode:";

export const EVENT_RUN_STARTED = `${EVENT_PREFIX}run.started` as const;
export const EVENT_RUN_COMPLETE = `${EVENT_PREFIX}run.complete` as const;
export const EVENT_CHILD_STARTED = `${EVENT_PREFIX}child.started` as const;
export const EVENT_CHILD_THINKING_START = `${EVENT_PREFIX}child.thinking.start` as const;
export const EVENT_CHILD_THINKING_END = `${EVENT_PREFIX}child.thinking.end` as const;
export const EVENT_CHILD_TEXT_DELTA = `${EVENT_PREFIX}child.text.delta` as const;
export const EVENT_CHILD_TEXT_FINAL = `${EVENT_PREFIX}child.text.final` as const;
export const EVENT_CHILD_TOOL_START = `${EVENT_PREFIX}child.tool.start` as const;
export const EVENT_CHILD_TOOL_END = `${EVENT_PREFIX}child.tool.end` as const;
export const EVENT_CHILD_PROGRESS = `${EVENT_PREFIX}child.progress` as const;
export const EVENT_CHILD_ERROR = `${EVENT_PREFIX}child.error` as const;
export const EVENT_CHILD_COMPLETE = `${EVENT_PREFIX}child.complete` as const;
export const EVENT_CHILD_CANCELLED = `${EVENT_PREFIX}child.cancelled` as const;

// Orchestrator-originated request/cancel events consumed by the bridge.
export const EVENT_MODE_REQUEST = `${EVENT_PREFIX}request` as const;
export const EVENT_MODE_REQUEST_STARTED = `${EVENT_PREFIX}request.started` as const;
export const EVENT_MODE_REQUEST_RESPONSE = `${EVENT_PREFIX}request.response` as const;
export const EVENT_MODE_CANCEL = `${EVENT_PREFIX}cancel` as const;

/**
 * Identity fields stamped on every child-level event. The tree structure
 * (topLevelRunId / runId / childId / parentChildId) is authoritative — session
 * files are metadata, not primary keys.
 */
export interface ChildEventBase {
	runId: string;
	topLevelRunId: string;
	childId: string;
	parentChildId?: string;
	agent: string;
	timestamp: number;
	stepIndex?: number;
	taskIndex?: number;
	depth: number;
}

// Draft per-event payloads. Phase 1 Task 1 finalizes fields against real
// `pi --mode json -p` output captured into test/fixtures/raw-pi-json/.

export interface ChildStartedEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_STARTED;
	sessionFile?: string;
	pid?: number;
}

export interface ChildThinkingStartEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_THINKING_START;
}

export interface ChildThinkingEndEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_THINKING_END;
	summary?: string;
}

export interface ChildTextDeltaEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_TEXT_DELTA;
	delta: string;
}

export interface ChildTextFinalEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_TEXT_FINAL;
	text: string;
}

export interface ChildToolStartEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_TOOL_START;
	toolName: string;
	toolCallId: string;
	args?: unknown;
}

export interface ChildToolEndEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_TOOL_END;
	toolName: string;
	toolCallId: string;
	ok: boolean;
	resultSummary?: string;
}

export interface ChildProgressEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_PROGRESS;
	currentTool?: string;
	toolCount: number;
	recentOutput?: string;
}

export interface ChildErrorEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_ERROR;
	message: string;
	fatal: boolean;
}

export interface ChildCompleteEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_COMPLETE;
	result: DelegatedChildResult;
}

export interface ChildCancelledEvent extends ChildEventBase {
	type: typeof EVENT_CHILD_CANCELLED;
	reason?: string;
}

export type ChildEvent =
	| ChildStartedEvent
	| ChildThinkingStartEvent
	| ChildThinkingEndEvent
	| ChildTextDeltaEvent
	| ChildTextFinalEvent
	| ChildToolStartEvent
	| ChildToolEndEvent
	| ChildProgressEvent
	| ChildErrorEvent
	| ChildCompleteEvent
	| ChildCancelledEvent;

export interface RunStartedEvent {
	type: typeof EVENT_RUN_STARTED;
	runId: string;
	topLevelRunId: string;
	mode: RunMode;
	agent: string;
	timestamp: number;
}

export interface RunCompleteEvent {
	type: typeof EVENT_RUN_COMPLETE;
	runId: string;
	topLevelRunId: string;
	result: DelegatedRunResult;
	timestamp: number;
}

export type RunEvent = RunStartedEvent | RunCompleteEvent;

export type NormalizedEvent = ChildEvent | RunEvent;

// ============================================================================
// Async persistence schema (per design doc §"Async persistence strategy")
// ============================================================================

export const ASYNC_SCHEMA_VERSION = 1;

export interface AsyncChildManifestEntry {
	childId: string;
	agent: string;
	stepIndex?: number;
	taskIndex?: number;
	status: ChildStatus | "running" | "queued";
	sessionFile?: string;
}

export interface AsyncRunManifest {
	schemaVersion: typeof ASYNC_SCHEMA_VERSION;
	runId: string;
	topLevelRunId: string;
	mode: RunMode;
	agent: string;
	status: RunStatus;
	pid: number;
	startedAt: number;
	updatedAt: number;
	endedAt: number | null;
	spec: RunSpec;
	children: AsyncChildManifestEntry[];
	diagnostics?: string[];
}

export interface AsyncResultFile {
	schemaVersion: typeof ASYNC_SCHEMA_VERSION;
	runId: string;
	result: DelegatedRunResult;
	endedAt: number;
}

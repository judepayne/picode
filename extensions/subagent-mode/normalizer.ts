/**
 * Raw `pi --mode json -p` event stream → normalized ChildEvent stream.
 *
 * Single state machine per child execution. The caller feeds raw lines (one
 * parsed JSON object at a time) and receives zero-or-more normalized events
 * plus a final aggregation when `agent_end` is observed.
 *
 * Event vocabulary (verified against test/fixtures/raw-pi-json/):
 *
 *   Top-level:
 *     session                 → stash sessionFile/pid, emit `child.started`
 *     agent_start             → (no-op; child.started was already fired)
 *     turn_start / turn_end   → internal, drive per-turn progress
 *     message_start           → (no-op; boundary marker only)
 *     message_update          → dispatch on assistantMessageEvent.type
 *     message_end             → on assistant messages, aggregate usage
 *     tool_execution_start    → `child.tool.start`
 *     tool_execution_update   → `child.progress` (coalesced; partial tool output)
 *     tool_execution_end      → `child.tool.end`
 *     agent_end               → finalize result (caller emits `child.complete`)
 *
 *   assistantMessageEvent sub-types (inside message_update):
 *     thinking_start          → `child.thinking.start`
 *     thinking_end            → `child.thinking.end`
 *     text_start              → (no-op; deltas carry the signal)
 *     text_delta              → `child.text.delta`
 *     text_end                → `child.text.final`
 *     toolcall_start/delta/end → (no-op; tool_execution_* is the canonical path)
 *
 * The normalizer does not itself emit `child.started` or `child.complete` —
 * those are emitted by the runner, which knows spawn / exit boundaries.
 * This keeps the normalizer pure: raw event in → normalized ChildEvent[] out.
 */

import {
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
	type ChildEvent,
	type ChildEventBase,
	type DelegatedChildResult,
	type UsageTotals,
} from "./types.ts";

const MAX_TEXT_BUFFER_CHARS = 1_000_000;

// ============================================================================
// Raw event shapes (narrow; only fields we consume are typed)
// ============================================================================

interface RawMessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

interface RawMessageContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	content?: unknown;
}

interface RawMessage {
	role?: string;
	content?: RawMessageContentBlock[];
	usage?: RawMessageUsage;
	model?: string;
	errorMessage?: string;
	timestamp?: number;
	toolName?: string;
}

interface RawAssistantMessageEvent {
	type?: string;
	delta?: string;
	content?: string;
	contentIndex?: number;
}

export interface RawPiEvent {
	type?: string;
	id?: string;
	cwd?: string;
	version?: number;
	timestamp?: string | number;
	message?: RawMessage;
	messages?: RawMessage[];
	assistantMessageEvent?: RawAssistantMessageEvent;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	partialResult?: unknown;
	isError?: boolean;
	toolResults?: unknown[];
}

// ============================================================================
// Normalizer state
// ============================================================================

/** Identity fields the runner stamps on every emitted event. */
export interface NormalizerIdentity {
	runId: string;
	topLevelRunId: string;
	childId: string;
	parentChildId?: string;
	agent: string;
	depth: number;
	stepIndex?: number;
	taskIndex?: number;
}

export interface NormalizerState {
	sessionId?: string;
	sessionFile?: string;
	/** Full assistant text accumulated from text_delta events (last assistant turn). */
	textBuffer: string;
	/** Final answer candidate: content from the most recent text_end event. */
	lastTextFinal?: string;
	usage: Required<UsageTotals> & { cacheRead: number; cacheWrite: number; costTotal: number };
	turnCount: number;
	toolCount: number;
	currentToolName?: string;
	currentToolCallId?: string;
	model?: string;
	errorMessage?: string;
}

export function createNormalizerState(): NormalizerState {
	return {
		textBuffer: "",
		usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 },
		turnCount: 0,
		toolCount: 0,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function baseEvent(identity: NormalizerIdentity): ChildEventBase {
	return {
		runId: identity.runId,
		topLevelRunId: identity.topLevelRunId,
		childId: identity.childId,
		parentChildId: identity.parentChildId,
		agent: identity.agent,
		timestamp: Date.now(),
		stepIndex: identity.stepIndex,
		taskIndex: identity.taskIndex,
		depth: identity.depth,
	};
}

function summarizeResult(result: unknown): string | undefined {
	if (result === null || result === undefined) return undefined;
	if (typeof result === "string") return truncate(result, 500);
	try {
		return truncate(JSON.stringify(result), 500);
	} catch {
		return undefined;
	}
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

function appendTextBuffer(state: NormalizerState, delta: string): void {
	state.textBuffer = (state.textBuffer + delta).slice(-MAX_TEXT_BUFFER_CHARS);
}

function extractAssistantTextFromMessage(message: RawMessage | undefined): string | undefined {
	if (!message?.content) return undefined;
	const parts = message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "");
	const joined = parts.join("");
	return joined.length > 0 ? joined : undefined;
}

// ============================================================================
// Main transform
// ============================================================================

/**
 * Feed one raw pi event into the normalizer. Returns the zero-or-more
 * normalized events it produces. Mutates `state`.
 *
 * Callers typically:
 *   const evts = normalizeRawEvent(raw, identity, state);
 *   for (const e of evts) emit(e);
 */
export function normalizeRawEvent(
	raw: RawPiEvent,
	identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	if (!raw || typeof raw.type !== "string") return [];

	switch (raw.type) {
		case "session":
			if (raw.id) state.sessionId = raw.id;
			return [];

		case "message_update":
			return handleMessageUpdate(raw, identity, state);

		case "message_end":
			return handleMessageEnd(raw, identity, state);

		case "tool_execution_start":
			return handleToolStart(raw, identity, state);

		case "tool_execution_update":
			return handleToolProgress(raw, identity, state);

		case "tool_execution_end":
			return handleToolEnd(raw, identity, state);

		case "turn_end":
			// End-of-turn is a reasonable coalescing point for a progress ping.
			return [{
				type: EVENT_CHILD_PROGRESS,
				...baseEvent(identity),
				currentTool: state.currentToolName,
				toolCount: state.toolCount,
				recentOutput: state.lastTextFinal ?? (state.textBuffer ? truncate(state.textBuffer, 200) : undefined),
			}];

		case "agent_end":
			// Runner emits child.complete; we just let it know the stream is over.
			return [];

		default:
			return [];
	}
}

function handleMessageUpdate(
	raw: RawPiEvent,
	identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	const inner = raw.assistantMessageEvent;
	if (!inner?.type) return [];

	switch (inner.type) {
		case "thinking_start":
			return [{ type: EVENT_CHILD_THINKING_START, ...baseEvent(identity) }];

		case "thinking_end":
			return [{
				type: EVENT_CHILD_THINKING_END,
				...baseEvent(identity),
				summary: typeof inner.content === "string" && inner.content.length > 0
					? truncate(inner.content, 500)
					: undefined,
			}];

		case "text_delta": {
			const delta = typeof inner.delta === "string" ? inner.delta : "";
			if (!delta) return [];
			appendTextBuffer(state, delta);
			return [{ type: EVENT_CHILD_TEXT_DELTA, ...baseEvent(identity), delta }];
		}

		case "text_end": {
			const text = typeof inner.content === "string" ? inner.content : state.textBuffer;
			state.lastTextFinal = text;
			state.textBuffer = "";
			return [{ type: EVENT_CHILD_TEXT_FINAL, ...baseEvent(identity), text }];
		}

		case "text_start":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return [];

		default:
			return [];
	}
}

function handleMessageEnd(
	raw: RawPiEvent,
	_identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	const message = raw.message;
	if (!message || message.role !== "assistant") return [];

	state.turnCount += 1;
	if (message.model && !state.model) state.model = message.model;
	if (message.errorMessage && !state.errorMessage) state.errorMessage = message.errorMessage;

	const usage = message.usage;
	if (usage) {
		state.usage.input += usage.input ?? 0;
		state.usage.output += usage.output ?? 0;
		state.usage.cacheRead += usage.cacheRead ?? 0;
		state.usage.cacheWrite += usage.cacheWrite ?? 0;
		state.usage.costTotal += usage.cost?.total ?? 0;
		state.usage.total = state.usage.input + state.usage.output;
	}

	// Capture a final-answer fallback if text_end did not fire (rare).
	if (!state.lastTextFinal) {
		const text = extractAssistantTextFromMessage(message);
		if (text) state.lastTextFinal = text;
	}

	return [];
}

function handleToolStart(
	raw: RawPiEvent,
	identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	if (!raw.toolName) return [];
	state.toolCount += 1;
	state.currentToolName = raw.toolName;
	state.currentToolCallId = raw.toolCallId;
	return [{
		type: EVENT_CHILD_TOOL_START,
		...baseEvent(identity),
		toolName: raw.toolName,
		toolCallId: raw.toolCallId ?? "",
		args: raw.args,
	}];
}

function handleToolProgress(
	raw: RawPiEvent,
	identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	if (!raw.toolName) return [];
	return [{
		type: EVENT_CHILD_PROGRESS,
		...baseEvent(identity),
		currentTool: raw.toolName,
		toolCount: state.toolCount,
		recentOutput: summarizeResult(raw.partialResult),
	}];
}

function handleToolEnd(
	raw: RawPiEvent,
	identity: NormalizerIdentity,
	state: NormalizerState,
): ChildEvent[] {
	const toolName = raw.toolName ?? state.currentToolName;
	const toolCallId = raw.toolCallId ?? state.currentToolCallId ?? "";
	state.currentToolName = undefined;
	state.currentToolCallId = undefined;
	if (!toolName) return [];
	const ok = raw.isError !== true;
	const summary = summarizeResult(raw.result);
	return [{
		type: EVENT_CHILD_TOOL_END,
		...baseEvent(identity),
		toolName,
		toolCallId,
		ok,
		resultSummary: summary,
	}];
}

// ============================================================================
// Finalization
// ============================================================================

export interface FinalizeInput {
	identity: NormalizerIdentity;
	state: NormalizerState;
	exitCode: number;
	cancelled: boolean;
	spawnError?: string;
}

export function buildFinalResult(input: FinalizeInput): DelegatedChildResult {
	const { identity, state, exitCode, cancelled, spawnError } = input;
	let status: DelegatedChildResult["status"];
	if (cancelled) status = "cancelled";
	else if (spawnError || exitCode !== 0 || state.errorMessage) status = "failed";
	else status = "complete";

	const usage: UsageTotals | undefined = state.usage.input || state.usage.output
		? { input: state.usage.input, output: state.usage.output, total: state.usage.total }
		: undefined;

	return {
		childId: identity.childId,
		agent: identity.agent,
		status,
		finalText: state.lastTextFinal,
		error: status === "failed" ? (spawnError ?? state.errorMessage ?? `pi exited with code ${exitCode}`) : undefined,
		sessionFile: state.sessionFile,
		usage,
	};
}

// ============================================================================
// Line parsing helper
// ============================================================================

/**
 * Parse a single JSONL line safely. Returns undefined for blank lines or
 * non-JSON content — pi occasionally emits plain-text warnings during startup.
 * Lines that look like JSON but fail to parse throw so callers can surface
 * stream corruption instead of silently dropping it.
 */
export function parseRawLine(line: string): RawPiEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as RawPiEvent;
	} catch (error) {
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`malformed JSON line: ${message}`);
		}
		return undefined;
	}
}

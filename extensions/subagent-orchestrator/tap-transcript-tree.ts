import { getMarkdownTheme, UserMessageComponent, type Theme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text, type Component, type TUI } from "@mariozechner/pi-tui";
import {
	EVENT_CHILD_CANCELLED,
	EVENT_CHILD_COMPLETE,
	EVENT_CHILD_ERROR,
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_STARTED,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
} from "../subagent-mode/types.ts";
import { EVENT_SUBAGENT_EXPANDED_TASK, EVENT_SUBAGENT_TASK, type SubagentStreamEvent } from "./stream.ts";

export const TAP_TRANSCRIPT_KEY = "subagent-orchestrator-tap";
export const TAP_STATUS_KEY = "subagent-orchestrator";

// Keep live Markdown chunks bounded so old assistant text becomes immutable and cached.
export const ASSISTANT_CHUNK_SOFT_LIMIT = 12_000;
export const ASSISTANT_CHUNK_HARD_LIMIT = 24_000;
export const ASSISTANT_CHUNK_MIN_REMAINDER = 1_000;

type TranscriptNodeKind = "task" | "assistant" | "tool" | "status";

interface ParsedToolCommand {
	toolName: string;
	args?: Record<string, unknown>;
	raw: string;
}

interface TapTranscriptNode {
	readonly kind: TranscriptNodeKind;
	render(width: number, theme: Theme, options: RenderOptions): string[];
	invalidate(): void;
	debugBuildCount(): number;
}

interface RenderOptions {
	toolsExpanded: boolean;
}

export interface TapTranscriptTreeState {
	selectedChildSessionId?: string;
	nodes: TapTranscriptNode[];
	currentAssistant?: AssistantMarkdownNode;
	seenTask: boolean;
	toolsExpanded: boolean;
	renderTheme?: Theme;
	requestRender?: () => void;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
	return typeof record[key] === "boolean" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

abstract class CachedNode implements TapTranscriptNode {
	abstract readonly kind: TranscriptNodeKind;
	private cache = new Map<string, string[]>();
	private builds = 0;

	render(width: number, theme: Theme, options: RenderOptions): string[] {
		const key = this.cacheKey(width, options);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const lines = this.build(width, theme, options);
		this.cache.set(key, lines);
		this.builds += 1;
		return lines;
	}

	invalidate(): void {
		this.cache.clear();
	}

	debugBuildCount(): number {
		return this.builds;
	}

	protected cacheKey(width: number, _options: RenderOptions): string {
		return String(width);
	}

	protected abstract build(width: number, theme: Theme, options: RenderOptions): string[];
}

class TaskMessageNode extends CachedNode {
	readonly kind = "task" as const;
	private readonly text: string;

	constructor(text: string) {
		super();
		this.text = text;
	}

	protected build(width: number): string[] {
		return new UserMessageComponent(this.text, getMarkdownTheme()).render(width);
	}
}

class AssistantMarkdownNode extends CachedNode {
	readonly kind = "assistant" as const;
	private sealed = false;
	private text: string;

	constructor(text: string) {
		super();
		this.text = text;
	}

	append(text: string): void {
		if (!text) return;
		if (this.sealed) throw new Error("Cannot append to a sealed assistant transcript chunk.");
		this.text += text;
		this.invalidate();
	}

	seal(): void {
		this.sealed = true;
	}

	isSealed(): boolean {
		return this.sealed;
	}

	length(): number {
		return this.text.length;
	}

	debugText(): string {
		return this.text;
	}

	takePrefixForSeal(): string | undefined {
		if (this.text.length <= ASSISTANT_CHUNK_HARD_LIMIT) return undefined;
		const splitAt = findAssistantSplitIndex(this.text);
		if (splitAt <= 0) return undefined;
		const prefix = this.text.slice(0, splitAt);
		this.text = this.text.slice(splitAt);
		this.invalidate();
		return prefix || undefined;
	}

	protected build(width: number): string[] {
		return new Markdown(this.text, 0, 0, getMarkdownTheme()).render(width);
	}
}

class ToolCardNode extends CachedNode {
	readonly kind = "tool" as const;
	readonly toolCallId: string;
	readonly fallbackToolCallId: boolean;
	toolName: string;
	command?: string;
	ok?: boolean;
	resultSummary?: string;
	resultPreview?: string;

	constructor(input: { toolName: string; toolCallId: string; fallbackToolCallId?: boolean; command?: string; ok?: boolean; resultSummary?: string; resultPreview?: string }) {
		super();
		this.toolName = input.toolName;
		this.toolCallId = input.toolCallId;
		this.fallbackToolCallId = input.fallbackToolCallId ?? false;
		this.command = input.command;
		this.ok = input.ok;
		this.resultSummary = input.resultSummary;
		this.resultPreview = input.resultPreview;
	}

	isPendingMatch(toolName: string): boolean {
		return this.toolName === toolName && this.ok === undefined;
	}

	updateEnd(input: { ok?: boolean; resultSummary?: string; resultPreview?: string }): void {
		this.ok = input.ok;
		this.resultSummary = input.resultSummary;
		this.resultPreview = input.resultPreview;
		this.invalidate();
	}

	protected override cacheKey(width: number, options: RenderOptions): string {
		return `${width}:${options.toolsExpanded ? "expanded" : "collapsed"}`;
	}

	protected build(width: number, theme: Theme, options: RenderOptions): string[] {
		return renderTool(this, theme, width, options.toolsExpanded);
	}
}

class StatusLineNode extends CachedNode {
	readonly kind = "status" as const;
	private readonly text: string;
	private readonly level: "error" | "dim";

	constructor(text: string, level: "error" | "dim" = "dim") {
		super();
		this.text = text;
		this.level = level;
	}

	protected build(width: number, theme: Theme): string[] {
		const format = this.level === "error" ? theme.fg("error", this.text) : theme.fg("dim", this.text);
		return new Text(format, 0, 0).render(width);
	}
}

function findAssistantSplitIndex(text: string): number {
	const paragraphIndex = text.lastIndexOf("\n\n", ASSISTANT_CHUNK_SOFT_LIMIT);
	if (paragraphIndex >= ASSISTANT_CHUNK_MIN_REMAINDER) return paragraphIndex + 2;
	const fallbackParagraphIndex = text.lastIndexOf("\n\n", ASSISTANT_CHUNK_HARD_LIMIT - ASSISTANT_CHUNK_MIN_REMAINDER);
	if (fallbackParagraphIndex >= ASSISTANT_CHUNK_MIN_REMAINDER) return fallbackParagraphIndex + 2;
	return ASSISTANT_CHUNK_SOFT_LIMIT;
}

function sealCurrentAssistant(state: TapTranscriptTreeState): void {
	state.currentAssistant?.seal();
	state.currentAssistant = undefined;
}

function appendAssistantText(state: TapTranscriptTreeState, text: string): void {
	if (!text) return;
	let current = state.currentAssistant;
	if (!current) {
		current = new AssistantMarkdownNode("");
		state.nodes.push(current);
		state.currentAssistant = current;
	}
	current.append(text);
	while (current.length() > ASSISTANT_CHUNK_HARD_LIMIT) {
		const prefix = current.takePrefixForSeal();
		if (!prefix) break;
		const sealed = new AssistantMarkdownNode(prefix);
		sealed.seal();
		const index = state.nodes.indexOf(current);
		if (index === -1) state.nodes.push(sealed);
		else state.nodes.splice(index, 0, sealed);
	}
}

function findToolNodeForEnd(state: TapTranscriptTreeState, toolCallId: string | undefined, toolName: string): ToolCardNode | undefined {
	if (toolCallId) {
		return state.nodes.findLast((node): node is ToolCardNode => node.kind === "tool" && node.toolCallId === toolCallId);
	}
	return state.nodes.findLast((node): node is ToolCardNode => node.kind === "tool" && node.isPendingMatch(toolName));
}

export function createTapTranscriptTreeState(): TapTranscriptTreeState {
	return { nodes: [], seenTask: false, toolsExpanded: false };
}

export function resetTapTranscriptTree(state: TapTranscriptTreeState, input: { selectedChildSessionId?: string }): void {
	state.selectedChildSessionId = input.selectedChildSessionId;
	state.nodes = [];
	state.currentAssistant = undefined;
	state.seenTask = false;
}

export function setTapTranscriptTreeToolsExpanded(state: TapTranscriptTreeState, expanded: boolean): void {
	state.toolsExpanded = expanded;
}

export function appendTapTranscriptTreeEvent(state: TapTranscriptTreeState, event: SubagentStreamEvent): void {
	switch (event.eventType) {
		case EVENT_SUBAGENT_TASK: {
			const task = rawStringField(event.event, "task");
			if (!task || state.seenTask) return;
			state.seenTask = true;
			sealCurrentAssistant(state);
			state.nodes.push(new TaskMessageNode(task));
			return;
		}
		case EVENT_SUBAGENT_EXPANDED_TASK: {
			sealCurrentAssistant(state);
			const count = numberField(event.event, "taskCharCount");
			state.nodes.push(new StatusLineNode(`expanded task recorded${count !== undefined ? ` (${count} chars)` : ""}`, "dim"));
			return;
		}
		case EVENT_CHILD_STARTED:
			return;
		case EVENT_CHILD_TEXT_DELTA:
			appendAssistantText(state, rawStringField(event.event, "delta") ?? rawStringField(event.event, "text") ?? rawStringField(event.event, "summary") ?? "");
			return;
		case EVENT_CHILD_TEXT_FINAL: {
			const count = numberField(event.event, "charCount");
			if (count === 0 && state.nodes.length === 0) state.nodes.push(new StatusLineNode("No assistant output.", "dim"));
			return;
		}
		case EVENT_CHILD_PROGRESS:
			return;
		case EVENT_CHILD_TOOL_START: {
			sealCurrentAssistant(state);
			const toolCallId = stringField(event.event, "toolCallId");
			state.nodes.push(new ToolCardNode({
				toolName: stringField(event.event, "toolName") ?? "tool",
				toolCallId: toolCallId ?? `${event.cursor}:tool`,
				fallbackToolCallId: !toolCallId,
				command: stringField(event.event, "command"),
			}));
			return;
		}
		case EVENT_CHILD_TOOL_END: {
			sealCurrentAssistant(state);
			const toolCallId = stringField(event.event, "toolCallId");
			const toolName = stringField(event.event, "toolName") ?? "tool";
			const ok = booleanField(event.event, "ok");
			const resultSummary = stringField(event.event, "resultSummary");
			const resultPreview = rawStringField(event.event, "resultPreview");
			const existing = findToolNodeForEnd(state, toolCallId, toolName);
			if (existing) existing.updateEnd({ ok, resultSummary, resultPreview });
			else state.nodes.push(new ToolCardNode({ toolName, toolCallId: toolCallId ?? `${event.cursor}:tool`, fallbackToolCallId: !toolCallId, ok, resultSummary, resultPreview }));
			return;
		}
		case EVENT_CHILD_COMPLETE:
			return;
		case EVENT_CHILD_ERROR:
			sealCurrentAssistant(state);
			state.nodes.push(new StatusLineNode(stringField(event.event, "message") ?? stringField(event.event, "error") ?? "subagent failed", "error"));
			return;
		case EVENT_CHILD_CANCELLED: {
			sealCurrentAssistant(state);
			const reason = stringField(event.event, "reason");
			state.nodes.push(new StatusLineNode(`cancelled${reason ? `: ${reason}` : ""}`, "dim"));
			return;
		}
		default: {
			sealCurrentAssistant(state);
			const message = stringField(event.event, "message") ?? stringField(event.event, "error");
			state.nodes.push(new StatusLineNode(message ? `${event.eventType}: ${message}` : event.eventType, event.eventType === "tap.error" ? "error" : "dim"));
			return;
		}
	}
}

function parseToolCommand(entry: ToolCardNode): ParsedToolCommand {
	const raw = entry.command ?? entry.toolName;
	const match = raw.match(/^(\S+)\s+(.+)$/s);
	if (!match) return { toolName: entry.toolName, raw };
	const [, commandToolName, argsText] = match;
	try {
		const parsed = JSON.parse(argsText!) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return { toolName: commandToolName!, args: parsed as Record<string, unknown>, raw };
		}
	} catch {
		// Bash commands and unknown custom commands often are not JSON-shaped.
	}
	return { toolName: entry.toolName, raw };
}

function displayValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function compactArgs(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!args) return undefined;
	const parts = keys.flatMap((key) => {
		const value = displayValue(args[key]);
		return value === undefined ? [] : `${key}: ${value}`;
	});
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatToolTitle(entry: ToolCardNode, parsed: ParsedToolCommand): string {
	const args = parsed.args;
	const path = displayValue(args?.path);
	const pattern = displayValue(args?.pattern);
	const command = displayValue(args?.command);
	switch (parsed.toolName) {
		case "read":
			return path ? `read ${path}` : "read";
		case "ls":
			return path ? `ls ${path}` : "ls";
		case "grep":
			return pattern ? `grep ${pattern}${path ? ` in ${path}` : ""}` : "grep";
		case "find":
			return pattern ? `find ${pattern}${path ? ` in ${path}` : ""}` : "find";
		case "edit":
			return path ? `edit ${path}` : "edit";
		case "write":
			return path ? `write ${path}` : "write";
		case "bash":
			return command ?? entry.command ?? "bash";
		default:
			return entry.command && !parsed.args ? entry.command : entry.toolName;
	}
}

function formatToolDetails(entry: ToolCardNode, parsed: ParsedToolCommand): string | undefined {
	const args = parsed.args;
	const details = (() => {
		switch (parsed.toolName) {
			case "read":
				return compactArgs(args, ["offset", "limit"]);
			case "ls":
				return compactArgs(args, ["limit"]);
			case "grep":
				return compactArgs(args, ["glob", "ignoreCase", "literal", "context", "limit"]);
			case "find":
				return compactArgs(args, ["limit"]);
			case "edit":
				return compactArgs(args, ["edits"]);
			case "write":
				return compactArgs(args, ["contentElided"]);
			default:
				return args ? Object.keys(args).slice(0, 4).join(" · ") : undefined;
		}
	})();
	if (entry.ok !== undefined) return details ? `${details} · result elided` : "result elided";
	return details;
}

function renderTool(entry: ToolCardNode, theme: Theme, width: number, expanded: boolean): string[] {
	const parsed = parseToolCommand(entry);
	const status = entry.ok === false ? "✗" : entry.ok === true ? "✓" : "▶";
	const bg = entry.ok === false ? "toolErrorBg" : entry.ok === true ? "toolSuccessBg" : "toolPendingBg";
	const box = new Box(1, 1, (text) => theme.bg(bg, text));
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(`${status} ${formatToolTitle(entry, parsed)}`)), 0, 0));
	const details = formatToolDetails(entry, parsed);
	if (details) box.addChild(new Text(theme.fg("toolOutput", details), 0, 0));
	if (entry.resultPreview) {
		if (expanded) {
			box.addChild(new Text(theme.fg("toolOutput", entry.resultPreview), 0, 0));
		} else {
			box.addChild(new Text(theme.fg("muted", "result hidden (ctrl+o to expand)"), 0, 0));
		}
	}
	if (entry.resultPreview === undefined && entry.ok !== undefined && expanded) {
		box.addChild(new Text(theme.fg("muted", "result elided"), 0, 0));
	}
	if (entry.resultPreview && expanded) box.addChild(new Text(theme.fg("muted", "ctrl+o to collapse"), 0, 0));
	return box.render(width);
}

export class TapTranscriptTreeComponent implements Component {
	private readonly state: TapTranscriptTreeState;
	private readonly theme: Theme;

	constructor(state: TapTranscriptTreeState, theme: Theme) {
		this.state = state;
		this.theme = theme;
		if (state.renderTheme !== theme) {
			for (const node of state.nodes) node.invalidate();
			state.renderTheme = theme;
		}
	}

	invalidate(): void {
		for (const node of this.state.nodes) node.invalidate();
	}

	render(width: number): string[] {
		if (!this.state.selectedChildSessionId) return [];
		const lines: string[] = [];
		for (const node of this.state.nodes) {
			const childLines = node.render(width, this.theme, { toolsExpanded: this.state.toolsExpanded });
			if (childLines.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(...childLines);
		}
		return lines;
	}
}

export function createTapTranscriptTreeComponent(state: TapTranscriptTreeState, tui: unknown, theme: Theme): TapTranscriptTreeComponent {
	const maybeTui = tui as Partial<TUI> | undefined;
	state.requestRender = typeof maybeTui?.requestRender === "function" ? () => maybeTui.requestRender?.() : undefined;
	return new TapTranscriptTreeComponent(state, theme);
}

export function requestTapTranscriptTreeRender(state: TapTranscriptTreeState): boolean {
	if (!state.requestRender) return false;
	state.requestRender();
	return true;
}

export function __debugTapTranscriptTree(state: TapTranscriptTreeState): Array<{ kind: TranscriptNodeKind; builds: number; sealed?: boolean; text?: string }> {
	return state.nodes.map((node) => ({
		kind: node.kind,
		builds: node.debugBuildCount(),
		...(node instanceof AssistantMarkdownNode ? { sealed: node.isSealed(), text: node.debugText() } : {}),
	}));
}

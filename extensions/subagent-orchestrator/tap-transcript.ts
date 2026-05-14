import { getMarkdownTheme, UserMessageComponent, type Theme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Text, type Component } from "@mariozechner/pi-tui";
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
import { EVENT_SUBAGENT_TASK, type SubagentStreamEvent } from "./stream.ts";

export const TAP_TRANSCRIPT_KEY = "subagent-orchestrator-tap";
export const TAP_STATUS_KEY = "subagent-orchestrator-tap";

interface UserEntry {
	type: "user";
	text: string;
}

interface AssistantEntry {
	type: "assistant";
	text: string;
}

interface ToolEntry {
	type: "tool";
	toolName: string;
	toolCallId: string;
	command?: string;
	ok?: boolean;
	resultSummary?: string;
	resultPreview?: string;
}

interface ParsedToolCommand {
	toolName: string;
	args?: Record<string, unknown>;
	raw: string;
}

interface StatusEntry {
	type: "status";
	text: string;
	level?: "error" | "dim";
}

type TranscriptEntry = UserEntry | AssistantEntry | ToolEntry | StatusEntry;

export interface TapTranscriptState {
	selectedChildSessionId?: string;
	entries: TranscriptEntry[];
	currentAssistantIndex?: number;
	seenTask: boolean;
	toolsExpanded: boolean;
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

export function createTapTranscriptState(): TapTranscriptState {
	return { entries: [], seenTask: false, toolsExpanded: false };
}

export function resetTapTranscript(state: TapTranscriptState, input: { selectedChildSessionId?: string }): void {
	state.selectedChildSessionId = input.selectedChildSessionId;
	state.entries = [];
	state.currentAssistantIndex = undefined;
	state.seenTask = false;
}

export function setTapTranscriptToolsExpanded(state: TapTranscriptState, expanded: boolean): void {
	state.toolsExpanded = expanded;
}

function pushEntry(state: TapTranscriptState, entry: TranscriptEntry): void {
	if (entry.type !== "assistant") state.currentAssistantIndex = undefined;
	state.entries.push(entry);
}

function appendAssistantText(state: TapTranscriptState, text: string): void {
	if (!text) return;
	const index = state.currentAssistantIndex;
	const current = index === undefined ? undefined : state.entries[index];
	if (current?.type === "assistant") {
		current.text += text;
		return;
	}
	state.currentAssistantIndex = state.entries.length;
	state.entries.push({ type: "assistant", text });
}

function updateToolEnd(state: TapTranscriptState, event: SubagentStreamEvent): void {
	const toolCallId = stringField(event.event, "toolCallId");
	const toolName = stringField(event.event, "toolName") ?? "tool";
	const ok = booleanField(event.event, "ok");
	const resultSummary = stringField(event.event, "resultSummary");
	const resultPreview = rawStringField(event.event, "resultPreview");
	const existing = toolCallId
		? state.entries.findLast((entry): entry is ToolEntry => entry.type === "tool" && entry.toolCallId === toolCallId)
		: state.entries.findLast((entry): entry is ToolEntry => entry.type === "tool" && entry.toolName === toolName && entry.ok === undefined);
	if (existing) {
		existing.ok = ok;
		existing.resultSummary = resultSummary;
		existing.resultPreview = resultPreview;
		return;
	}
	pushEntry(state, { type: "tool", toolName, toolCallId: toolCallId ?? `${event.cursor}:tool`, ok, resultSummary, resultPreview });
}

export function appendTapTranscriptEvent(state: TapTranscriptState, event: SubagentStreamEvent): void {
	switch (event.eventType) {
		case EVENT_SUBAGENT_TASK: {
			const task = rawStringField(event.event, "task");
			if (!task || state.seenTask) return;
			state.seenTask = true;
			pushEntry(state, { type: "user", text: task });
			return;
		}
		case EVENT_CHILD_STARTED:
			return;
		case EVENT_CHILD_TEXT_DELTA:
			appendAssistantText(state, rawStringField(event.event, "delta") ?? rawStringField(event.event, "text") ?? rawStringField(event.event, "summary") ?? "");
			return;
		case EVENT_CHILD_TEXT_FINAL: {
			const count = numberField(event.event, "charCount");
			if (count === 0 && state.entries.length === 0) pushEntry(state, { type: "status", text: "No assistant output.", level: "dim" });
			return;
		}
		case EVENT_CHILD_PROGRESS:
			return;
		case EVENT_CHILD_TOOL_START:
			pushEntry(state, {
				type: "tool",
				toolName: stringField(event.event, "toolName") ?? "tool",
				toolCallId: stringField(event.event, "toolCallId") ?? `${event.cursor}:tool`,
				command: stringField(event.event, "command"),
			});
			return;
		case EVENT_CHILD_TOOL_END:
			updateToolEnd(state, event);
			return;
		case EVENT_CHILD_COMPLETE:
			return;
		case EVENT_CHILD_ERROR:
			pushEntry(state, { type: "status", text: stringField(event.event, "message") ?? stringField(event.event, "error") ?? "subagent failed", level: "error" });
			return;
		case EVENT_CHILD_CANCELLED:
			pushEntry(state, { type: "status", text: `cancelled${stringField(event.event, "reason") ? `: ${stringField(event.event, "reason")}` : ""}`, level: "dim" });
			return;
		default: {
			const message = stringField(event.event, "message") ?? stringField(event.event, "error");
			pushEntry(state, { type: "status", text: message ? `${event.eventType}: ${message}` : event.eventType, level: event.eventType === "tap.error" ? "error" : "dim" });
			return;
		}
	}
}

function renderChild(component: Component, width: number): string[] {
	return component.render(width);
}

function parseToolCommand(entry: ToolEntry): ParsedToolCommand {
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

function formatToolTitle(entry: ToolEntry, parsed: ParsedToolCommand): string {
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
			return entry.command && !parsed.args ? entry.command : parsed.toolName;
	}
}

function formatToolDetails(entry: ToolEntry, parsed: ParsedToolCommand): string | undefined {
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

function renderTool(entry: ToolEntry, theme: Theme, width: number, expanded: boolean): string[] {
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
	return renderChild(box, width);
}

export class TapTranscriptComponent extends Container {
	private readonly state: TapTranscriptState;
	private readonly theme: Theme;

	constructor(state: TapTranscriptState, theme: Theme) {
		super();
		this.state = state;
		this.theme = theme;
	}

	override render(width: number): string[] {
		if (!this.state.selectedChildSessionId) return [];
		const lines: string[] = [];
		for (const entry of this.state.entries) {
			if (lines.length > 0) lines.push("");
			if (entry.type === "user") {
				lines.push(...renderChild(new UserMessageComponent(entry.text, getMarkdownTheme()), width));
			} else if (entry.type === "assistant") {
				lines.push(...renderChild(new Markdown(entry.text, 0, 0, getMarkdownTheme()), width));
			} else if (entry.type === "tool") {
				lines.push(...renderTool(entry, this.theme, width, this.state.toolsExpanded));
			} else {
				const format = entry.level === "error" ? this.theme.fg("error", entry.text) : this.theme.fg("dim", entry.text);
				lines.push(...renderChild(new Text(format, 0, 0), width));
			}
		}
		return lines;
	}
}

export function createTapTranscriptComponent(state: TapTranscriptState, _tui: unknown, theme: Theme): TapTranscriptComponent {
	return new TapTranscriptComponent(state, theme);
}

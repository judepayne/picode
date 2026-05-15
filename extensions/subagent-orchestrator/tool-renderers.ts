import { keyHint } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { DEFAULT_ORCHESTRATOR_CHILD_AGENT } from "./policy.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstTextContent(content: Array<{ type?: string; text?: string }> | undefined): string | undefined {
	for (const item of content ?? []) {
		if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
	}
	return undefined;
}

function lastNonEmptyLine(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.length > 0 ? lines[lines.length - 1] : undefined;
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

export function renderDelegateToolResult(
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

export function renderStatusToolResult(
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
	if (result === null) return "Loaded delegated child log terminal state.";
	if (result.isError) return "Delegated subagent status failed.";
	const details = asRecord(result.details);
	if (details?.terminal === true && details.cursor === null) return "Loaded delegated child log terminal state.";
	const action = typeof args.action === "string" ? args.action : "get";
	const runId = typeof args.runId === "string" ? args.runId : undefined;
	if (action === "list") return "Listed delegated runs.";
	if (action === "cancel") return runId ? `Cancelled delegated run ${runId}.` : "Cancelled delegated run.";
	if (action === "next" || action === "prev" || action === "select") return "Updated delegated child focus.";
	if (action === "get") return runId ? `Loaded delegated run ${runId}.` : "Loaded delegated run details.";
	if (action === "tree") return runId ? `Loaded delegated tree for ${runId}.` : "Loaded delegated tree.";
	if (action === "log") return "Loaded delegated child log.";
	if (action === "log_cursor") return "Loaded delegated child log cursor.";
	if (action === "log_next") return "Loaded delegated child log updates.";
	const fallback = firstTextContent(result.content);
	return fallback ? (lastNonEmptyLine(fallback) ?? fallback) : "Delegated subagent status updated.";
}

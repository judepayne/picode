import * as os from "node:os";
import * as path from "node:path";
import type { OrchestratorRunMessageChild, OrchestratorRunMessageDetails, RunStatus } from "./types.ts";

const HOME_DIR = os.homedir();
const RECENT_OUTPUT_LINES = 4;

function isTerminal(status: RunStatus): boolean {
	return status === "complete" || status === "failed" || status === "cancelled";
}

function collapseWhitespace(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed || undefined;
}

function compactResultSummary(text: string | undefined): string | undefined {
	if (typeof text !== "string") return undefined;
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return undefined;
	return collapseWhitespace(lines[lines.length - 1]);
}

export function shortenDisplayPath(filePath: string | undefined, maxLength = 64): string | undefined {
	if (typeof filePath !== "string" || !filePath.trim()) return undefined;
	const normalized = filePath.startsWith(HOME_DIR) ? `~${filePath.slice(HOME_DIR.length)}` : filePath;
	if (normalized.length <= maxLength) return normalized;
	const base = path.basename(normalized);
	if (normalized.startsWith("~/")) return `~/…/${base}`;
	const segments = normalized.split("/").filter(Boolean);
	const prefix = normalized.startsWith("/") ? `/${segments[0] ?? ""}` : (segments[0] ?? "");
	return `${prefix}/…/${base}`;
}

function displaySessionPath(sessionFile: string | undefined): string | undefined {
	return shortenDisplayPath(sessionFile, 28);
}

function displayLogPath(child: Pick<OrchestratorRunMessageChild, "asyncDir" | "childIndex">): string | undefined {
	if (!child.asyncDir) return undefined;
	return shortenDisplayPath(path.join(child.asyncDir, `output-${child.childIndex}.log`), 40);
}

function countByStatus(children: OrchestratorRunMessageChild[], status: RunStatus): number {
	return children.filter((child) => child.status === status).length;
}

function formatChildrenSummary(details: OrchestratorRunMessageDetails): string | undefined {
	const parts: string[] = [];
	const active = details.children.filter((child) => !isTerminal(child.status)).length;
	const queued = countByStatus(details.children, "queued");
	const complete = countByStatus(details.children, "complete");
	const failed = countByStatus(details.children, "failed");
	const cancelled = countByStatus(details.children, "cancelled");
	if (active > 0) parts.push(`${active} active`);
	if (queued > 0) parts.push(`${queued} queued`);
	if (complete > 0) parts.push(`${complete} complete`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	return parts.length > 0 ? `Children: ${parts.join(" · ")}` : undefined;
}

function resolveSelectedChild(details: OrchestratorRunMessageDetails): { child: OrchestratorRunMessageChild; index: number } | undefined {
	if (details.children.length === 0) return undefined;
	const preferred = typeof details.selectedChildIndex === "number"
		? details.children.findIndex((child) => child.childIndex === details.selectedChildIndex)
		: -1;
	if (preferred >= 0) return { child: details.children[preferred]!, index: preferred };
	const firstActive = details.children.findIndex((child) => !isTerminal(child.status));
	if (firstActive >= 0) return { child: details.children[firstActive]!, index: firstActive };
	return { child: details.children[0]!, index: 0 };
}

function formatChildLabel(child: OrchestratorRunMessageChild): string {
	const task = collapseWhitespace(child.taskSummary) ?? `Child ${child.childIndex}`;
	const statusSuffix = child.status === "running" ? "" : ` · ${child.status}`;
	return `Selected child [${child.childIndex}]${statusSuffix}: ${task}`;
}

function formatSelectedChildLines(details: OrchestratorRunMessageDetails): string[] {
	const selected = resolveSelectedChild(details);
	if (!selected) return [];
	const { child, index } = selected;
	const lines = [formatChildLabel(child)];
	if (details.children.length > 1) {
		lines.push(`Focus: ${index + 1}/${details.children.length} · cycle with delegate_subagent_status({ action: "next" | "prev", runId: "${details.runId}" })`);
	}
	if (child.currentTool) lines.push(`Tool: ${child.currentTool}${child.toolCount !== undefined ? ` (${child.toolCount})` : ""}`);
	const session = displaySessionPath(child.sessionFile);
	if (session) lines.push(`Session: ${session}`);
	const log = displayLogPath(child);
	if (log) lines.push(`Log: ${log}`);
	const recentOutput = (child.recentOutput ?? []).map((line) => line.trim()).filter(Boolean).slice(-RECENT_OUTPUT_LINES);
	if (recentOutput.length > 0) {
		lines.push("");
		lines.push("Recent output:");
		for (const line of recentOutput) lines.push(`  ${line}`);
	}
	if (child.error) lines.push(`Error: ${collapseWhitespace(child.error)}`);
	if (child.resultSummary) lines.push(`Result: ${collapseWhitespace(child.resultSummary)}`);
	return lines;
}

export function formatRunCardLines(details: OrchestratorRunMessageDetails): string[] {
	const lines = [
		`Delegated run ${details.runId}`,
		`${details.status} · ${details.requestShape} · ${details.async ? "async" : "sync"} · context=${details.context}`,
		`Task: ${collapseWhitespace(details.taskSummary) ?? "(no task)"}`,
	];
	const childrenSummary = formatChildrenSummary(details);
	if (childrenSummary) lines.push(childrenSummary);
	if (details.queuedHandbackCount > 0) {
		lines.push(`Handback queue: ${details.queuedHandbackCount} waiting`);
	}
	const selectedChildLines = formatSelectedChildLines(details);
	if (selectedChildLines.length > 0) {
		lines.push("");
		lines.push(...selectedChildLines);
	}
	const result = compactResultSummary(details.resultSummary);
	if (result && details.status !== "running") lines.push(`Summary: ${result}`);
	if (details.error) lines.push(`Run error: ${collapseWhitespace(details.error)}`);
	return lines;
}

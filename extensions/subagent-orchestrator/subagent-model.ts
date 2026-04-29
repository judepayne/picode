import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentAssetFile } from "../agent-assets/contract.ts";
import { normalizeOptionalFrontmatterString } from "../agent-assets/frontmatter-values.ts";
import { parseToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { findAgentAssetFile } from "./max-subagent-depth.ts";

interface ModelLike {
	provider?: unknown;
	id?: unknown;
	modelID?: unknown;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseStringList(value: string | undefined): string[] | undefined {
	const normalized = normalizeString(value);
	if (!normalized) return undefined;
	const unquoted = unquote(normalized);
	if (!unquoted || unquoted === "-") return undefined;
	const list = unquoted.startsWith("[") && unquoted.endsWith("]") ? unquoted.slice(1, -1) : unquoted;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of list.split(",")) {
		const item = unquote(entry).trim();
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function resolveExtensionPath(rawPath: string, cardFilePath: string): string {
	const expanded = rawPath === "~"
		? os.homedir()
		: rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")
			? path.join(os.homedir(), rawPath.slice(2))
			: rawPath;
	return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(cardFilePath), expanded);
}

function readMarkdown(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function parseFrontmatter(raw: string): { attributes: Record<string, string>; body: string } {
	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!fmMatch?.[1]) {
		return { attributes: {}, body: raw.trim() };
	}
	const attributes: Record<string, string> = {};
	for (const line of fmMatch[1].split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		attributes[match[1].toLowerCase()] = match[2] ?? "";
	}
	return {
		attributes,
		body: (fmMatch[2] ?? "").trim(),
	};
}

function readFrontmatterAttributes(filePath: string): Record<string, string> | undefined {
	const raw = readMarkdown(filePath);
	if (!raw) return undefined;
	return parseFrontmatter(raw).attributes;
}

function readFrontmatterStringAttribute(filePath: string, attribute: string): string | undefined {
	const attributes = readFrontmatterAttributes(filePath);
	return normalizeOptionalFrontmatterString(attributes?.[attribute.toLowerCase()]);
}

function readNamedAgentFilePathFromFiles(files: readonly AgentAssetFile[], id: string): string | undefined {
	return findAgentAssetFile(files, id)?.filePath;
}

function readNamedAgentAttributeFromFiles(files: readonly AgentAssetFile[], id: string, attribute: string): string | undefined {
	const filePath = readNamedAgentFilePathFromFiles(files, id);
	return filePath ? readFrontmatterStringAttribute(filePath, attribute) : undefined;
}

export function normalizeThinkingLevel(value: string | undefined): string | undefined {
	const normalized = normalizeString(value)?.toLowerCase();
	return normalized && THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function readInstructionsFromFile(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const raw = readMarkdown(filePath);
	if (!raw) return undefined;
	const { body } = parseFrontmatter(raw);
	return body || undefined;
}

export function readNamedAgentModelFromFiles(files: readonly AgentAssetFile[], id: string): string | undefined {
	return readNamedAgentAttributeFromFiles(files, id, "model");
}

export function readNamedAgentThinkingFromFiles(files: readonly AgentAssetFile[], id: string): string | undefined {
	return normalizeThinkingLevel(readNamedAgentAttributeFromFiles(files, id, "thinking"));
}

export function readNamedAgentToolSelectionFromFiles(files: readonly AgentAssetFile[], id: string): ToolSelectionSpec | undefined {
	const filePath = readNamedAgentFilePathFromFiles(files, id);
	if (!filePath) return undefined;
	const attributes = readFrontmatterAttributes(filePath) ?? {};
	return parseToolSelection({ tools: attributes.tools, banTools: attributes.ban_tools });
}

export function readNamedAgentToolsFromFiles(files: readonly AgentAssetFile[], id: string): string[] | undefined {
	const selection = readNamedAgentToolSelectionFromFiles(files, id);
	if (!selection) return undefined;
	if (selection.toolsMode === "list") return selection.tools;
	if (selection.toolsMode === "all") return ["all"];
	return undefined;
}

export function readNamedAgentExtensionPathsFromFiles(files: readonly AgentAssetFile[], id: string): string[] | undefined {
	const filePath = readNamedAgentFilePathFromFiles(files, id);
	if (!filePath) return undefined;
	const attributes = readFrontmatterAttributes(filePath) ?? {};
	return parseStringList(attributes.extensions)?.map((entry) => resolveExtensionPath(entry, filePath));
}

export function readNamedAgentInstructionsFromFiles(files: readonly AgentAssetFile[], id: string): string | undefined {
	return readInstructionsFromFile(readNamedAgentFilePathFromFiles(files, id));
}

export function formatModelReference(model: ModelLike | undefined): string | undefined {
	const provider = normalizeString(model?.provider);
	const id = normalizeString(model?.id) ?? normalizeString(model?.modelID);
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

import * as fs from "node:fs";

import type { AgentAssetFile } from "../agent-assets/contract.ts";
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
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function readMarkdown(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function parseFrontmatter(raw: string): { attributes: string; body: string } {
	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!fmMatch?.[1]) {
		return { attributes: "", body: raw.trim() };
	}
	return {
		attributes: fmMatch[1],
		body: (fmMatch[2] ?? "").trim(),
	};
}

function readFrontmatterStringAttribute(filePath: string, attribute: string): string | undefined {
	const raw = readMarkdown(filePath);
	if (!raw) return undefined;
	const { attributes } = parseFrontmatter(raw);
	const attrMatch = attributes.match(new RegExp(`^${attribute}:\\s*(.+?)\\s*$`, "m"));
	const value = normalizeString(attrMatch?.[1]);
	return value ? unquote(value) : undefined;
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

function parseTools(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const normalized = value
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((entry) => normalizeString(unquote(entry)))
		.filter((entry): entry is string => Boolean(entry));
	return normalized.length > 0 ? normalized : undefined;
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

export function readNamedAgentToolsFromFiles(files: readonly AgentAssetFile[], id: string): string[] | undefined {
	return parseTools(readNamedAgentAttributeFromFiles(files, id, "tools"));
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

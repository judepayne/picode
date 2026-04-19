import * as fs from "node:fs";

import { findAgentMarkdownPath, findAgentMarkdownPathInDirs } from "./max-subagent-depth.ts";

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

function readNamedAgentFilePath(rootDir: string, id: string): string | undefined {
	return findAgentMarkdownPath(rootDir, id);
}

function readNamedAgentFilePathFromDirs(rootDirs: readonly string[], id: string): string | undefined {
	return findAgentMarkdownPathInDirs(rootDirs, id);
}

function readNamedAgentAttribute(rootDir: string, id: string, attribute: string): string | undefined {
	const filePath = readNamedAgentFilePath(rootDir, id);
	return filePath ? readFrontmatterStringAttribute(filePath, attribute) : undefined;
}

function readNamedAgentAttributeFromDirs(rootDirs: readonly string[], id: string, attribute: string): string | undefined {
	const filePath = readNamedAgentFilePathFromDirs(rootDirs, id);
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

export function readNamedAgentModel(rootDir: string, id: string): string | undefined {
	return readNamedAgentAttribute(rootDir, id, "model");
}

export function readNamedAgentModelFromDirs(rootDirs: readonly string[], id: string): string | undefined {
	return readNamedAgentAttributeFromDirs(rootDirs, id, "model");
}

export function readNamedAgentThinking(rootDir: string, id: string): string | undefined {
	return normalizeThinkingLevel(readNamedAgentAttribute(rootDir, id, "thinking"));
}

export function readNamedAgentThinkingFromDirs(rootDirs: readonly string[], id: string): string | undefined {
	return normalizeThinkingLevel(readNamedAgentAttributeFromDirs(rootDirs, id, "thinking"));
}

export function readNamedAgentTools(rootDir: string, id: string): string[] | undefined {
	return parseTools(readNamedAgentAttribute(rootDir, id, "tools"));
}

export function readNamedAgentToolsFromDirs(rootDirs: readonly string[], id: string): string[] | undefined {
	return parseTools(readNamedAgentAttributeFromDirs(rootDirs, id, "tools"));
}

export function readNamedAgentInstructions(rootDir: string, id: string): string | undefined {
	return readInstructionsFromFile(readNamedAgentFilePath(rootDir, id));
}

export function readNamedAgentInstructionsFromDirs(rootDirs: readonly string[], id: string): string | undefined {
	return readInstructionsFromFile(readNamedAgentFilePathFromDirs(rootDirs, id));
}

export function formatModelReference(model: ModelLike | undefined): string | undefined {
	const provider = normalizeString(model?.provider);
	const id = normalizeString(model?.id) ?? normalizeString(model?.modelID);
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

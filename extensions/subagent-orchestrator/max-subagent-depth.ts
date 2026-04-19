import * as fs from "node:fs";
import * as path from "node:path";

import { currentSubagentDepth, normalizeMaxSubagentDepth, resolveCurrentMaxSubagentDepth } from "../subagent-mode/depth.ts";

function parseFrontmatterMaxSubagentDepth(raw: string): number | undefined {
	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fmMatch?.[1]) return undefined;
	const depthMatch = fmMatch[1].match(/^maxSubagentDepth:\s*(-?\d+)\s*$/m);
	if (!depthMatch?.[1]) return undefined;
	return normalizeMaxSubagentDepth(depthMatch[1]);
}

export function readMarkdownMaxSubagentDepth(filePath: string): number | undefined {
	try {
		return parseFrontmatterMaxSubagentDepth(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export function findAgentMarkdownPath(rootDir: string, id: string): string | undefined {
	const normalizedId = id.trim().toLowerCase();
	if (!normalizedId) return undefined;

	let entries: string[];
	try {
		entries = fs.readdirSync(rootDir);
	} catch {
		return undefined;
	}

	const markdownFiles = entries
		.filter((entry) => entry.toLowerCase().endsWith(".md"))
		.sort((a, b) => a.localeCompare(b));

	const exactMatch = markdownFiles.find((entry) => entry.toLowerCase() === `${normalizedId}.md`);
	if (exactMatch) return path.join(rootDir, exactMatch);

	const suffixMatch = markdownFiles.find((entry) => entry.toLowerCase().endsWith(`-${normalizedId}.md`));
	if (suffixMatch) return path.join(rootDir, suffixMatch);

	for (const entry of markdownFiles) {
		const filePath = path.join(rootDir, entry);
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+?)\s*$/m);
			if (nameMatch?.[1]?.trim().toLowerCase() === normalizedId) return filePath;
		} catch {
			// Ignore unreadable files and continue scanning.
		}
	}

	return undefined;
}

export function readNamedAgentMaxSubagentDepth(rootDir: string, id: string): number | undefined {
	const filePath = findAgentMarkdownPath(rootDir, id);
	return filePath ? readMarkdownMaxSubagentDepth(filePath) : undefined;
}

export function findAgentMarkdownPathInDirs(rootDirs: readonly string[], id: string): string | undefined {
	for (const rootDir of rootDirs) {
		const filePath = findAgentMarkdownPath(rootDir, id);
		if (filePath) return filePath;
	}
	return undefined;
}

export function readNamedAgentMaxSubagentDepthFromDirs(rootDirs: readonly string[], id: string): number | undefined {
	const filePath = findAgentMarkdownPathInDirs(rootDirs, id);
	return filePath ? readMarkdownMaxSubagentDepth(filePath) : undefined;
}

export interface ResolveDelegatedRunMaxSubagentDepthInput {
	parentModeMaxSubagentDepth?: number;
	childAgentMaxSubagentDepth?: number;
	currentDepth?: number;
}

/**
 * Convert relative frontmatter settings into the absolute depth ceiling consumed
 * by subagent-mode.
 *
 * Semantics:
 * - parent mode config: how many subagent levels may exist below the current agent
 * - child subagent config: how many subagent levels may exist below that child
 * - inherited PI_SUBAGENT_MAX_DEPTH always wins over a looser parent mode config
 * - the effective ceiling is the stricter of the inherited/parent ceiling and
 *   the child agent's own ceiling
 */
export function resolveDelegatedRunMaxSubagentDepth(input: ResolveDelegatedRunMaxSubagentDepthInput = {}): number {
	const currentDepth = input.currentDepth ?? currentSubagentDepth();
	const normalizedParent = normalizeMaxSubagentDepth(input.parentModeMaxSubagentDepth);
	const parentAbsoluteCeiling = resolveCurrentMaxSubagentDepth(
		normalizedParent === undefined ? undefined : currentDepth + normalizedParent,
	);

	const normalizedChild = normalizeMaxSubagentDepth(input.childAgentMaxSubagentDepth);
	if (normalizedChild === undefined) return parentAbsoluteCeiling;

	const childAbsoluteCeiling = currentDepth + normalizedChild + 1;
	return Math.min(parentAbsoluteCeiling, childAbsoluteCeiling);
}

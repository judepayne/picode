import * as fs from "node:fs";

import type { AgentAssetFile } from "../agent-assets/contract.ts";
import { currentSubagentDepth, normalizeMaxSubagentDepth, resolveCurrentMaxSubagentDepth } from "../subagent-mode/depth.ts";

function normalizeLookupToken(value: string): string {
	return value.trim().toLowerCase();
}

function readFrontmatterName(filePath: string): string | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+?)\s*$/m);
		return nameMatch?.[1]?.trim().toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

function isExactFileNameMatch(fileName: string, normalizedId: string): boolean {
	return fileName.toLowerCase() === `${normalizedId}.md`;
}

function isSuffixFileNameMatch(fileName: string, normalizedId: string): boolean {
	return fileName.toLowerCase().endsWith(`-${normalizedId}.md`);
}

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

export function findAgentAssetFile(files: readonly AgentAssetFile[], id: string): AgentAssetFile | undefined {
	const normalizedId = normalizeLookupToken(id);
	if (!normalizedId) return undefined;

	const exactMatch = files.find((file) => isExactFileNameMatch(file.fileName, normalizedId));
	if (exactMatch) return exactMatch;

	const suffixMatch = files.find((file) => isSuffixFileNameMatch(file.fileName, normalizedId));
	if (suffixMatch) return suffixMatch;

	for (const file of files) {
		if (readFrontmatterName(file.filePath) === normalizedId) return file;
	}

	return undefined;
}

export function readNamedAgentMaxSubagentDepthFromFiles(files: readonly AgentAssetFile[], id: string): number | undefined {
	const file = findAgentAssetFile(files, id);
	return file ? readMarkdownMaxSubagentDepth(file.filePath) : undefined;
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

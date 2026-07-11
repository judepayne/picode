import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	buildPathCandidateGroup,
	normalizePathArg,
	normalizeSlashes,
	type CandidateGroup,
} from "./matching.ts";

function extractPathStrings(input: Record<string, unknown>, fields: string[]): string[] {
	const paths: string[] = [];
	for (const field of fields) {
		const value = input[field];
		if (typeof value === "string") paths.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") paths.push(item);
			}
		}
	}
	return paths;
}

export function getToolPermissionSubject(toolName: string): string {
	switch (toolName) {
		case "write":
		case "apply_migration":
			return "edit";
		case "find":
			return "glob";
		case "ls":
			return "list";
		default:
			return toolName;
	}
}

export const SEMANTIC_GENERIC_TOOL_NAMES = new Set(["vars"]);

function boundedJson(value: unknown, maxChars = 2000): unknown {
	try {
		const text = JSON.stringify(value);
		if (text.length <= maxChars) return value;
		return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
	} catch {
		return "<unserializable>";
	}
}

export function getGenericToolSubjectGroups(toolName: string, input: Record<string, unknown>): CandidateGroup[] {
	const values = new Set<string>([toolName]);
	const action = input.action;
	if (typeof action === "string" && action.trim()) values.add(`${toolName}:${action.trim()}`);
	const key = input.key;
	if (typeof key === "string" && key.trim()) values.add(`${toolName}:key:${key.trim()}`);
	const pathValue = input.path;
	if (typeof pathValue === "string" && pathValue.trim()) values.add(`${toolName}:path:${normalizeSlashes(pathValue.trim())}`);
	return [{ display: `${toolName} ${JSON.stringify(boundedJson(input, 500))}`, values: Array.from(values) }];
}

export function getToolSubjectGroups(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): CandidateGroup[] {
	switch (toolName) {
		case "read": {
			const rawPath = typeof input.path === "string" ? input.path : "";
			return rawPath ? [buildPathCandidateGroup(rawPath, ctx.cwd)] : [];
		}
		case "write":
		case "edit":
		case "apply_migration": {
			return extractPathStrings(input, toolName === "apply_migration" ? ["path", "backupPath"] : ["path"])
				.map((rawPath) => buildPathCandidateGroup(rawPath, ctx.cwd));
		}
		case "ls": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [buildPathCandidateGroup(rawPath, ctx.cwd)];
		}
		case "find": {
			const pattern = typeof input.pattern === "string" ? normalizeSlashes(input.pattern) : "";
			return [{ display: pattern || "<empty glob>", values: [pattern] }];
		}
		case "grep": {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			return [{ display: pattern || "<empty pattern>", values: [pattern] }];
		}
		default:
			return [];
	}
}

function extractGenericPathCandidates(input: Record<string, unknown>, ctx: ExtensionContext): string[] {
	const pathLike = /(^|_)(path|file|filename|source|target|destination|backupPath)(_|$)/i;
	const values: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (!pathLike.test(key)) continue;
		if (typeof value === "string") values.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") values.push(item);
			}
		}
	}
	return values.map((value) => normalizePathArg(value, ctx.cwd));
}

export function getToolPathCandidates(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): string[] {
	switch (toolName) {
		case "read":
			return typeof input.path === "string" ? [normalizePathArg(input.path, ctx.cwd)] : [];
		case "write":
		case "edit":
			return extractPathStrings(input, ["path"]).map((value) => normalizePathArg(value, ctx.cwd));
		case "apply_migration":
			return extractPathStrings(input, ["path", "backupPath"]).map((value) => normalizePathArg(value, ctx.cwd));
		case "ls": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [normalizePathArg(rawPath, ctx.cwd)];
		}
		case "find":
		case "grep": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [normalizePathArg(rawPath, ctx.cwd)];
		}
		default:
			return extractGenericPathCandidates(input, ctx);
	}
}


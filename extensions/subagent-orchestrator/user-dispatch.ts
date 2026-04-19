import type { DelegationContext } from "./types.ts";
import { getMergedStoredVarValue } from "../z-prompt-vars/prompt-vars.ts";

const DEFAULT_DISPATCH_CONTEXT: DelegationContext = "fork";
const USER_DISPATCH_PREFIX = "~";

export interface ParsedUserDispatch {
	agent: string;
	context: DelegationContext;
	task: string;
}

function readConfiguredDefaultContext(cwd: string): DelegationContext | undefined {
	const value = getMergedStoredVarValue(cwd, "subagents.dispatch.defaultContext");
	return value === "fresh" || value === "fork" ? value : undefined;
}

function resolveDispatchContext(cwd: string, override?: DelegationContext): DelegationContext {
	return override ?? readConfiguredDefaultContext(cwd) ?? DEFAULT_DISPATCH_CONTEXT;
}

function normalizeAllowedSubagents(allowedSubagents: string[]): Set<string> {
	return new Set(
		allowedSubagents
			.map((subagent) => subagent.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function parseUserDispatch(
	text: string,
	allowedSubagents: string[],
	cwd: string,
): ParsedUserDispatch | undefined {
	const match = /^~([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/u.exec(text);
	if (!match) return undefined;

	const allowed = normalizeAllowedSubagents(allowedSubagents);
	const agent = match[1]?.trim().toLowerCase();
	if (!agent || !allowed.has(agent)) return undefined;

	const rawRemainder = (match[2] ?? "").trim();
	if (!rawRemainder) return undefined;

	let contextOverride: DelegationContext | undefined;
	let task = rawRemainder;
	if (task === "--fresh" || task === "--fork") return undefined;
	const overrideMatch = /^(--fresh|--fork)\s+([\s\S]+)$/u.exec(task);
	if (overrideMatch) {
		contextOverride = overrideMatch[1] === "--fresh" ? "fresh" : "fork";
		task = overrideMatch[2]?.trim() ?? "";
	}

	if (!task) return undefined;

	return {
		agent,
		context: resolveDispatchContext(cwd, contextOverride),
		task,
	};
}

export function shouldOfferUserDispatchAutocomplete(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	if (cursorLine !== 0) return undefined;
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	if (!textBeforeCursor.startsWith(USER_DISPATCH_PREFIX)) return undefined;
	if (!/^~[A-Za-z0-9_-]*$/u.test(textBeforeCursor)) return undefined;
	return textBeforeCursor;
}

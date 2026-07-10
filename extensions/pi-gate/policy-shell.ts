import { normalizeCommand } from "./matching.ts";
import { firstCommandIndex, normalizeShellToken } from "./shell-mutation.ts";
import { parseConservativeShellPipeline, tokenizeShellCommand } from "../shared/shell-analysis.ts";

export function buildBashSessionKey(command: string): string {
	return `bash:${normalizeCommand(command)}`;
}

export function buildPathSessionKey(subject: string, values: string[]): string {
	return `${subject}:${[...values].sort().join("|")}`;
}

interface PolicyBashComposite {
	segments?: string[];
	error?: string;
}

function isSafePipefailPrologue(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens[0] !== "set" || tokens.length < 3) return false;
	let sawPipefail = false;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (/^-[eEu]+$/.test(token)) continue;
		if (token === "-o" || /^-[eEu]+o$/.test(token)) {
			if (tokens[index + 1] !== "pipefail") return false;
			sawPipefail = true;
			index++;
			continue;
		}
		return false;
	}
	return sawPipefail;
}

export function analyzePolicyBashComposite(command: string): PolicyBashComposite | undefined {
	const rawLooksComposite = /&&|\|/.test(command);
	const parsed = parseConservativeShellPipeline(command);
	if (!parsed) return rawLooksComposite ? { error: "unparseable shell composite requires review" } : undefined;
	const hasAnd = parsed.operators.includes("&&");
	const hasPipeline = parsed.operators.includes("|") || parsed.operators.includes("|&");
	if (!hasAnd && !hasPipeline) return undefined;
	if (parsed.segments.length < 2) return { error: "unparseable shell composite requires review" };
	const segments = [...parsed.segments];
	if (hasPipeline && isSafePipefailPrologue(segments[0] ?? "")) segments.shift();
	return segments.length > 0 ? { segments } : { error: "shell composite has no commands to review" };
}

export function getChainUnsafeShellSegmentReason(command: string): string | undefined {
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens.length === 0) return "unparseable chain component requires review";
	const commandIndex = firstCommandIndex(tokens);
	const primary = normalizeShellToken(tokens[commandIndex] ?? "");
	const secondary = normalizeShellToken(tokens[commandIndex + 1] ?? "");
	if (!primary) return "shell assignment chain components require review";
	const cwdUnsafeBuiltins = new Set(["cd", "pushd", "popd", "source", ".", "eval"]);
	let wrapped = secondary;
	if (primary === "builtin" || primary === "command") {
		let wrappedIndex = commandIndex + 1;
		while (wrappedIndex < tokens.length) {
			const token = normalizeShellToken(tokens[wrappedIndex] ?? "");
			if (token === "--" || token.startsWith("-")) {
				wrappedIndex++;
				continue;
			}
			wrapped = token;
			break;
		}
	}
	if (cwdUnsafeBuiltins.has(primary) || ((primary === "builtin" || primary === "command") && cwdUnsafeBuiltins.has(wrapped))) {
		return "cwd-changing chain components require review";
	}
	const shellStateBuiltins = new Set(["alias", "unalias", "declare", "enable", "export", "local", "readonly", "set", "shopt", "typeset", "unset"]);
	if (shellStateBuiltins.has(primary)) return "shell-state-changing chain components require review";
	if (primary.startsWith("~") || primary.includes("/")) return "path-like command chain components require review";
	return undefined;
}


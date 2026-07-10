import { analyzeShellCommand, type ConservativeShellAnalysis } from "../shared/shell-analysis.ts";
import { normalizeAbsPath, normalizePathArg } from "./matching.ts";
import type { MutationAnalysis } from "./policy-types.ts";

const SHELL_SEPARATOR_TOKENS = new Set([";", "&&", "||", "|", "|&", "&", "then", "do", "else", "elif", "fi"]);

function isIgnorableRedirectionTarget(candidate: string): boolean {
	const normalized = normalizeAbsPath(candidate);
	return normalized === "/dev/null" || normalized === "/dev/stdout" || normalized === "/dev/stderr" || normalized === "/dev/tty";
}

function isComplexShellCommand(analysis: ConservativeShellAnalysis): boolean {
	return !analysis.tokens || analysis.hasSubstitution || analysis.hasControlOperator;
}

export function normalizeShellToken(token: string): string {
	return token.replace(/^[;()]+/, "").replace(/[;()]+$/, "");
}

function isShellSeparator(token: string): boolean {
	return SHELL_SEPARATOR_TOKENS.has(token);
}

function collectComplexCommandArgs(tokens: string[], start: number): string[] {
	const args: string[] = [];
	for (let i = start; i < tokens.length; i++) {
		const raw = normalizeShellToken(tokens[i] ?? "");
		if (!raw) continue;
		if (isShellSeparator(raw)) break;
		args.push(raw);
	}
	return args;
}

function extractComplexMutationTargets(tokens: string[], cwd: string): MutationAnalysis {
	const candidates = new Set<string>();
	let inferredCwdTarget = false;

	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		if ((token === ">" || token === ">>") && tokens[i + 1]) {
			const redirected = normalizePathArg(normalizeShellToken(tokens[i + 1]!), cwd);
			if (!isIgnorableRedirectionTarget(redirected)) candidates.add(redirected);
		}
	}

	const collectPaths = (values: string[]) => {
		for (const value of values) {
			if (!value || value === ">" || value === ">>") continue;
			candidates.add(normalizePathArg(value, cwd));
		}
	};

	for (let i = 0; i < tokens.length; i++) {
		const primary = normalizeShellToken(tokens[i] ?? "");
		const secondary = normalizeShellToken(tokens[i + 1] ?? "");
		if (!primary || isShellSeparator(primary)) continue;

		const args = collectComplexCommandArgs(tokens, i + 1);
		if (["rm", "rmdir", "mkdir", "touch", "tee", "ln", "install"].includes(primary)) {
			collectPaths(args.filter((token) => !token.startsWith("-")));
			continue;
		}
		if (["mv", "cp"].includes(primary)) {
			collectPaths(args.filter((token) => !token.startsWith("-")));
			continue;
		}
		if (["chmod", "chown"].includes(primary)) {
			const nonOptions = args.filter((token) => !token.startsWith("-"));
			collectPaths(nonOptions.slice(1));
			continue;
		}
		if (primary === "git" && secondary === "clean") {
			const gitArgs = collectComplexCommandArgs(tokens, i + 2);
			const pathspecs = gitArgs.filter((token) => !token.startsWith("-"));
			if (pathspecs.length > 0) collectPaths(pathspecs);
			else inferredCwdTarget = true;
			continue;
		}
		if (primary === "find") {
			const deleteIndex = args.findIndex((token) => token === "-delete");
			if (deleteIndex >= 0) {
				const pathTokens = args.filter((token, index) => index < deleteIndex && !token.startsWith("-"));
				if (pathTokens.length > 0) collectPaths(pathTokens);
				else inferredCwdTarget = true;
			}
			continue;
		}
	}

	return {
		mutating: true,
		complex: true,
		paths: Array.from(candidates),
		inferredCwdTarget,
		reason:
			candidates.size > 0 || inferredCwdTarget
				? "complex shell command with extracted mutation targets"
				: "complex shell command without reliable target extraction",
	};
}

export function firstCommandIndex(tokens: string[]): number {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
			index++;
			continue;
		}
		if (token === "env") {
			index++;
			continue;
		}
		break;
	}
	return index;
}

function collectNonOptionArgs(tokens: string[], start: number): string[] {
	return tokens.slice(start).filter((token) => token !== ">" && token !== ">>" && !token.startsWith("-"));
}

function hasMutatingAwkPattern(command: string): boolean {
	if (!/\bawk\b/i.test(command)) return false;
	return /\bsystem\s*\(/i.test(command) || /\bprint\b[\s\S]*>>?/i.test(command);
}

function getUnknownExecutableReason(tokens: string[] | undefined): string | undefined {
	if (!tokens || tokens.length === 0) return undefined;
	const commandIndex = firstCommandIndex(tokens);
	const primary = normalizeShellToken(tokens[commandIndex] ?? "");
	if (!primary) return undefined;
	if (primary.startsWith("./") || primary.startsWith("../")) return "unknown local executable; side effects unknown";
	if (primary.includes("/") && !primary.startsWith("/bin/") && !primary.startsWith("/usr/bin/")) return "unknown executable path; side effects unknown";
	return undefined;
}

export function extractMutationTargets(command: string, cwd: string): MutationAnalysis {
	const lower = command.toLowerCase();
	const shellAnalysis = analyzeShellCommand(command);
	const tokens = shellAnalysis.tokens;
	const tokenizedFindDelete = tokens?.some((token, index) =>
		normalizeShellToken(token).toLowerCase() === "find"
		&& tokens.slice(index + 1).some((arg) => normalizeShellToken(arg) === "-delete")
	) ?? false;
	const mutating = /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btee\b|\bln\b|\binstall\b|\bchmod\b|\bchown\b|\bfind\b[^\n]*\s-delete\b|\bgit\s+clean\b|>|\bsed\b[^\n]*\s-i|\bperl\b[^\n]*\s-pi/.test(lower)
		|| tokenizedFindDelete
		|| hasMutatingAwkPattern(command);
	const complex = isComplexShellCommand(shellAnalysis);
	if (!mutating) {
		return { mutating: false, complex, paths: [], inferredCwdTarget: false, reason: getUnknownExecutableReason(tokens) ?? "read-only command" };
	}

	if (complex && tokens && tokens.length > 0) {
		return extractComplexMutationTargets(tokens, cwd);
	}
	if (!tokens || tokens.length === 0) {
		return { mutating: true, complex: false, paths: [], inferredCwdTarget: false, reason: "could not parse command" };
	}

	const candidates = new Set<string>();
	let inferredCwdTarget = false;
	for (let i = 0; i < tokens.length - 1; i++) {
		if ((tokens[i] === ">" || tokens[i] === ">>") && tokens[i + 1]) {
			const redirected = normalizePathArg(tokens[i + 1]!, cwd);
			if (!isIgnorableRedirectionTarget(redirected)) candidates.add(redirected);
		}
	}

	const commandIndex = firstCommandIndex(tokens);
	const primary = tokens[commandIndex];
	const secondary = tokens[commandIndex + 1];
	if (!primary) {
		return { mutating: true, complex: false, paths: Array.from(candidates), inferredCwdTarget: false, reason: "missing command token" };
	}

	const args = tokens.slice(commandIndex + 1);
	const collectPaths = (rawValues: string[]) => {
		for (const value of rawValues) {
			if (!value || value === ">" || value === ">>") continue;
			candidates.add(normalizePathArg(value, cwd));
		}
	};

	if (primary === "git" && secondary === "clean") {
		const pathspecs = collectNonOptionArgs(tokens, commandIndex + 2);
		if (pathspecs.length > 0) collectPaths(pathspecs);
		else inferredCwdTarget = true;
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget,
			reason: inferredCwdTarget ? "git clean in current working directory" : "git clean pathspecs",
		};
	}

	if (primary === "find") {
		const deleteIndex = args.findIndex((token) => token === "-delete");
		if (deleteIndex >= 0) {
			const pathTokens = args.filter((token, index) => index < deleteIndex && !token.startsWith("-"));
			if (pathTokens.length > 0) collectPaths(pathTokens);
			else inferredCwdTarget = true;
		}
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget,
			reason: inferredCwdTarget ? "find -delete in current working directory" : "find -delete targets",
		};
	}

	if (["rm", "rmdir", "mkdir", "touch", "tee", "ln", "install"].includes(primary)) {
		collectPaths(args.filter((token) => !token.startsWith("-")));
	} else if (["mv", "cp"].includes(primary)) {
		collectPaths(args.filter((token) => !token.startsWith("-")));
	} else if (["chmod", "chown"].includes(primary)) {
		const nonOptions = args.filter((token) => !token.startsWith("-"));
		collectPaths(nonOptions.slice(1));
	} else if (primary === "sed" && args.some((token) => token.startsWith("-i"))) {
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget: false,
			reason: "sed -i without reliable path extraction",
		};
	} else if (primary === "perl" && args.some((token) => token.includes("-pi"))) {
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget: false,
			reason: "perl -pi without reliable path extraction",
		};
	}

	return {
		mutating: true,
		complex: false,
		paths: Array.from(candidates),
		inferredCwdTarget,
		reason: candidates.size > 0 ? "extracted mutation targets" : "could not determine mutation target",
	};
}


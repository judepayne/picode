import {
	expandPatternValue,
	isPathSubject,
	normalizeCommand,
	normalizeSlashes,
	wildcardToRegex,
} from "../matching.ts";
import { splitConservativeShellChain, tokenizeShellCommand } from "../../shared/shell-analysis.ts";

import type {
	GateSemanticConfig,
	GateSemanticEvaluation,
	GateSemanticEvaluationInput,
	GateSemanticMatch,
	GateSemanticRoleContext,
	GateSemanticRoleType,
	GateSemanticRuleMap,
	GateSemanticSubject,
} from "./types.ts";

function compilePattern(subject: GateSemanticSubject, rawPattern: string, cwd: string): RegExp {
	const expanded = subject === "bash" ? normalizeCommand(rawPattern) : isPathSubject(subject) ? expandPatternValue(rawPattern, cwd) : normalizeSlashes(rawPattern);
	return wildcardToRegex(expanded);
}

function commandBasename(value: string): string {
	return value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? value;
}

function envOptionConsumesNext(token: string): boolean {
	return token === "-u" || token === "--unset" || token === "-C" || token === "--chdir" || token === "-S" || token === "--split-string" || token === "-a" || token === "--argv0" || token === "--block-signal" || token === "--default-signal" || token === "--ignore-signal";
}

function envOptionWithoutOperand(token: string): boolean {
	return token === "-i" || token === "--ignore-environment" || token === "-0" || token === "--null" || token === "--debug" || token === "--";
}

function normalizeShellToken(value: string): string {
	let token = value.trim().split(/[;&<>]/, 1)[0] ?? value.trim();
	token = commandBasename(token);
	while (token.startsWith("(") && token.endsWith(")") && token.length > 2) token = token.slice(1, -1).trim();
	return token;
}

function shellFromEnvSplitString(token: string, shells: Set<string>): boolean {
	const tokens = tokenizeShellCommand(token) ?? token.trim().split(/\s+/).filter(Boolean);
	const splitStringWrappers = new Set(["env", "command", "builtin", "exec", "nohup", "nice", "time", "setsid", "sudo", "doas", "stdbuf", "unbuffer", "timeout"]);
	for (const part of tokens) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(part)) continue;
		if (/[`$]/.test(part)) return true;
		const base = normalizeShellToken(part);
		return shells.has(base) || splitStringWrappers.has(base);
	}
	return false;
}

const PIPE_COMMAND_WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "nice", "time", "setsid", "sudo", "doas", "stdbuf", "unbuffer", "timeout"]);

function wrapperOptionConsumesNext(wrapper: string, token: string): boolean {
	if (wrapper === "exec") return token === "-a";
	if (wrapper === "nice") return token === "-n" || token === "--adjustment";
	if (wrapper === "sudo" || wrapper === "doas") return token === "-u" || token === "--user" || token === "-g" || token === "--group" || token === "-h" || token === "--host" || token === "-p" || token === "--prompt" || token === "-C" || token === "--close-from" || token === "-T" || token === "--command-timeout";
	if (wrapper === "stdbuf") return token === "-o" || token === "--output" || token === "-e" || token === "--error" || token === "-i" || token === "--input";
	if (wrapper === "timeout") return token === "-k" || token === "--kill-after" || token === "-s" || token === "--signal";
	return false;
}

function wrapperOptionWithoutOperand(wrapper: string, token: string): boolean {
	if (wrapper === "command" || wrapper === "builtin") return token === "-p" || token === "-v" || token === "-V";
	if (wrapper === "exec") return token === "-c" || token === "-l";
	if (wrapper === "time") return token === "-p";
	if (wrapper === "setsid") return token === "-w" || token === "--wait" || token === "-f" || token === "--fork" || token === "-c" || token === "--ctty";
	if (wrapper === "sudo" || wrapper === "doas") return token === "-E" || token === "-S" || token === "-n" || token === "-H" || token === "-b" || token === "-k" || token === "-K" || token === "-v" || token === "-l";
	if (wrapper === "timeout") return token === "--preserve-status" || token === "--foreground" || token === "-v" || token === "--verbose";
	return false;
}

function skipWrapperArgs(tokens: string[], commandIndex: number, wrapper: string): number | undefined {
	let index = commandIndex + 1;
	let skippedTimeoutDuration = false;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
			index++;
			continue;
		}
		if (wrapperOptionConsumesNext(wrapper, token)) {
			index += 2;
			continue;
		}
		if (token.startsWith("-") && token !== "--") {
			if (wrapperOptionWithoutOperand(wrapper, token) || token.includes("=") || /^-[A-Za-z].+/.test(token)) {
				index++;
				continue;
			}
			return undefined;
		}
		if (token === "--") {
			index++;
			continue;
		}
		if (wrapper === "timeout" && !skippedTimeoutDuration) {
			skippedTimeoutDuration = true;
			index++;
			continue;
		}
		break;
	}
	return index;
}

function findPipeToShell(command: string | undefined): GateSemanticMatch | undefined {
	const normalized = normalizeCommand(command ?? "");
	const tokens = tokenizeShellCommand(normalized);
	if (!tokens) return undefined;
	const shells = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index] !== "|" && tokens[index] !== "|&") continue;
		let commandIndex = index + 1;
		while (commandIndex < tokens.length) {
			const token = tokens[commandIndex] ?? "";
			const base = normalizeShellToken(token);
			if (token === "(" || token === ")") {
				commandIndex++;
				continue;
			}
			if (PIPE_COMMAND_WRAPPERS.has(base)) {
				const nextIndex = skipWrapperArgs(tokens, commandIndex, base);
				if (nextIndex === undefined) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
				commandIndex = nextIndex;
				continue;
			}
			if (base === "env") {
				commandIndex++;
				while (commandIndex < tokens.length) {
					const envArg = tokens[commandIndex] ?? "";
					if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(envArg)) {
						commandIndex++;
						continue;
					}
					if (envOptionConsumesNext(envArg)) {
						const operand = tokens[commandIndex + 1] ?? "";
						if ((envArg === "-S" || envArg === "--split-string") && shellFromEnvSplitString(operand, shells)) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
						commandIndex += 2;
						continue;
					}
					if (envArg.startsWith("--split-string=") && shellFromEnvSplitString(envArg.slice("--split-string=".length), shells)) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
					if (envArg.startsWith("-S") && envArg.length > 2 && shellFromEnvSplitString(envArg.slice(2), shells)) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
					if (envArg.startsWith("-")) {
						if (envOptionWithoutOperand(envArg) || envArg.includes("=") || /^-[A-Za-z].+/.test(envArg)) {
							commandIndex++;
							continue;
						}
						return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
					}
					break;
				}
				continue;
			}
			if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
				commandIndex++;
				continue;
			}
			if (/[`$]/.test(token)) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
			if (shells.has(base)) return { kind: "hardDeny", scope: "global", subject: "bash", pattern: "pipe-to-shell", display: normalized };
			break;
		}
	}
	return undefined;
}

function findRuleMatch(
	rules: GateSemanticRuleMap | undefined,
	subject: GateSemanticSubject,
	groups: Array<{ display: string; values: string[] }>,
	cwd: string,
	scope: "global" | "role",
	kind: "hardDeny" | "alwaysAllow",
): GateSemanticMatch | undefined {
	const patterns = rules?.[subject] ?? [];
	for (const rawPattern of patterns) {
		const regex = compilePattern(subject, rawPattern, cwd);
		for (const group of groups) {
			if (group.values.some((value) => regex.test(subject === "bash" ? normalizeCommand(value) : normalizeSlashes(value)))) {
				return { kind, scope, subject, pattern: rawPattern, display: group.display };
			}
		}
	}
	return undefined;
}

export const splitAlwaysAllowShellChain = splitConservativeShellChain;

function findAlwaysAllowMatch(
	rules: GateSemanticRuleMap | undefined,
	subject: GateSemanticSubject,
	groups: Array<{ display: string; values: string[] }>,
	cwd: string,
	scope: "global" | "role",
	bashCommand?: string,
): GateSemanticMatch | undefined {
	if (subject !== "bash") return findRuleMatch(rules, subject, groups, cwd, scope, "alwaysAllow");
	const patterns = rules?.bash ?? [];
	if (patterns.length === 0) return undefined;
	const segments = splitAlwaysAllowShellChain(bashCommand ?? groups[0]?.values[0] ?? "");
	if (!segments) return undefined;
	let firstMatch: GateSemanticMatch | undefined;
	for (const segment of segments) {
		const normalized = normalizeCommand(segment);
		const matchedPattern = patterns.find((pattern) => compilePattern("bash", pattern, cwd).test(normalized));
		if (!matchedPattern) return undefined;
		firstMatch ??= { kind: "alwaysAllow", scope, subject, pattern: matchedPattern, display: normalized };
	}
	return firstMatch;
}

export function resolveAutoRole(config: GateSemanticConfig, roleType: GateSemanticRoleType, roleName: string): GateSemanticRoleContext {
	const normalizedName = roleName.trim().toLowerCase() || "base";
	const roleConfig = roleType === "subagent" ? config.subagents?.[normalizedName] : config.agents?.[normalizedName];
	return {
		roleType,
		roleName: normalizedName,
		roleConfig,
		guidance: roleConfig?.guidance ?? "Use conservative picode gate auto defaults. Allow only clearly requested low-risk project-local actions; prompt or block risky, broad, external, unclear, credential, network, publishing, or privilege-related actions.",
	};
}

export function evaluateGateSemantic(input: GateSemanticEvaluationInput): GateSemanticEvaluation {
	const role = resolveAutoRole(input.config, input.roleType, input.roleName);
	if (input.subject === "bash") {
		const pipeToShell = findPipeToShell(input.bashCommand ?? input.groups[0]?.values[0]);
		if (pipeToShell) return { action: "block", match: pipeToShell, role };
	}
	const globalHardDeny = findRuleMatch(input.config.hardDeny, input.subject, input.groups, input.cwd, "global", "hardDeny");
	if (globalHardDeny) return { action: "block", match: globalHardDeny, role };
	const roleHardDeny = findRuleMatch(role.roleConfig?.hardDeny, input.subject, input.groups, input.cwd, "role", "hardDeny");
	if (roleHardDeny) return { action: "block", match: roleHardDeny, role };
	const roleAllow = findAlwaysAllowMatch(role.roleConfig?.alwaysAllow, input.subject, input.groups, input.cwd, "role", input.bashCommand);
	if (roleAllow) return { action: "allow", match: roleAllow, role };
	const globalAllow = findAlwaysAllowMatch(input.config.alwaysAllow, input.subject, input.groups, input.cwd, "global", input.bashCommand);
	if (globalAllow) return { action: "allow", match: globalAllow, role };
	return { action: "semantic", role };
}

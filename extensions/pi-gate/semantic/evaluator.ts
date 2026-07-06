import {
	expandPatternValue,
	isPathSubject,
	normalizeCommand,
	normalizeSlashes,
	wildcardToRegex,
} from "../matching.ts";

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

export function splitAlwaysAllowShellChain(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote === "single") {
			current += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			current += ch;
			if (ch === "\"") quote = undefined;
			else if (ch === "\\") current += command[++i] ?? "";
			else if (ch === "`" || (ch === "$" && next === "(")) return undefined;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			current += ch;
		} else if (ch === "\"") {
			quote = "double";
			current += ch;
		} else if (ch === "\\") {
			current += ch + (command[++i] ?? "");
		} else if (ch === "&") {
			if (next !== "&") return undefined;
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
			i++;
		} else if (ch === "|" && next === "|") {
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
			i++;
		} else if (ch === "|" || ch === "<" || ch === ">" || ch === "`" || (ch === "$" && next === "(")) {
			return undefined;
		} else if (ch === ";" || ch === "\n") {
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
		} else {
			current += ch;
		}
	}
	if (quote) return undefined;
	const finalSegment = current.trim();
	if (finalSegment) segments.push(finalSegment);
	return segments.length > 0 ? segments : undefined;
}

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

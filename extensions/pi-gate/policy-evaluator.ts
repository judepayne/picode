import {
	buildAbsolutePathGroups,
	buildExternalDirectoryGroups,
	normalizeAbsPath,
	normalizeCommand,
	type CandidateGroup,
} from "./matching.ts";
import { extractMutationTargets } from "./shell-mutation.ts";
import type { CompiledPolicy, Decision, EffectiveGatePolicy, MutationAnalysis, PermissionAction } from "./policy-types.ts";

const ACTION_PRIORITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

function resolveGlobalAction(policy: CompiledPolicy): PermissionAction {
	return policy.globalActions[policy.globalActions.length - 1] ?? "allow";
}

export function pickMoreRestrictive(left: PermissionAction, right: PermissionAction): PermissionAction {
	return ACTION_PRIORITY[right] > ACTION_PRIORITY[left] ? right : left;
}

function evaluateSubject(policy: CompiledPolicy, subject: string, groups: CandidateGroup[]): Decision {
	const rules = policy.subjects[subject] ?? [];
	let finalAction: PermissionAction = "allow";
	const reasons: string[] = [];

	for (const group of groups) {
		let action = resolveGlobalAction(policy);
		let matchedPattern: string | undefined;
		for (const rule of rules) {
			if (group.values.some((value) => rule.regex.test(value))) {
				action = rule.action;
				matchedPattern = rule.rawPattern;
			}
		}
		if (action !== "allow") {
			reasons.push(
				matchedPattern
					? `${subject} ${action}: ${group.display} (matched ${JSON.stringify(matchedPattern)})`
					: `${subject} ${action}: ${group.display}`,
			);
		}
		finalAction = pickMoreRestrictive(finalAction, action);
	}

	return { action: finalAction, reasons };
}

function annotateDecisionReasons(policy: CompiledPolicy, decision: Decision): string[] {
	return decision.reasons.map((reason) => `[${policy.profileName}] ${reason}`);
}

export function evaluateSubjectAcrossLineage(effective: EffectiveGatePolicy, subject: string, groups: CandidateGroup[]): Decision {
	let finalAction: PermissionAction = "allow";
	const reasons: string[] = [];
	for (const policy of effective.lineage) {
		const decision = evaluateSubject(policy, subject, groups);
		finalAction = pickMoreRestrictive(finalAction, decision.action);
		reasons.push(...annotateDecisionReasons(policy, decision));
	}
	return { action: finalAction, reasons };
}

function evaluateExternalDirectory(policy: CompiledPolicy, absPaths: string[], cwd: string): Decision {
	const groups = buildExternalDirectoryGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, "external_directory", groups);
}

export function evaluateExternalDirectoryAcrossLineage(effective: EffectiveGatePolicy, absPaths: string[], cwd: string): Decision {
	const groups = buildExternalDirectoryGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubjectAcrossLineage(effective, "external_directory", groups);
}

function evaluateAbsolutePaths(policy: CompiledPolicy, subject: string, absPaths: string[], cwd: string): Decision {
	const groups = buildAbsolutePathGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, subject, groups);
}

export function evaluateAbsolutePathsAcrossLineage(effective: EffectiveGatePolicy, subject: string, absPaths: string[], cwd: string): Decision {
	const groups = buildAbsolutePathGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubjectAcrossLineage(effective, subject, groups);
}

export interface ProfileBashEvaluation {
	decision: Decision;
	commandDecision: Decision;
	pathDecision: Decision;
	externalDecision: Decision;
	complexityDecision: Decision;
	normalizedCommand: string;
	analysis: MutationAnalysis;
	pathCandidates: string[];
}

export function evaluateProfileBashCommand(effective: EffectiveGatePolicy, command: string, cwd: string): ProfileBashEvaluation {
	const normalizedCommand = normalizeCommand(command);
	const commandDecision = evaluateSubjectAcrossLineage(effective, "bash", [{ display: normalizedCommand || "<empty command>", values: [normalizedCommand] }]);
	const analysis = extractMutationTargets(command, cwd);
	const reasons = [...commandDecision.reasons];
	let pathDecision: Decision = { action: "allow", reasons: [] };
	let externalDecision: Decision = { action: "allow", reasons: [] };
	let pathCandidates: string[] = [];

	if (commandDecision.action !== "deny" && analysis.mutating) {
		pathCandidates = analysis.paths.length > 0 ? analysis.paths : analysis.inferredCwdTarget ? [normalizeAbsPath(cwd)] : [];
		if (pathCandidates.length === 0) {
			pathDecision = { action: "ask", reasons: [`bash ask: ${analysis.reason}`] };
		} else {
			externalDecision = evaluateExternalDirectoryAcrossLineage(effective, pathCandidates, cwd);
			pathDecision = evaluateAbsolutePathsAcrossLineage(effective, "edit", pathCandidates, cwd);
		}
	}

	reasons.push(...externalDecision.reasons, ...pathDecision.reasons);
	let finalAction = commandDecision.action;
	finalAction = pickMoreRestrictive(finalAction, externalDecision.action);
	finalAction = pickMoreRestrictive(finalAction, pathDecision.action);
	if (analysis.mutating && finalAction === "allow" && analysis.paths.length === 0 && !analysis.inferredCwdTarget) {
		finalAction = "ask";
		reasons.push(`bash ask: ${analysis.reason}`);
	}
	const complexityDecision: Decision = analysis.complex
		? { action: "ask", reasons: ["bash ask: complex shell command requires review"] }
		: { action: "allow", reasons: [] };
	if (complexityDecision.action === "ask" && finalAction === "allow") {
		finalAction = "ask";
		reasons.push(...complexityDecision.reasons);
	}

	return {
		decision: { action: finalAction, reasons },
		commandDecision,
		pathDecision,
		externalDecision,
		complexityDecision,
		normalizedCommand,
		analysis,
		pathCandidates,
	};
}


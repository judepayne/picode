import * as crypto from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { GateAutoApproverManager } from "../auto-approver/manager.ts";
import type { GateAutoApprovalRequest } from "../auto-approver/types.ts";
import { assessGateRisk } from "../risk.ts";
import { hasSensitivePathCandidate, hasSensitiveSearchTarget } from "../sensitive-paths.ts";
import type { GateSemanticEvaluation, GateSemanticMatch, GateSemanticRequest, GateSemanticResult, GateSemanticRoleType } from "./types.ts";
import type { EffectiveGatePolicy, MutationAnalysis, PermissionAction } from "../policy-types.ts";
import { updateStatus } from "../status-ui.ts";

const MAX_SESSION_ALLOWS = 100;
const AUTO_BLOCK_CONSECUTIVE_PROMPT_THRESHOLD = 3;
const AUTO_BLOCK_TOTAL_PROMPT_THRESHOLD = 20;

export interface AdditionalSessionApproval {
	key: string;
	label: string;
}

async function confirmDecision(
	ctx: ExtensionContext,
	title: string,
	message: string,
	sessionKey: string,
	sessionAllows: Set<string>,
	profileName: string,
	locked = false,
	autoEnabled = false,
	additionalSessionApproval?: AdditionalSessionApproval,
): Promise<{ allow: boolean; sessionStored: boolean }> {
	if (!ctx.hasUI) return { allow: false, sessionStored: false };
	const choices = autoEnabled
		? ["Allow once", "Deny"]
		: ["Allow once", "Allow for session", ...(additionalSessionApproval ? [additionalSessionApproval.label] : []), "Deny"];
	const choice = await ctx.ui.select(`${title}\n\n${message}`, choices);
	if (choice === "Allow once") return { allow: true, sessionStored: false };
	const storedKey = !autoEnabled && choice === "Allow for session"
		? sessionKey
		: !autoEnabled && additionalSessionApproval && choice === additionalSessionApproval.label
			? additionalSessionApproval.key
			: undefined;
	if (storedKey) {
		// Cap at MAX_SESSION_ALLOWS to prevent unbounded memory growth.
		if (sessionAllows.size >= MAX_SESSION_ALLOWS) sessionAllows.clear();
		sessionAllows.add(storedKey);
		updateStatus(ctx, profileName, sessionAllows, false, locked, autoEnabled);
		return { allow: true, sessionStored: true };
	}
	return { allow: false, sessionStored: false };
}

export function pickReason(reasons: string[], action: PermissionAction, fallback: string): string {
	return reasons.find((reason) => reason.includes(` ${action}:`)) ?? reasons[0] ?? fallback;
}

function hashSessionKey(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedJson(value: unknown, maxChars = 2000): unknown {
	try {
		const text = JSON.stringify(value);
		if (text.length <= maxChars) return value;
		return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
	} catch {
		return "<unserializable>";
	}
}

export interface GateAskDecisionInput {
	ctx: ExtensionContext;
	effective: EffectiveGatePolicy;
	event: { toolName: string; input: unknown };
	title: string;
	message: string;
	sessionKey: string;
	reasons: string[];
	fallbackDenyReason: string;
	subject: string;
	pathCandidates?: string[];
	bash?: {
		command: string;
		normalizedCommand: string;
		analysis: MutationAnalysis;
	};
	additionalSessionApproval?: AdditionalSessionApproval;
}

function buildAutoApprovalRequest(input: GateAskDecisionInput): GateAutoApprovalRequest {
	return {
		requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		profileName: input.effective.profileName,
		lineageNames: input.effective.lineageNames,
		cwd: input.ctx.cwd,
		unattended: input.effective.unattended,
		toolName: input.event.toolName,
		subject: input.subject,
		sessionKeyHash: hashSessionKey(input.sessionKey),
		reasons: input.reasons,
		inputSummary: boundedJson(input.event.input),
		pathCandidates: input.pathCandidates,
		bash: input.bash,
	};
}

function normalizeSemanticRoleName(value: string): string {
	return value.trim().toLowerCase() || "base";
}

export function getSemanticRole(effective: EffectiveGatePolicy): { roleType: GateSemanticRoleType; roleName: string } {
	const subagentName = process.env.PI_GATE_SUBAGENT_AGENT;
	if (subagentName?.trim()) return { roleType: "subagent", roleName: normalizeSemanticRoleName(subagentName) };
	return { roleType: "agent", roleName: normalizeSemanticRoleName(effective.profileName) };
}

function buildGateSemanticRequest(input: GateAskDecisionInput, evaluation: GateSemanticEvaluation, match?: { hardDeny?: GateSemanticMatch; alwaysAllow?: GateSemanticMatch }): GateSemanticRequest {
	return {
		...buildAutoApprovalRequest(input),
		roleType: evaluation.role.roleType,
		roleName: evaluation.role.roleName,
		guidance: evaluation.role.guidance,
		matchedHardDeny: match?.hardDeny,
		matchedAlwaysAllow: match?.alwaysAllow,
	};
}

export interface GateAutoBlockState {
	consecutive: number;
	total: number;
	paused: boolean;
}

export function resetAutoBlockState(state: GateAutoBlockState): void {
	state.consecutive = 0;
	state.total = 0;
	state.paused = false;
}

function formatSemanticFallbackReason(result: GateSemanticResult | undefined): string | undefined {
	if (!result) return undefined;
	if (result.outcome === "blocked") return `Gate auto blocked: ${result.reason}`;
	if (result.outcome === "fallback_prompt") return `Gate auto requests review: ${result.reason}`;
	if (["timeout", "malformed", "unavailable", "error"].includes(result.outcome)) return `Gate auto unavailable: ${result.reason}`;
	return undefined;
}

function isSemanticSoftBlock(result: GateSemanticResult): boolean {
	return result.outcome === "blocked";
}

export async function promptForAskDecision(
	input: GateAskDecisionInput,
	sessionAllows: Set<string>,
	profileLocked: boolean,
	autoEnabled: boolean,
	fallbackReason?: string,
): Promise<{ block?: boolean; reason?: string; allowed?: boolean }> {
	if (input.effective.unattended) {
		return {
			block: true,
			reason: `${fallbackReason ? `${fallbackReason}. ` : ""}${pickReason(input.reasons, "ask", input.fallbackDenyReason)}. Profile ${input.effective.profileName} is unattended and cannot prompt for approval.`,
		};
	}
	if (!input.ctx.hasUI) {
		return {
			block: true,
			reason: `${fallbackReason ? `${fallbackReason}. ` : ""}${pickReason(input.reasons, "ask", `${input.fallbackDenyReason} but no UI is available`)}`,
		};
	}
	const result = await confirmDecision(
		input.ctx,
		input.title,
		[fallbackReason, input.message].filter(Boolean).join("\n\n"),
		input.sessionKey,
		sessionAllows,
		input.effective.profileName,
		profileLocked,
		autoEnabled,
		input.additionalSessionApproval,
	);
	if (result.allow) return { allowed: true };
	return { block: true, reason: pickReason(input.reasons, "ask", input.fallbackDenyReason) };
}

export async function resolveAskDecision(
	input: GateAskDecisionInput,
	sessionAllows: Set<string>,
	profileLocked: boolean,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, false);
	if (prompted.allowed) return undefined;
	return prompted;
}

export async function resolveSemanticDecision(
	input: GateAskDecisionInput,
	evaluation: GateSemanticEvaluation,
	sessionAllows: Set<string>,
	profileLocked: boolean,
	autoManager: GateAutoApproverManager,
	autoBlockState: GateAutoBlockState,
	autoRuntimeEnabled: boolean,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (evaluation.action === "block") {
		return { block: true, reason: `Gate auto hard-denied ${input.event.toolName}: ${evaluation.match.display} matched ${JSON.stringify(evaluation.match.pattern)}` };
	}
	if (evaluation.action === "allow") {
		const risk = assessGateRisk(buildAutoApprovalRequest(input));
		if (risk.recommendedDecision === "deny") {
			return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${risk.reason ?? "risk guard denied deterministic allow"}` };
		}
		if (risk.recommendedDecision === "escalate") {
			const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, `Gate auto deterministic allow requires review: ${risk.reason ?? "risk guard requested review"}`);
			if (prompted.allowed) return undefined;
			return prompted;
		}
		autoBlockState.consecutive = 0;
		return undefined;
	}

	const semanticRisk = assessGateRisk(buildAutoApprovalRequest(input));
	const readOnlySearchTool = input.event.toolName === "grep" || input.event.toolName === "find";
	const searchOnlySensitiveTerm = readOnlySearchTool && semanticRisk.flags.includes("credential_or_secret") && !hasSensitivePathCandidate(input.pathCandidates) && !hasSensitiveSearchTarget(input.event.input);
	if ((!searchOnlySensitiveTerm && semanticRisk.flags.includes("credential_or_secret")) || semanticRisk.flags.includes("broad_destructive")) {
		return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${semanticRisk.reason ?? "deterministic safety floor denied semantic review"}` };
	}

	let autoFallback: GateSemanticResult | undefined;
	if (autoRuntimeEnabled) await autoManager.refresh(input.ctx);
	if (autoRuntimeEnabled && autoManager.isEnabled()) {
		if (autoBlockState.paused) {
			const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, "Gate auto is paused after repeated blocks; approving resumes auto mode");
			if (prompted.allowed) {
				resetAutoBlockState(autoBlockState);
				return undefined;
			}
			return prompted;
		}
		const autoResult = await autoManager.decide(input.ctx, buildGateSemanticRequest(input, evaluation));
		if (autoResult.decision === "allow" && autoResult.outcome === "allowed") {
			autoBlockState.consecutive = 0;
			return undefined;
		}
		if (isSemanticSoftBlock(autoResult)) {
			autoBlockState.consecutive += 1;
			autoBlockState.total += 1;
			const fallbackReason = formatSemanticFallbackReason(autoResult);
			if (autoBlockState.consecutive >= AUTO_BLOCK_CONSECUTIVE_PROMPT_THRESHOLD || autoBlockState.total >= AUTO_BLOCK_TOTAL_PROMPT_THRESHOLD) {
				autoBlockState.paused = true;
				const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, `${fallbackReason}. Gate auto paused after ${autoBlockState.consecutive} consecutive / ${autoBlockState.total} total blocks; approving resumes auto mode`);
				if (prompted.allowed) {
					resetAutoBlockState(autoBlockState);
					return undefined;
				}
				return prompted;
			}
			return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${autoResult.reason}` };
		}
		autoFallback = autoResult;
	}

	const fallbackReason = formatSemanticFallbackReason(autoFallback);
	const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, autoRuntimeEnabled && autoManager.isEnabled(), fallbackReason);
	if (prompted.allowed) return undefined;
	return prompted;
}


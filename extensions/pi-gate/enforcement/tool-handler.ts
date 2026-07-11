import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGateAutoConfig } from "../auto-approver/config.ts";
import { GateAutoApproverManager } from "../auto-approver/manager.ts";
import { evaluateGateSemantic } from "../semantic/evaluator.ts";
import { loadGateSemanticConfig } from "../semantic/loader.ts";
import { isGateSemanticSubject } from "../semantic/types.ts";
import type { GateSemanticSubject } from "../semantic/types.ts";
import { buildAbsolutePathGroups, buildExternalDirectoryGroups, isPathSubject, normalizeAbsPath, normalizeCommand } from "../matching.ts";
import { evaluateAbsolutePathsAcrossLineage, evaluateExternalDirectoryAcrossLineage, evaluateProfileBashCommand, evaluateSubjectAcrossLineage, pickMoreRestrictive, type ProfileBashEvaluation } from "../policy-evaluator.ts";
import { extractMutationTargets } from "../shell-mutation.ts";
import { analyzePolicyBashComposite, buildBashSessionKey, buildPathSessionKey, getChainUnsafeShellSegmentReason } from "../policy-shell.ts";
import { SEMANTIC_GENERIC_TOOL_NAMES, getGenericToolSubjectGroups, getToolPathCandidates, getToolPermissionSubject, getToolSubjectGroups } from "../tool-classification.ts";
import { getSemanticRole, pickReason, promptForAskDecision, resolveAskDecision, resolveSemanticDecision, type GateAutoBlockState } from "../semantic/decision-flow.ts";
import { buildRuntimeFamilyApprovalKey, classifyRuntimeCommand, runtimeCandidateOwnsComplexity, type RuntimeTrustCandidate } from "../runtime-trust.ts";
import type { EffectiveGatePolicy } from "../policy-types.ts";

function canRuntimeTrustResolveAsk(evaluation: ProfileBashEvaluation, candidate: RuntimeTrustCandidate): boolean {
	if (evaluation.decision.action !== "ask") return false;
	if (evaluation.commandDecision.action === "deny" || evaluation.pathDecision.action === "deny" || evaluation.externalDecision.action === "deny") return false;
	if (evaluation.pathDecision.action !== "allow" || evaluation.externalDecision.action !== "allow") return false;
	if (evaluation.complexityDecision.action === "ask" && !runtimeCandidateOwnsComplexity(candidate)) return false;
	return evaluation.commandDecision.action === "allow" || evaluation.commandDecision.action === "ask";
}

export interface GateToolHandlerOptions {
 extensionDir: string;
 sessionAllows: Set<string>;
 profileLocked: boolean;
 autoManager: GateAutoApproverManager;
 autoBlockState: GateAutoBlockState;
 isCurrent(): boolean;
 ready: Promise<unknown>;
 autoRuntimeEnabled(): boolean;
 getEffectivePolicy(cwd: string): { compiled?: EffectiveGatePolicy; error?: string };
 scopeSessionKey(effective: EffectiveGatePolicy, sessionKey: string): string;
}

export function createGateToolHandler(options: GateToolHandlerOptions) {
 const { extensionDir, sessionAllows, profileLocked, autoManager, autoBlockState, getEffectivePolicy, scopeSessionKey, isCurrent } = options;
 const handleCurrent = async (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => {
 const autoRuntimeEnabled = options.autoRuntimeEnabled();

		const resolved = getEffectivePolicy(ctx.cwd);
		if (!resolved.compiled) {
			return {
				block: true,
				reason: resolved.error ?? "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed.",
			};
		}
		const compiled = resolved.compiled;
		const autoConfig = loadGateAutoConfig(ctx.cwd);
		const autoActive = autoRuntimeEnabled && autoConfig.enabled;
		if (autoActive) {
			const rawInput = event.input as Record<string, unknown>;
			const role = getSemanticRole(compiled);
			const loadedSemantic = loadGateSemanticConfig(extensionDir, ctx.cwd);
			if (!loadedSemantic.config) {
				return { block: true, reason: loadedSemantic.error ?? "Gate auto config unavailable. Tool calls are blocked until auto config is fixed." };
			}

			if (event.toolName === "bash") {
				const command = String(rawInput.command ?? "");
				const sessionKey = scopeSessionKey(compiled, buildBashSessionKey(command));
				const normalizedCommand = normalizeCommand(command);
				const analysis = extractMutationTargets(command, ctx.cwd);
				const commandDecision = evaluateSubjectAcrossLineage(compiled, "bash", [{ display: normalizedCommand || "<empty command>", values: [normalizedCommand] }]);
				if (commandDecision.action === "deny") {
					return { block: true, reason: pickReason(commandDecision.reasons, "deny", "Gate denied bash command") };
				}
				const mutationCandidates = analysis.paths.length > 0 ? analysis.paths : analysis.inferredCwdTarget ? [normalizeAbsPath(ctx.cwd)] : [];
				if (analysis.mutating) {
					const externalDecision = evaluateExternalDirectoryAcrossLineage(compiled, mutationCandidates, ctx.cwd);
					const pathDecision = evaluateAbsolutePathsAcrossLineage(compiled, "edit", mutationCandidates, ctx.cwd);
					const finalAction = pickMoreRestrictive(commandDecision.action, pickMoreRestrictive(externalDecision.action, pathDecision.action));
					if (finalAction === "deny") {
						return { block: true, reason: pickReason([...commandDecision.reasons, ...externalDecision.reasons, ...pathDecision.reasons], "deny", "Gate denied bash command") };
					}
				}
				if (analysis.mutating && mutationCandidates.length > 0) {
					const editEvaluation = evaluateGateSemantic({
						config: loadedSemantic.config,
						cwd: ctx.cwd,
						subject: "edit",
						groups: buildAbsolutePathGroups(mutationCandidates, ctx.cwd),
						roleType: role.roleType,
						roleName: role.roleName,
					});
					if (editEvaluation.action === "block") {
						const reasons = [`auto block: bash mutation target ${editEvaluation.match.display} matched edit hardDeny ${JSON.stringify(editEvaluation.match.pattern)}`];
						return await resolveSemanticDecision(
							{
								ctx,
								effective: compiled,
								event,
								title: "Gate auto: confirm bash command",
								message: [normalizedCommand || command, "", ...reasons, `Role: ${editEvaluation.role.roleType}:${editEvaluation.role.roleName}`].join("\n"),
								sessionKey,
								reasons,
								fallbackDenyReason: "Gate auto denied bash command",
								subject: "bash",
								pathCandidates: mutationCandidates,
								bash: { command, normalizedCommand, analysis },
							},
							editEvaluation,
							sessionAllows,
							profileLocked,
							autoManager,
							autoBlockState,
							autoRuntimeEnabled,
						);
					}
					const externalEvaluation = evaluateGateSemantic({
						config: loadedSemantic.config,
						cwd: ctx.cwd,
						subject: "external_directory",
						groups: buildExternalDirectoryGroups(mutationCandidates, ctx.cwd),
						roleType: role.roleType,
						roleName: role.roleName,
					});
					if (externalEvaluation.action === "block") {
						const reasons = [`auto block: bash external mutation target ${externalEvaluation.match.display} matched ${JSON.stringify(externalEvaluation.match.pattern)}`];
						return await resolveSemanticDecision(
							{
								ctx,
								effective: compiled,
								event,
								title: "Gate auto: confirm bash command",
								message: [normalizedCommand || command, "", ...reasons, `Role: ${externalEvaluation.role.roleType}:${externalEvaluation.role.roleName}`].join("\n"),
								sessionKey,
								reasons,
								fallbackDenyReason: "Gate auto denied bash command",
								subject: "bash",
								pathCandidates: mutationCandidates,
								bash: { command, normalizedCommand, analysis },
							},
							externalEvaluation,
							sessionAllows,
							profileLocked,
							autoManager,
							autoBlockState,
							autoRuntimeEnabled,
						);
					}
				}
				const evaluation = evaluateGateSemantic({
					config: loadedSemantic.config,
					cwd: ctx.cwd,
					subject: "bash",
					groups: [{ display: normalizedCommand || "<empty command>", values: [normalizedCommand] }],
					roleType: role.roleType,
					roleName: role.roleName,
					bashCommand: command,
				});
				const reasons = evaluation.action === "semantic"
					? [`auto: ${evaluation.role.roleType}:${evaluation.role.roleName} semantic review required`]
					: [`auto ${evaluation.action}: ${evaluation.match.display} matched ${JSON.stringify(evaluation.match.pattern)}`];
				return await resolveSemanticDecision(
					{
						ctx,
						effective: compiled,
						event,
						title: "Gate auto: confirm bash command",
						message: [normalizedCommand || command, "", ...reasons, `Role: ${evaluation.role.roleType}:${evaluation.role.roleName}`].join("\n"),
						sessionKey,
						reasons,
						fallbackDenyReason: "Gate auto denied bash command",
						subject: "bash",
						pathCandidates: mutationCandidates,
						bash: { command, normalizedCommand, analysis },
					},
					evaluation,
					sessionAllows,
					profileLocked,
					autoManager,
					autoBlockState,
					autoRuntimeEnabled,
				);
			}

			const rawSubject = getToolPermissionSubject(event.toolName);
			const subjectGroups = getToolSubjectGroups(event.toolName, rawInput, ctx);
			const pathCandidates = getToolPathCandidates(event.toolName, rawInput, ctx);
			const policySubjectDecision = evaluateSubjectAcrossLineage(compiled, rawSubject, subjectGroups.length > 0 ? subjectGroups : [{ display: "unknown input", values: [""] }]);
			const policyExternalDecision = evaluateExternalDirectoryAcrossLineage(compiled, pathCandidates, ctx.cwd);
			const policyFinalAction = pickMoreRestrictive(policySubjectDecision.action, policyExternalDecision.action);
			if (policyFinalAction === "deny") {
				return { block: true, reason: pickReason([...policyExternalDecision.reasons, ...policySubjectDecision.reasons], "deny", `Gate denied ${event.toolName}`) };
			}
			if (!isGateSemanticSubject(rawSubject) && !SEMANTIC_GENERIC_TOOL_NAMES.has(event.toolName)) {
				const reasons = [`auto prompt: unsupported tool subject ${JSON.stringify(rawSubject)} requires human review`];
				const prompted = await promptForAskDecision(
					{
						ctx,
						effective: compiled,
						event,
						title: `Gate auto: confirm ${event.toolName}`,
						message: [...reasons, `Role: ${role.roleType}:${role.roleName}`].join("\n"),
						sessionKey: scopeSessionKey(compiled, `${rawSubject}:unknown`),
						reasons,
						fallbackDenyReason: `Gate auto denied ${event.toolName}`,
						subject: rawSubject,
						pathCandidates,
					},
					sessionAllows,
					profileLocked,
					true,
					"Gate auto cannot classify this tool deterministically",
				);
				if (prompted.allowed) return undefined;
				return prompted;
			}
			const subject: GateSemanticSubject = isGateSemanticSubject(rawSubject) ? rawSubject : "tool";
			const effectiveSubjectGroups = subject === "tool" ? getGenericToolSubjectGroups(event.toolName, rawInput) : subjectGroups;
			if (pathCandidates.length > 0) {
				const externalEvaluation = evaluateGateSemantic({
					config: loadedSemantic.config,
					cwd: ctx.cwd,
					subject: "external_directory",
					groups: buildExternalDirectoryGroups(pathCandidates, ctx.cwd),
					roleType: role.roleType,
					roleName: role.roleName,
				});
				if (externalEvaluation.action === "block") {
					const reasons = [`auto block: external path ${externalEvaluation.match.display} matched ${JSON.stringify(externalEvaluation.match.pattern)}`];
					return await resolveSemanticDecision(
						{
							ctx,
							effective: compiled,
							event,
							title: `Gate auto: confirm ${event.toolName}`,
							message: [...reasons, `Role: ${externalEvaluation.role.roleType}:${externalEvaluation.role.roleName}`].join("\n"),
							sessionKey: scopeSessionKey(compiled, buildPathSessionKey(subject, pathCandidates)),
							reasons,
							fallbackDenyReason: `Gate auto denied ${event.toolName}`,
							subject,
							pathCandidates,
						},
						externalEvaluation,
						sessionAllows,
						profileLocked,
						autoManager,
						autoBlockState,
						autoRuntimeEnabled,
					);
				}
			}
			const groups = effectiveSubjectGroups.length > 0 ? effectiveSubjectGroups : [{ display: "unknown input", values: [""] }];
			const sessionKey = scopeSessionKey(
				compiled,
				effectiveSubjectGroups.length > 0
					? buildPathSessionKey(subject, effectiveSubjectGroups.map((group) => group.display))
					: `${subject}:unknown`,
			);
			const evaluation = evaluateGateSemantic({
				config: loadedSemantic.config,
				cwd: ctx.cwd,
				subject,
				groups,
				roleType: role.roleType,
				roleName: role.roleName,
			});
			const reasons = evaluation.action === "semantic"
				? [`auto: ${evaluation.role.roleType}:${evaluation.role.roleName} semantic review required`]
				: [`auto ${evaluation.action}: ${evaluation.match.display} matched ${JSON.stringify(evaluation.match.pattern)}`];
			return await resolveSemanticDecision(
				{
					ctx,
					effective: compiled,
					event,
					title: `Gate auto: confirm ${event.toolName}`,
					message: [...reasons, `Role: ${evaluation.role.roleType}:${evaluation.role.roleName}`].join("\n"),
					sessionKey,
					reasons,
					fallbackDenyReason: `Gate auto denied ${event.toolName}`,
					subject,
					pathCandidates,
				},
				evaluation,
				sessionAllows,
				profileLocked,
				autoManager,
				autoBlockState,
				autoRuntimeEnabled,
			);
		}

		if (event.toolName === "bash") {
			const command = String((event.input as Record<string, unknown>).command ?? "");
			const sessionKey = scopeSessionKey(compiled, buildBashSessionKey(command));
			if (sessionAllows.has(sessionKey)) return undefined;

			const runtimeCandidate = classifyRuntimeCommand(command, ctx.cwd);
			const scopedRuntimeKey = (candidate: RuntimeTrustCandidate): string =>
				scopeSessionKey(compiled, buildRuntimeFamilyApprovalKey(candidate.family, ctx.cwd));
			const composite = runtimeCandidate?.syntax === "heredoc" ? undefined : analyzePolicyBashComposite(command);
			if (composite?.error) return { block: true, reason: `Gate blocked bash command chain: ${composite.error}` };
			if (composite?.segments) {
				for (const segment of composite.segments) {
					const chainUnsafeReason = getChainUnsafeShellSegmentReason(segment);
					if (chainUnsafeReason) {
						return { block: true, reason: `Gate blocked bash command chain at ${JSON.stringify(segment)}: ${chainUnsafeReason}` };
					}
					const segmentEvaluation = evaluateProfileBashCommand(compiled, segment, ctx.cwd);
					if (segmentEvaluation.decision.action === "allow") continue;
					const segmentCandidate = classifyRuntimeCommand(segment, ctx.cwd);
					if (
						segmentCandidate
						&& canRuntimeTrustResolveAsk(segmentEvaluation, segmentCandidate)
						&& sessionAllows.has(scopedRuntimeKey(segmentCandidate))
					) continue;
					const reason = segmentEvaluation.decision.action === "deny"
						? pickReason(segmentEvaluation.decision.reasons, "deny", "Gate denied bash command chain")
						: pickReason(segmentEvaluation.decision.reasons, "ask", "Gate blocked bash command chain: a component requires review");
					return { block: true, reason: `Gate blocked bash command chain at ${JSON.stringify(segment)}: ${reason}` };
				}
				return undefined;
			}

			const evaluation = evaluateProfileBashCommand(compiled, runtimeCandidate?.policyCommand ?? command, ctx.cwd);
			const normalizedCommand = normalizeCommand(command);
			const { analysis } = evaluation;
			const reasons = evaluation.decision.reasons;

			if (evaluation.decision.action === "allow") return undefined;
			if (evaluation.decision.action === "deny") {
				return { block: true, reason: pickReason(reasons, "deny", "Gate denied bash command") };
			}

			const runtimeApproval = runtimeCandidate && canRuntimeTrustResolveAsk(evaluation, runtimeCandidate)
				? {
					key: scopedRuntimeKey(runtimeCandidate),
					label: `Allow all ${runtimeCandidate.displayName} executions for session`,
				}
				: undefined;
			if (runtimeApproval && sessionAllows.has(runtimeApproval.key)) return undefined;

			return await resolveAskDecision(
				{
					ctx,
					effective: compiled,
					event,
					title: "Gate: confirm bash command",
					message: [
						normalizedCommand || command,
						"",
						...reasons,
						`Profile: ${compiled.profileName}`,
					].join("\n"),
					sessionKey,
					reasons,
					fallbackDenyReason: "Gate denied bash command",
					subject: "bash",
					pathCandidates: evaluation.pathCandidates,
					bash: { command, normalizedCommand, analysis },
					additionalSessionApproval: runtimeApproval,
				},
				sessionAllows,
				profileLocked,
			);
		}

		const input = event.input as Record<string, unknown>;
		const subject = getToolPermissionSubject(event.toolName);
		const subjectGroups = getToolSubjectGroups(event.toolName, input, ctx);
		const pathCandidates = getToolPathCandidates(event.toolName, input, ctx);
		const sessionKey = scopeSessionKey(
			compiled,
			subjectGroups.length > 0
				? buildPathSessionKey(subject, subjectGroups.map((group) => group.display))
				: `${subject}:unknown`,
		);
		if (sessionAllows.has(sessionKey)) return undefined;

		let subjectDecision = evaluateSubjectAcrossLineage(compiled, subject, subjectGroups.length > 0 ? subjectGroups : [{ display: "unknown input", values: [""] }]);
		let externalDecision = evaluateExternalDirectoryAcrossLineage(compiled, pathCandidates, ctx.cwd);
		let finalAction = pickMoreRestrictive(subjectDecision.action, externalDecision.action);
		const reasons = [...externalDecision.reasons, ...subjectDecision.reasons];

		if (subjectGroups.length === 0 && isPathSubject(subject)) {
			finalAction = pickMoreRestrictive(finalAction, "ask");
			reasons.unshift(`${subject} ask: no usable path available`);
		}

		if (finalAction === "allow") return undefined;
		if (finalAction === "deny") {
			return { block: true, reason: pickReason(reasons, "deny", `Gate denied ${event.toolName}`) };
		}
		return await resolveAskDecision(
			{
				ctx,
				effective: compiled,
				event,
				title: `Gate: confirm ${event.toolName}`,
				message: [...reasons, `Profile: ${compiled.profileName}`].join("\n"),
				sessionKey,
				reasons,
				fallbackDenyReason: `Gate denied ${event.toolName}`,
				subject,
				pathCandidates,
			},
			sessionAllows,
			profileLocked,
		);
 };
 return async (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => {
	await options.ready;
	if (!isCurrent()) return undefined;
	const decision = await handleCurrent(event, ctx);
	if (!isCurrent()) {
		return { block: true, reason: "Gate runtime changed while approval was pending; retry the tool call under the active policy." };
	}
	return decision;
 };
}

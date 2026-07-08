import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { loadGateAutoConfig } from "./config.ts";
import { requestPiModelDecision } from "./backend-pi-model.ts";
import { GateAutoRuntime, type GateAutoRuntimeHooks } from "./runtime.ts";
import type { GateAutoApproverConfig, GateAutoBackendMode, GateAutoRuntimeStatus } from "./types.ts";
import { appendGateAutoDecisionAuditRecord, getGateAutoDecisionAuditPath } from "../semantic/audit-log.ts";
import { requestGateSemanticDecision } from "../semantic/client.ts";
import { buildGateSemanticDynamicPayload, buildGateSemanticStableContext } from "../semantic/context.ts";
import type { GateSemanticAuditRecord, GateSemanticRequest, GateSemanticResult } from "../semantic/types.ts";
import { assessGateRisk, type GateRiskAssessment } from "../risk.ts";

interface PiLike {
	events: { emit(event: string, data: unknown): void };
}

export class GateAutoApproverManager {
	private readonly pi: PiLike;
	private readonly runtime = new GateAutoRuntime();
	private stable?: { text: string; hash: string };

	constructor(pi: PiLike) {
		this.pi = pi;
	}

	isEnabled(): boolean {
		return this.runtime.isEnabled();
	}

	async refresh(ctx: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		return this.withAuditPath(ctx, await this.runtime.refresh(ctx, this.runtimeHooks()));
	}

	async enable(ctx: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		return this.withAuditPath(ctx, await this.runtime.enable(ctx, this.runtimeHooks()));
	}

	async disable(ctx?: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		return this.withAuditPath(ctx, await this.runtime.disable(ctx));
	}

	async shutdown(): Promise<void> {
		await this.runtime.shutdown();
	}

	status(ctx?: ExtensionContext): GateAutoRuntimeStatus {
		return this.withAuditPath(ctx, this.runtime.status(ctx));
	}

	async decide(ctx: ExtensionContext, request: GateSemanticRequest): Promise<GateSemanticResult> {
		const started = Date.now();
		const risk = assessGateRisk(request);
		const status = await this.runtime.refresh(ctx, this.runtimeHooks());
		const config = loadGateAutoConfig(ctx.cwd);
		const ready = config.backend.type === "pi-model" ? status.mode === "pi-model" : Boolean(status.endpoint);
		if (!config.enabled || !ready || status.mode === "disabled" || status.mode === "unconfigured" || status.mode === "failed") {
			const result: GateSemanticResult = {
				decision: "prompt",
				reason: status.lastError ?? "Gate auto is unavailable",
				outcome: "unavailable",
				latencyMs: Date.now() - started,
				requestId: request.requestId,
				backendMode: status.mode,
				riskFlags: risk.flags,
				riskRecommendedDecision: risk.recommendedDecision,
			};
			this.audit(ctx.cwd, request, result, status.mode, undefined, undefined, risk);
			return result;
		}

		const stable = buildGateSemanticStableContext(request, config);
		this.stable = stable;
		const dynamic = buildGateSemanticDynamicPayload(ctx, request, config);
		const result = config.backend.type === "pi-model"
			? await requestPiModelDecision(ctx, {
				stablePrefix: stable.text,
				dynamicPayload: dynamic.text,
				stableContextHash: stable.hash,
				dynamicPayloadHash: dynamic.hash,
				requestId: request.requestId,
				config,
			})
			: await requestGateSemanticDecision({
				endpoint: status.endpoint!,
				stablePrefix: stable.text,
				dynamicPayload: dynamic.text,
				stableContextHash: stable.hash,
				dynamicPayloadHash: dynamic.hash,
				requestId: request.requestId,
				config,
			});
		const annotatedResult: GateSemanticResult = {
			...result,
			backendMode: status.mode,
			modelDecision: result.decision,
			modelOutcome: result.outcome,
			modelReason: result.reason,
			guardOverride: false,
			riskFlags: risk.flags,
			riskRecommendedDecision: risk.recommendedDecision,
			dynamicPayloadText: config.auditIncludeDynamicPayloadText ? dynamic.text : undefined,
		};
		this.audit(ctx.cwd, request, annotatedResult, status.mode, undefined, result, risk);
		return annotatedResult;
	}

	private runtimeHooks(): GateAutoRuntimeHooks {
		return {
			stableContext: (_ctx, config) => this.getWarmupStableContext(config),
			auditRuntimeEvent: (ctx, mode, event, detail) => {
				if (event === "runtime_started") this.audit(ctx.cwd, undefined, undefined, mode, event);
				else this.audit(ctx.cwd, undefined, { decision: "prompt", reason: "Gate auto warmup failed", outcome: "unavailable", latencyMs: detail?.latencyMs ?? 0, requestId: "warmup", error: detail?.error }, mode, event);
			},
		};
	}

	private withAuditPath(ctx: ExtensionContext | undefined, status: GateAutoRuntimeStatus): GateAutoRuntimeStatus {
		return { ...status, auditPath: getGateAutoDecisionAuditPath(ctx?.cwd ?? process.cwd()) };
	}

	private getWarmupStableContext(config: GateAutoApproverConfig): { text: string; hash: string } {
		const request: GateSemanticRequest = {
			requestId: "warmup",
			profileName: "builder",
			lineageNames: ["builder"],
			unattended: false,
			toolName: "bash",
			subject: "bash:warmup",
			sessionKeyHash: "warmup",
			reasons: ["runtime warmup"],
			roleType: "agent",
			roleName: "builder",
			guidance: "Warmup request only. Return prompt unless the action is clearly harmless.",
		};
		this.stable = buildGateSemanticStableContext(request, config);
		return this.stable;
	}

	private audit(cwd: string, request: GateSemanticRequest | undefined, result: GateSemanticResult | undefined, mode: GateAutoBackendMode, event?: string, modelResult?: GateSemanticResult, risk?: GateRiskAssessment): void {
		const config = loadGateAutoConfig(cwd);
		const status = this.runtime.status({ cwd } as ExtensionContext);
		const record: GateSemanticAuditRecord = {
			schemaVersion: 1,
			timestamp: new Date().toISOString(),
			pid: process.pid,
			processKind: config.processKind,
			backendMode: mode,
			requestId: request?.requestId,
			profileName: request?.profileName,
			lineageNames: request?.lineageNames,
			unattended: request?.unattended,
			toolName: request?.toolName,
			subject: request?.subject,
			pathCandidates: request?.pathCandidates,
			reasons: request?.reasons,
			roleType: request?.roleType,
			roleName: request?.roleName,
			decision: result?.decision,
			reason: result?.reason,
			outcome: result?.outcome,
			latencyMs: result?.latencyMs,
			backendType: config.backend.type,
			endpoint: status.endpoint,
			modelPath: config.llama.modelPath,
			provider: config.backend.type === "pi-model" ? config.backend.provider : undefined,
			model: config.backend.type === "pi-model" ? config.backend.model : undefined,
			cacheRetention: config.backend.type === "pi-model" ? config.backend.cacheRetention : undefined,
			stableContextHash: result?.stableContextHash ?? this.stable?.hash,
			dynamicPayloadHash: result?.dynamicPayloadHash,
			dynamicPayloadText: config.auditIncludeDynamicPayloadText ? result?.dynamicPayloadText : undefined,
			error: result?.error,
			event,
			matchedHardDeny: request?.matchedHardDeny,
			matchedAlwaysAllow: request?.matchedAlwaysAllow,
			modelDecision: modelResult?.decision,
			modelOutcome: modelResult?.outcome,
			modelReason: modelResult?.reason,
			guardOverride: Boolean(modelResult && result && (modelResult.decision !== result.decision || modelResult.outcome !== result.outcome)),
			riskFlags: risk?.flags,
			riskRecommendedDecision: risk?.recommendedDecision,
		};
		appendGateAutoDecisionAuditRecord(cwd, record, config.auditEnabled);
	}
}

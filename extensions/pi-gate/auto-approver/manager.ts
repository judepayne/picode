import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { appendGateAutoAuditRecord, getGateAutoAuditPath } from "./audit-log.ts";
import { requestGateAutoDecision, warmGateAutoApprover } from "./client.ts";
import {
	GATE_AUTO_BACKEND_ENV,
	GATE_AUTO_CONTEXT_HASH_ENV,
	GATE_AUTO_ENDPOINT_ENV,
	GATE_AUTO_OWNER_PID_ENV,
	loadGateAutoConfig,
} from "./config.ts";
import { buildGateAutoDynamicPayload, buildGateAutoStableContext } from "./context.ts";
import { ManagedLlamaServer } from "./llama-server.ts";
import { assessGateAutoRisk, type GateAutoRiskAssessment } from "./risk.ts";
import type { GateAutoApprovalRequest, GateAutoApprovalResult, GateAutoApproverConfig, GateAutoAuditRecord, GateAutoBackendMode, GateAutoRuntimeStatus } from "./types.ts";

interface PiLike {
	events: { emit(event: string, data: unknown): void };
}

const ENV_KEYS = [GATE_AUTO_ENDPOINT_ENV, GATE_AUTO_OWNER_PID_ENV, GATE_AUTO_BACKEND_ENV, GATE_AUTO_CONTEXT_HASH_ENV];

function applyRiskGuidance(result: GateAutoApprovalResult, risk: GateAutoRiskAssessment): GateAutoApprovalResult {
	if (risk.recommendedDecision !== "deny" && risk.recommendedDecision !== "escalate") return result;
	if (result.decision === "allow") {
		return { ...result, decision: risk.recommendedDecision, outcome: risk.recommendedDecision === "deny" ? "blocked" : "escalated", reason: risk.reason ?? result.reason };
	}
	return { ...result, reason: risk.reason ?? result.reason };
}

export class GateAutoApproverManager {
	private readonly pi: PiLike;
	private config?: GateAutoApproverConfig;
	private server = new ManagedLlamaServer();
	private endpoint?: string;
	private mode: GateAutoBackendMode = "disabled";
	private lastError?: string;
	private stable?: { text: string; hash: string };
	private runtimeKey?: string;
	private warmedKey?: string;
	private originalEnv?: Record<string, string | undefined>;
	private cleanupRegistered = false;

	constructor(pi: PiLike) {
		this.pi = pi;
	}

	isEnabled(): boolean {
		return this.config?.enabled === true;
	}

	async refresh(ctx: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		this.config = loadGateAutoConfig(ctx.cwd);
		if (!this.config.enabled) {
			await this.disableRuntimeOnly();
			this.mode = "disabled";
			return this.status(ctx);
		}
		return await this.ensureReady(ctx);
	}

	async enable(ctx: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		this.config = loadGateAutoConfig(ctx.cwd);
		return await this.ensureReady(ctx);
	}

	async disable(ctx?: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		await this.disableRuntimeOnly();
		this.mode = "disabled";
		if (ctx) this.config = loadGateAutoConfig(ctx.cwd);
		return this.status(ctx);
	}

	async shutdown(): Promise<void> {
		await this.disableRuntimeOnly();
	}

	status(ctx?: ExtensionContext): GateAutoRuntimeStatus {
		const cwd = ctx?.cwd ?? process.cwd();
		const config = this.config ?? loadGateAutoConfig(cwd);
		const serverStatus = this.server.status();
		return {
			enabled: config.enabled,
			mode: config.enabled ? this.mode : "disabled",
			processKind: config.processKind,
			endpoint: this.endpoint ?? serverStatus.endpoint ?? config.llama.endpoint ?? config.inheritedEndpoint,
			pid: serverStatus.pid,
			modelPath: config.llama.modelPath,
			serverPath: config.llama.serverPath,
			healthy: this.mode === "external" || this.mode === "inherited" || serverStatus.healthy,
			lastError: this.lastError ?? serverStatus.lastError,
			auditPath: getGateAutoAuditPath(cwd),
		};
	}

	async decide(ctx: ExtensionContext, request: GateAutoApprovalRequest): Promise<GateAutoApprovalResult> {
		const started = Date.now();
		const status = await this.ensureReady(ctx);
		const config = this.config ?? loadGateAutoConfig(ctx.cwd);
		if (!config.enabled || !status.endpoint || status.mode === "disabled" || status.mode === "unconfigured" || status.mode === "failed") {
			const result: GateAutoApprovalResult = {
				decision: "escalate",
				reason: status.lastError ?? "Gate auto-approver is unavailable",
				outcome: "unavailable",
				latencyMs: Date.now() - started,
				requestId: request.requestId,
				backendMode: status.mode,
			};
			this.audit(ctx.cwd, request, result, status.mode);
			return result;
		}

		const risk = assessGateAutoRisk(request);
		const stable = this.getStableContext(ctx, config);
		const dynamic = buildGateAutoDynamicPayload(ctx, request, config);
		const result = await requestGateAutoDecision({
			endpoint: status.endpoint,
			stablePrefix: stable.text,
			dynamicPayload: dynamic.text,
			stableContextHash: stable.hash,
			dynamicPayloadHash: dynamic.hash,
			requestId: request.requestId,
			config,
		});
		const guardedResult = applyRiskGuidance({ ...result, backendMode: status.mode }, risk);
		const annotatedResult: GateAutoApprovalResult = {
			...guardedResult,
			modelDecision: result.decision,
			modelOutcome: result.outcome,
			modelReason: result.reason,
			guardOverride: result.decision !== guardedResult.decision || result.outcome !== guardedResult.outcome,
			riskFlags: risk.flags,
			riskRecommendedDecision: risk.recommendedDecision,
		};
		this.audit(ctx.cwd, request, annotatedResult, status.mode, undefined, result, risk);
		return annotatedResult;
	}

	private async ensureReady(ctx: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		const config = this.config ?? loadGateAutoConfig(ctx.cwd);
		this.config = config;
		if (!config.enabled) {
			this.mode = "disabled";
			return this.status(ctx);
		}

		if (config.llama.endpointError) {
			await this.disableRuntimeOnly();
			this.mode = "unconfigured";
			this.lastError = config.llama.endpointError;
			return this.status(ctx);
		}

		if (config.llama.endpoint) {
			if (this.mode === "managed") await this.disableRuntimeOnly();
			this.endpoint = config.llama.endpoint;
			this.runtimeKey = `external:${this.endpoint}`;
			this.mode = "external";
			this.lastError = undefined;
			const stable = this.getStableContext(ctx, config);
			this.setChildEnv(this.endpoint, stable.hash);
			await this.warmIfNeeded(ctx, config, stable);
			return this.status(ctx);
		}

		if (config.inheritedEndpoint) {
			if (this.mode === "managed") await this.disableRuntimeOnly();
			this.endpoint = config.inheritedEndpoint;
			this.runtimeKey = `inherited:${this.endpoint}`;
			this.mode = "inherited";
			this.lastError = undefined;
			return this.status(ctx);
		}

		if (config.processKind === "subagent") {
			await this.disableRuntimeOnly();
			this.mode = "unconfigured";
			this.lastError = "No inherited or configured gate auto endpoint is available in this subagent";
			return this.status(ctx);
		}

		if (!config.llama.serverPath || !config.llama.modelPath) {
			await this.disableRuntimeOnly();
			this.mode = "unconfigured";
			this.lastError = "Configure gate.auto.llama.serverPath and gate.auto.llama.modelPath or gate.auto.llama.endpoint";
			return this.status(ctx);
		}

		this.registerCleanupOnce();
		const runtimeKey = this.buildManagedRuntimeKey(config);
		if (this.mode === "managed" && this.runtimeKey !== runtimeKey) await this.disableRuntimeOnly();
		const serverStatus = await this.server.start(config);
		if (!serverStatus.endpoint || !serverStatus.healthy) {
			await this.disableRuntimeOnly();
			this.mode = "failed";
			this.lastError = serverStatus.lastError ?? "Managed llama-server failed to start";
			return this.status(ctx);
		}
		this.endpoint = serverStatus.endpoint;
		this.runtimeKey = runtimeKey;
		this.mode = "managed";
		this.lastError = undefined;
		const stable = this.getStableContext(ctx, config);
		this.setChildEnv(this.endpoint, stable.hash);
		await this.warmIfNeeded(ctx, config, stable);
		this.audit(ctx.cwd, undefined, undefined, this.mode, "runtime_started");
		return this.status(ctx);
	}

	private buildManagedRuntimeKey(config: GateAutoApproverConfig): string {
		return JSON.stringify({
			serverPath: config.llama.serverPath,
			modelPath: config.llama.modelPath,
			host: config.llama.host,
			port: config.llama.port,
			ctxSize: config.llama.ctxSize,
			threads: config.llama.threads,
			threadsBatch: config.llama.threadsBatch,
			nGpuLayers: config.llama.nGpuLayers,
			parallel: config.llama.parallel,
			cachePrompt: config.llama.cachePrompt,
			cacheReuse: config.llama.cacheReuse,
		});
	}

	private async warmIfNeeded(ctx: ExtensionContext, config: GateAutoApproverConfig, stable: { text: string; hash: string }): Promise<void> {
		if (!config.llama.warmup || config.processKind !== "top-level" || !this.endpoint) return;
		const key = `${this.runtimeKey ?? this.endpoint}:${stable.hash}`;
		if (this.warmedKey === key) return;
		this.warmedKey = key;
		const result = await warmGateAutoApprover({ endpoint: this.endpoint, stablePrefix: stable.text, stableContextHash: stable.hash, config });
		if (!result.ok) {
			this.audit(ctx.cwd, undefined, { decision: "escalate", reason: "Gate auto warmup failed", outcome: "unavailable", latencyMs: result.latencyMs, requestId: "warmup", error: result.error }, this.mode, "warmup_failed");
		}
	}

	private getStableContext(ctx: ExtensionContext, config: GateAutoApproverConfig): { text: string; hash: string } {
		this.stable = buildGateAutoStableContext(this.pi, ctx.cwd, config);
		return this.stable;
	}

	private setChildEnv(endpoint: string, contextHash: string | undefined): void {
		if (!this.originalEnv) {
			this.originalEnv = {};
			for (const key of ENV_KEYS) this.originalEnv[key] = process.env[key];
		}
		process.env[GATE_AUTO_ENDPOINT_ENV] = endpoint;
		process.env[GATE_AUTO_OWNER_PID_ENV] = String(process.pid);
		process.env[GATE_AUTO_BACKEND_ENV] = "llama.cpp";
		if (contextHash) process.env[GATE_AUTO_CONTEXT_HASH_ENV] = contextHash;
	}

	private restoreChildEnv(): void {
		if (!this.originalEnv) return;
		for (const key of ENV_KEYS) {
			const value = this.originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		this.originalEnv = undefined;
	}

	private killRuntimeNow(): void {
		this.server.killNow();
		this.endpoint = undefined;
		this.runtimeKey = undefined;
		this.warmedKey = undefined;
		this.stable = undefined;
		this.restoreChildEnv();
	}

	private async disableRuntimeOnly(): Promise<void> {
		await this.server.stop();
		this.endpoint = undefined;
		this.runtimeKey = undefined;
		this.warmedKey = undefined;
		this.stable = undefined;
		this.restoreChildEnv();
	}

	private audit(cwd: string, request: GateAutoApprovalRequest | undefined, result: GateAutoApprovalResult | undefined, mode: GateAutoBackendMode, event?: string, modelResult?: GateAutoApprovalResult, risk?: GateAutoRiskAssessment): void {
		const config = this.config ?? loadGateAutoConfig(cwd);
		const record: GateAutoAuditRecord = {
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
			decision: result?.decision,
			reason: result?.reason,
			outcome: result?.outcome,
			latencyMs: result?.latencyMs,
			endpoint: this.endpoint,
			modelPath: config.llama.modelPath,
			stableContextHash: result?.stableContextHash ?? this.stable?.hash,
			dynamicPayloadHash: result?.dynamicPayloadHash,
			error: result?.error,
			event,
			modelDecision: modelResult?.decision,
			modelOutcome: modelResult?.outcome,
			modelReason: modelResult?.reason,
			guardOverride: Boolean(modelResult && result && (modelResult.decision !== result.decision || modelResult.outcome !== result.outcome)),
			riskFlags: risk?.flags,
			riskRecommendedDecision: risk?.recommendedDecision,
		};
		appendGateAutoAuditRecord(cwd, record, config.auditEnabled);
	}

	private registerCleanupOnce(): void {
		if (this.cleanupRegistered) return;
		this.cleanupRegistered = true;
		process.once("exit", () => {
			this.killRuntimeNow();
		});
		process.once("SIGINT", async () => {
			await this.shutdown();
			process.kill(process.pid, "SIGINT");
		});
		process.once("SIGTERM", async () => {
			await this.shutdown();
			process.kill(process.pid, "SIGTERM");
		});
	}
}

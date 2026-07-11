import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { validatePiModelBackend } from "./backend-pi-model.ts";
import { warmGateAutoApprover } from "./client.ts";
import {
	GATE_AUTO_BACKEND_ENV,
	GATE_AUTO_CONTEXT_HASH_ENV,
	GATE_AUTO_ENDPOINT_ENV,
	GATE_AUTO_OWNER_PID_ENV,
	loadGateAutoConfig,
} from "./config.ts";
import { ManagedLlamaServer } from "./llama-server.ts";
import type { GateAutoApproverConfig, GateAutoBackendMode, GateAutoRuntimeStatus } from "./types.ts";

const ENV_KEYS = [GATE_AUTO_ENDPOINT_ENV, GATE_AUTO_OWNER_PID_ENV, GATE_AUTO_BACKEND_ENV, GATE_AUTO_CONTEXT_HASH_ENV];

export interface GateAutoRuntimeHooks {
	stableContext(ctx: ExtensionContext, config: GateAutoApproverConfig): { text: string; hash: string };
	auditRuntimeEvent?(ctx: ExtensionContext, mode: GateAutoBackendMode, event: "runtime_started" | "warmup_failed", detail?: { latencyMs?: number; error?: string }): void;
}

export class GateAutoRuntime {
	private config?: GateAutoApproverConfig;
	private server = new ManagedLlamaServer();
	private endpoint?: string;
	private mode: GateAutoBackendMode = "disabled";
	private lastError?: string;
	private runtimeKey?: string;
	private warmedKey?: string;
	private originalEnv?: Record<string, string | undefined>;
	private cleanupRegistered = false;
	private exitHandler?: () => void;
	private sigintHandler?: () => void;
	private sigtermHandler?: () => void;

	isEnabled(): boolean {
		return this.config?.enabled === true;
	}

	async refresh(ctx: ExtensionContext, hooks: GateAutoRuntimeHooks): Promise<GateAutoRuntimeStatus> {
		this.config = loadGateAutoConfig(ctx.cwd);
		if (!this.config.enabled) {
			await this.disableRuntimeOnly();
			this.mode = "disabled";
			return this.status(ctx);
		}
		return await this.ensureReady(ctx, hooks);
	}

	async enable(ctx: ExtensionContext, hooks: GateAutoRuntimeHooks): Promise<GateAutoRuntimeStatus> {
		this.config = loadGateAutoConfig(ctx.cwd);
		return await this.ensureReady(ctx, hooks);
	}

	async disable(ctx?: ExtensionContext): Promise<GateAutoRuntimeStatus> {
		await this.disableRuntimeOnly();
		this.mode = "disabled";
		if (ctx) this.config = loadGateAutoConfig(ctx.cwd);
		return this.status(ctx);
	}

	async shutdown(): Promise<void> {
		await this.disableRuntimeOnly();
		this.unregisterCleanup();
	}

	status(ctx?: ExtensionContext): GateAutoRuntimeStatus {
		const cwd = ctx?.cwd ?? process.cwd();
		const config = this.config ?? loadGateAutoConfig(cwd);
		const serverStatus = this.server.status();
		return {
			enabled: config.enabled,
			mode: config.enabled ? this.mode : "disabled",
			processKind: config.processKind,
			backendType: config.backend.type,
			endpoint: this.endpoint ?? serverStatus.endpoint ?? config.llama.endpoint ?? config.inheritedEndpoint,
			pid: serverStatus.pid,
			modelPath: config.llama.modelPath,
			serverPath: config.llama.serverPath,
			provider: config.backend.type === "pi-model" ? config.backend.provider : undefined,
			model: config.backend.type === "pi-model" ? config.backend.model : undefined,
			thinking: config.backend.type === "pi-model" ? config.backend.thinking : undefined,
			cache: config.backend.type === "pi-model" ? "provider-dependent" : config.llama.cachePrompt ? "local-prompt-cache" : "none",
			healthy: this.mode === "pi-model" || this.mode === "external" || this.mode === "inherited" || serverStatus.healthy,
			lastError: this.lastError ?? config.backendError ?? serverStatus.lastError,
		};
	}

	private async ensureReady(ctx: ExtensionContext, hooks: GateAutoRuntimeHooks): Promise<GateAutoRuntimeStatus> {
		const config = this.config ?? loadGateAutoConfig(ctx.cwd);
		this.config = config;
		if (!config.enabled) {
			this.mode = "disabled";
			return this.status(ctx);
		}

		if (config.backendError) {
			await this.disableRuntimeOnly();
			this.mode = "unconfigured";
			this.lastError = config.backendError;
			return this.status(ctx);
		}

		if (config.backend.type === "pi-model") {
			await this.disableRuntimeOnly();
			const validation = await validatePiModelBackend(ctx, config.backend);
			if (validation.ok === false) {
				this.mode = "unconfigured";
				this.runtimeKey = undefined;
				this.lastError = validation.error;
				return this.status(ctx);
			}
			this.mode = "pi-model";
			this.runtimeKey = `pi-model:${config.backend.provider}/${config.backend.model}`;
			process.env[GATE_AUTO_BACKEND_ENV] = "pi-model";
			this.lastError = undefined;
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
			const stable = hooks.stableContext(ctx, config);
			this.setChildEnv(this.endpoint, stable.hash);
			await this.warmIfNeeded(ctx, config, stable, hooks);
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
			this.lastError = "Configure gate.auto.backend.serverPath and gate.auto.backend.modelPath or gate.auto.backend.endpoint";
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
		const stable = hooks.stableContext(ctx, config);
		this.setChildEnv(this.endpoint, stable.hash);
		await this.warmIfNeeded(ctx, config, stable, hooks);
		hooks.auditRuntimeEvent?.(ctx, this.mode, "runtime_started");
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

	private async warmIfNeeded(ctx: ExtensionContext, config: GateAutoApproverConfig, stable: { text: string; hash: string }, hooks: GateAutoRuntimeHooks): Promise<void> {
		if (!config.llama.warmup || config.processKind !== "top-level" || !this.endpoint) return;
		const key = `${this.runtimeKey ?? this.endpoint}:${stable.hash}`;
		if (this.warmedKey === key) return;
		this.warmedKey = key;
		const result = await warmGateAutoApprover({ endpoint: this.endpoint, stablePrefix: stable.text, stableContextHash: stable.hash, config });
		if (!result.ok) {
			hooks.auditRuntimeEvent?.(ctx, this.mode, "warmup_failed", { latencyMs: result.latencyMs, error: result.error });
		}
	}

	private setChildEnv(endpoint: string, contextHash: string | undefined): void {
		if (!this.originalEnv) {
			this.originalEnv = {};
			for (const key of ENV_KEYS) this.originalEnv[key] = process.env[key];
		}
		process.env[GATE_AUTO_ENDPOINT_ENV] = endpoint;
		process.env[GATE_AUTO_OWNER_PID_ENV] = String(process.pid);
		process.env[GATE_AUTO_BACKEND_ENV] = "managed-llama";
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
		this.restoreChildEnv();
	}

	private async disableRuntimeOnly(): Promise<void> {
		await this.server.stop();
		this.endpoint = undefined;
		this.runtimeKey = undefined;
		this.warmedKey = undefined;
		this.restoreChildEnv();
	}

	private registerCleanupOnce(): void {
		if (this.cleanupRegistered) return;
		this.cleanupRegistered = true;
		this.exitHandler = () => { this.killRuntimeNow(); };
		this.sigintHandler = () => { void this.shutdown().then(() => process.kill(process.pid, "SIGINT")); };
		this.sigtermHandler = () => { void this.shutdown().then(() => process.kill(process.pid, "SIGTERM")); };
		process.once("exit", this.exitHandler);
		process.once("SIGINT", this.sigintHandler);
		process.once("SIGTERM", this.sigtermHandler);
	}

	private unregisterCleanup(): void {
		if (this.exitHandler) process.off("exit", this.exitHandler);
		if (this.sigintHandler) process.off("SIGINT", this.sigintHandler);
		if (this.sigtermHandler) process.off("SIGTERM", this.sigtermHandler);
		this.exitHandler = undefined;
		this.sigintHandler = undefined;
		this.sigtermHandler = undefined;
		this.cleanupRegistered = false;
	}
}

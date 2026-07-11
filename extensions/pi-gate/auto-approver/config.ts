import { buildPromptVars, getRawStoredVarValue } from "../../z-prompt-vars/prompt-vars.ts";

import type {
	GateAutoApproverConfig,
	GateAutoBackendConfig,
	GateAutoCacheRetention,
	GateAutoProcessKind,
	GateAutoResponseFormat,
	GateAutoThinking,
	ManagedLlamaGateAutoBackendConfig,
	PiModelGateAutoBackendConfig,
} from "./types.ts";

const PI_GATE_AUTO_ENDPOINT_ENV = "PI_GATE_AUTO_ENDPOINT";

function boolValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback: number, options: { min?: number; max?: number } = {}): number {
	const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(raw)) return fallback;
	const min = options.min ?? Number.NEGATIVE_INFINITY;
	const max = options.max ?? Number.POSITIVE_INFINITY;
	return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function optionalNumberValue(value: unknown, options: { min?: number; max?: number } = {}): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return numberValue(value, 0, options);
}

function responseFormatValue(value: unknown): GateAutoResponseFormat {
	if (value === "json_schema" || value === "json_object" || value === "plain_json" || value === "auto") return value;
	return "auto";
}

function thinkingValue(value: unknown): GateAutoThinking {
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	return "off";
}

function cacheRetentionValue(value: unknown): GateAutoCacheRetention {
	if (value === "none" || value === "short" || value === "long") return value;
	return "short";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isLoopbackHost(value: string): boolean {
	const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackEndpoint(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && isLoopbackHost(url.hostname);
	} catch {
		return false;
	}
}

export function isGateAutoSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.PI_SUBAGENT_DEPTH || env.PI_SUBAGENT_PARENT_CHILD_ID || env.PI_SUBAGENT_TOP_RUN_ID);
}

function buildManagedLlamaBackend(env: NodeJS.ProcessEnv, processKind: GateAutoProcessKind, source: Record<string, unknown> | undefined): { backend: ManagedLlamaGateAutoBackendConfig; inheritedEndpoint?: string; error?: string } {
	const from = (key: string): unknown => source?.[key];
	const rawInheritedEndpoint = stringValue(env[PI_GATE_AUTO_ENDPOINT_ENV]);
	const rawConfiguredEndpoint = stringValue(from("endpoint"));
	const rawHost = stringValue(from("host")) ?? "127.0.0.1";
	const host = isLoopbackHost(rawHost) ? rawHost : "127.0.0.1";
	const hostError = !rawConfiguredEndpoint && rawHost !== host ? "gate.auto.backend.host must be loopback for managed gate auto mode" : undefined;
	const configuredEndpoint = rawConfiguredEndpoint && isLoopbackEndpoint(rawConfiguredEndpoint) ? rawConfiguredEndpoint : undefined;
	const inheritedEndpoint = processKind === "subagent" && rawInheritedEndpoint && isLoopbackEndpoint(rawInheritedEndpoint) ? rawInheritedEndpoint : undefined;
	const endpointError = hostError ?? (rawConfiguredEndpoint && !configuredEndpoint
		? "gate.auto.backend.endpoint must be a local http loopback URL"
		: processKind === "subagent" && rawInheritedEndpoint && !inheritedEndpoint
			? "PI_GATE_AUTO_ENDPOINT must be a local http loopback URL"
			: undefined);
	return {
		inheritedEndpoint,
		error: endpointError,
		backend: {
			type: "managed-llama",
			endpoint: configuredEndpoint,
			endpointError,
			serverPath: stringValue(from("serverPath")),
			modelPath: stringValue(from("modelPath")),
			host,
			port: numberValue(from("port"), 0, { min: 0, max: 65535 }),
			ctxSize: optionalNumberValue(from("ctxSize"), { min: 1 }),
			threads: optionalNumberValue(from("threads"), { min: 1 }),
			threadsBatch: optionalNumberValue(from("threadsBatch"), { min: 1 }),
			nGpuLayers: optionalNumberValue(from("nGpuLayers"), { min: 0 }),
			parallel: numberValue(from("parallel"), 2, { min: 1, max: 16 }),
			cachePrompt: boolValue(from("cachePrompt"), true),
			cacheReuse: optionalNumberValue(from("cacheReuse"), { min: 0 }),
			idSlot: optionalNumberValue(from("idSlot"), { min: 0 }),
			startupTimeoutMs: numberValue(from("startupTimeoutMs"), 30000, { min: 1000, max: 300000 }),
			responseFormat: responseFormatValue(from("responseFormat")),
			enableThinking: boolValue(from("enableThinking"), false),
			warmup: boolValue(from("warmup"), true),
		},
	};
}

function buildPiModelBackend(source: Record<string, unknown>): { backend?: PiModelGateAutoBackendConfig; error?: string } {
	const provider = stringValue(source.provider);
	const model = stringValue(source.model);
	if (!provider || !model) return { error: "gate.auto.backend.provider and gate.auto.backend.model are required for pi-model" };
	return {
		backend: {
			type: "pi-model",
			provider,
			model,
			thinking: thinkingValue(source.thinking),
			cacheRetention: cacheRetentionValue(source.cacheRetention),
			temperature: numberValue(source.temperature, 0, { min: 0, max: 2 }),
			maxTokens: numberValue(source.maxTokens, 128, { min: 1, max: 4096 }),
		},
	};
}

export function loadGateAutoConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GateAutoApproverConfig {
	const state = buildPromptVars(cwd);
	const get = (key: string): unknown => getRawStoredVarValue(state, key);
	const processKind: GateAutoProcessKind = isGateAutoSubagentProcess(env) ? "subagent" : "top-level";
	const rawBackend = get("gate.auto.backend");
	const backendObject = objectValue(rawBackend);
	const managedFallback = buildManagedLlamaBackend(env, processKind, undefined);
	let backend: GateAutoBackendConfig = managedFallback.backend;
	let inheritedEndpoint = managedFallback.inheritedEndpoint;
	let backendError = managedFallback.error;

	if (backendObject) {
		const type = backendObject.type;
		if (type === "managed-llama") {
			const managed = buildManagedLlamaBackend(env, processKind, backendObject);
			backend = managed.backend;
			inheritedEndpoint = managed.inheritedEndpoint;
			backendError = managed.error;
		} else if (type === "pi-model") {
			const piModel = buildPiModelBackend(backendObject);
			if (piModel.backend) {
				backend = piModel.backend;
				backendError = undefined;
			} else {
				backendError = piModel.error;
			}
		} else {
			backendError = "gate.auto.backend.type must be managed-llama or pi-model";
		}
	} else if (rawBackend !== undefined) {
		backendError = "gate.auto.backend must be an object with type managed-llama or pi-model";
	}

	return {
		enabled: get("gate.auto.enabled") === true,
		startOnSession: boolValue(get("gate.auto.startOnSession"), false),
		backend,
		llama: backend.type === "managed-llama" ? backend : managedFallback.backend,
		backendError,
		timeoutMs: numberValue(get("gate.auto.timeoutMs"), 4000, { min: 100, max: 60000 }),
		auditEnabled: boolValue(get("gate.auto.audit.enabled"), true),
		auditIncludeDynamicPayloadText: boolValue(get("gate.auto.audit.includeDynamicPayloadText"), false),
		processKind,
		inheritedEndpoint,
		context: {
			includeAgentsMd: boolValue(get("gate.auto.context.includeAgentsMd"), true),
			includeAgents: boolValue(get("gate.auto.context.includeAgents"), true),
			includeSubagents: boolValue(get("gate.auto.context.includeSubagents"), true),
			maxStablePrefixChars: numberValue(get("gate.auto.context.maxStablePrefixChars"), 24000, { min: 2000, max: 200000 }),
			maxDynamicPayloadChars: numberValue(get("gate.auto.context.maxDynamicPayloadChars"), 8000, { min: 1000, max: 64000 }),
			maxLastUserTurnChars: numberValue(get("gate.auto.context.maxLastUserTurnChars"), 2000, { min: 0, max: 16000 }),
			maxTaskPreviewChars: numberValue(get("gate.auto.context.maxTaskPreviewChars"), 1000, { min: 0, max: 8000 }),
		},
	};
}

export const GATE_AUTO_ENDPOINT_ENV = PI_GATE_AUTO_ENDPOINT_ENV;
export const GATE_AUTO_OWNER_PID_ENV = "PI_GATE_AUTO_OWNER_PID";
export const GATE_AUTO_BACKEND_ENV = "PI_GATE_AUTO_BACKEND";
export const GATE_AUTO_CONTEXT_HASH_ENV = "PI_GATE_AUTO_CONTEXT_HASH";

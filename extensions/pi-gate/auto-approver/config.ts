import { buildPromptVars, getRawStoredVarValue } from "../../z-prompt-vars/prompt-vars.ts";

import type { GateAutoApproverConfig, GateAutoProcessKind, GateAutoResponseFormat } from "./types.ts";

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

function responseFormatValue(value: unknown): GateAutoResponseFormat {
	if (value === "json_schema" || value === "json_object" || value === "plain_json" || value === "auto") return value;
	return "auto";
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

export function loadGateAutoConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GateAutoApproverConfig {
	const state = buildPromptVars(cwd);
	const get = (key: string): unknown => getRawStoredVarValue(state, key);
	const processKind: GateAutoProcessKind = isGateAutoSubagentProcess(env) ? "subagent" : "top-level";
	const rawInheritedEndpoint = stringValue(env[PI_GATE_AUTO_ENDPOINT_ENV]);
	const rawConfiguredEndpoint = stringValue(get("gate.auto.llama.endpoint"));
	const rawHost = stringValue(get("gate.auto.llama.host")) ?? "127.0.0.1";
	const host = isLoopbackHost(rawHost) ? rawHost : "127.0.0.1";
	const hostError = !rawConfiguredEndpoint && rawHost !== host ? "gate.auto.llama.host must be loopback for managed gate auto mode" : undefined;
	const configuredEndpoint = rawConfiguredEndpoint && isLoopbackEndpoint(rawConfiguredEndpoint) ? rawConfiguredEndpoint : undefined;
	const inheritedEndpoint = processKind === "subagent" && rawInheritedEndpoint && isLoopbackEndpoint(rawInheritedEndpoint) ? rawInheritedEndpoint : undefined;
	const endpointError = hostError ?? (rawConfiguredEndpoint && !configuredEndpoint
		? "gate.auto.llama.endpoint must be a local http loopback URL"
		: processKind === "subagent" && rawInheritedEndpoint && !inheritedEndpoint
			? "PI_GATE_AUTO_ENDPOINT must be a local http loopback URL"
			: undefined);
	const backend = stringValue(get("gate.auto.backend")) ?? "llama.cpp";
	return {
		enabled: get("gate.auto.enabled") === true,
		startOnSession: boolValue(get("gate.auto.startOnSession"), false),
		backend: backend === "llama.cpp" ? "llama.cpp" : "llama.cpp",
		timeoutMs: numberValue(get("gate.auto.timeoutMs"), 1500, { min: 100, max: 60000 }),
		auditEnabled: boolValue(get("gate.auto.audit.enabled"), true),
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
		llama: {
			endpoint: configuredEndpoint,
			endpointError,
			serverPath: stringValue(get("gate.auto.llama.serverPath")),
			modelPath: stringValue(get("gate.auto.llama.modelPath")),
			host,
			port: numberValue(get("gate.auto.llama.port"), 0, { min: 0, max: 65535 }),
			ctxSize: get("gate.auto.llama.ctxSize") === undefined ? undefined : numberValue(get("gate.auto.llama.ctxSize"), 0, { min: 1 }),
			threads: get("gate.auto.llama.threads") === undefined ? undefined : numberValue(get("gate.auto.llama.threads"), 0, { min: 1 }),
			threadsBatch: get("gate.auto.llama.threadsBatch") === undefined ? undefined : numberValue(get("gate.auto.llama.threadsBatch"), 0, { min: 1 }),
			nGpuLayers: get("gate.auto.llama.nGpuLayers") === undefined ? undefined : numberValue(get("gate.auto.llama.nGpuLayers"), 0, { min: 0 }),
			parallel: numberValue(get("gate.auto.llama.parallel"), 2, { min: 1, max: 16 }),
			cachePrompt: boolValue(get("gate.auto.llama.cachePrompt"), true),
			cacheReuse: get("gate.auto.llama.cacheReuse") === undefined ? undefined : numberValue(get("gate.auto.llama.cacheReuse"), 0, { min: 0 }),
			idSlot: get("gate.auto.llama.idSlot") === undefined ? undefined : numberValue(get("gate.auto.llama.idSlot"), 0, { min: 0 }),
			startupTimeoutMs: numberValue(get("gate.auto.llama.startupTimeoutMs"), 30000, { min: 1000, max: 300000 }),
			responseFormat: responseFormatValue(get("gate.auto.llama.responseFormat")),
			enableThinking: boolValue(get("gate.auto.llama.enableThinking"), false),
			warmup: boolValue(get("gate.auto.llama.warmup"), true),
		},
	};
}

export const GATE_AUTO_ENDPOINT_ENV = PI_GATE_AUTO_ENDPOINT_ENV;
export const GATE_AUTO_OWNER_PID_ENV = "PI_GATE_AUTO_OWNER_PID";
export const GATE_AUTO_BACKEND_ENV = "PI_GATE_AUTO_BACKEND";
export const GATE_AUTO_CONTEXT_HASH_ENV = "PI_GATE_AUTO_CONTEXT_HASH";

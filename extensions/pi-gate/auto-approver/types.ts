export type GateAutoDecision = "allow" | "block" | "prompt";
export type GateAutoOutcome =
	| "allowed"
	| "blocked"
	| "escalated"
	| "fallback_prompt"
	| "timeout"
	| "malformed"
	| "unavailable"
	| "error";

export type GateAutoProcessKind = "top-level" | "subagent";
export type GateAutoBackendType = "managed-llama" | "pi-model";
export type GateAutoBackendMode = "disabled" | "external" | "inherited" | "managed" | "pi-model" | "unconfigured" | "failed";
export type GateAutoResponseFormat = "json_schema" | "json_object" | "plain_json" | "auto";
export type GateAutoCacheRetention = "none" | "short" | "long";
export type GateAutoThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ManagedLlamaGateAutoBackendConfig {
	type: "managed-llama";
	endpoint?: string;
	endpointError?: string;
	serverPath?: string;
	modelPath?: string;
	host: string;
	port: number;
	ctxSize?: number;
	threads?: number;
	threadsBatch?: number;
	nGpuLayers?: number;
	parallel: number;
	cachePrompt: boolean;
	cacheReuse?: number;
	idSlot?: number;
	startupTimeoutMs: number;
	responseFormat: GateAutoResponseFormat;
	enableThinking: boolean;
	warmup: boolean;
}

export interface PiModelGateAutoBackendConfig {
	type: "pi-model";
	provider: string;
	model: string;
	thinking: GateAutoThinking;
	cacheRetention: GateAutoCacheRetention;
	temperature: number;
	maxTokens: number;
}

export type GateAutoBackendConfig = ManagedLlamaGateAutoBackendConfig | PiModelGateAutoBackendConfig;

export interface GateAutoApproverConfig {
	enabled: boolean;
	startOnSession: boolean;
	backend: GateAutoBackendConfig;
	/** Compatibility alias for managed-llama code paths. */
	llama: ManagedLlamaGateAutoBackendConfig;
	backendError?: string;
	migrationNotice?: string;
	timeoutMs: number;
	auditEnabled: boolean;
	auditIncludeDynamicPayloadText: boolean;
	processKind: GateAutoProcessKind;
	inheritedEndpoint?: string;
	context: {
		includeAgentsMd: boolean;
		includeAgents: boolean;
		includeSubagents: boolean;
		maxStablePrefixChars: number;
		maxDynamicPayloadChars: number;
		maxLastUserTurnChars: number;
		maxTaskPreviewChars: number;
	};
}

export interface GateAutoRuntimeStatus {
	enabled: boolean;
	mode: GateAutoBackendMode;
	processKind: GateAutoProcessKind;
	backendType?: GateAutoBackendType;
	endpoint?: string;
	pid?: number;
	modelPath?: string;
	serverPath?: string;
	provider?: string;
	model?: string;
	thinking?: GateAutoThinking;
	cache?: "local-prompt-cache" | "provider-dependent" | "none";
	migrationNotice?: string;
	healthy?: boolean;
	lastError?: string;
	auditPath?: string;
}

export interface GateAutoApprovalRequest {
	requestId: string;
	profileName: string;
	lineageNames: string[];
	cwd?: string;
	unattended: boolean;
	toolName: string;
	subject: string;
	sessionKeyHash: string;
	reasons: string[];
	inputSummary?: unknown;
	pathCandidates?: string[];
	bash?: {
		command: string;
		normalizedCommand: string;
		analysis: unknown;
	};
}

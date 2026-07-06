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
export type GateAutoBackendMode = "disabled" | "external" | "inherited" | "managed" | "unconfigured" | "failed";
export type GateAutoResponseFormat = "json_schema" | "json_object" | "plain_json" | "auto";

export interface GateAutoApproverConfig {
	enabled: boolean;
	startOnSession: boolean;
	backend: "llama.cpp";
	timeoutMs: number;
	auditEnabled: boolean;
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
	llama: {
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
	};
}

export interface GateAutoRuntimeStatus {
	enabled: boolean;
	mode: GateAutoBackendMode;
	processKind: GateAutoProcessKind;
	endpoint?: string;
	pid?: number;
	modelPath?: string;
	serverPath?: string;
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

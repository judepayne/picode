import type { GateAutoBackendMode, GateAutoOutcome, GateAutoProcessKind } from "../auto-approver/types.ts";

export type GateSemanticDecision = "allow" | "block" | "prompt";
export type GateSemanticOutcome = GateAutoOutcome;
export type GateSemanticRoleType = "agent" | "subagent";
export type GateSemanticSubject = "read" | "edit" | "bash" | "list" | "glob" | "grep" | "external_directory";

export type GateSemanticRuleMap = Partial<Record<GateSemanticSubject, string[]>>;

export interface GateSemanticRules {
	hardDeny?: GateSemanticRuleMap;
	alwaysAllow?: GateSemanticRuleMap;
}

export interface GateSemanticRoleConfig extends GateSemanticRules {
	guidance: string;
}

export interface GateSemanticConfig extends GateSemanticRules {
	$schema?: string;
	agents?: Record<string, GateSemanticRoleConfig>;
	subagents?: Record<string, GateSemanticRoleConfig>;
}

export interface LoadedGateSemanticConfig {
	config?: GateSemanticConfig;
	configPath: string;
	schemaPath: string;
	error?: string;
}

export interface GateSemanticMatch {
	kind: "hardDeny" | "alwaysAllow";
	scope: "global" | "role";
	subject: GateSemanticSubject;
	pattern: string;
	display: string;
}

export interface GateSemanticRoleContext {
	roleType: GateSemanticRoleType;
	roleName: string;
	guidance: string;
	roleConfig?: GateSemanticRoleConfig;
}

export interface GateSemanticEvaluationInput {
	config: GateSemanticConfig;
	cwd: string;
	subject: GateSemanticSubject;
	groups: Array<{ display: string; values: string[] }>;
	roleType: GateSemanticRoleType;
	roleName: string;
	bashCommand?: string;
}

export type GateSemanticEvaluation =
	| { action: "block"; match: GateSemanticMatch; role: GateSemanticRoleContext }
	| { action: "allow"; match: GateSemanticMatch; role: GateSemanticRoleContext }
	| { action: "semantic"; role: GateSemanticRoleContext };

export interface GateSemanticRequest {
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
	roleType: GateSemanticRoleType;
	roleName: string;
	guidance: string;
	matchedHardDeny?: GateSemanticMatch;
	matchedAlwaysAllow?: GateSemanticMatch;
}

export interface GateSemanticResult {
	decision: GateSemanticDecision;
	reason: string;
	outcome: GateSemanticOutcome;
	latencyMs: number;
	requestId: string;
	error?: string;
	backendMode?: GateAutoBackendMode;
	stableContextHash?: string;
	dynamicPayloadHash?: string;
	modelDecision?: GateSemanticDecision;
	modelOutcome?: GateSemanticOutcome;
	modelReason?: string;
	guardOverride?: boolean;
	riskFlags?: string[];
	riskRecommendedDecision?: string;
}

export interface GateSemanticAuditRecord {
	schemaVersion: 1;
	timestamp: string;
	pid: number;
	processKind: GateAutoProcessKind;
	backendMode: GateAutoBackendMode;
	requestId?: string;
	profileName?: string;
	lineageNames?: string[];
	unattended?: boolean;
	toolName?: string;
	subject?: string;
	pathCandidates?: string[];
	reasons?: string[];
	roleType?: GateSemanticRoleType;
	roleName?: string;
	decision?: GateSemanticDecision;
	reason?: string;
	outcome?: GateSemanticOutcome;
	latencyMs?: number;
	endpoint?: string;
	modelPath?: string;
	stableContextHash?: string;
	dynamicPayloadHash?: string;
	error?: string;
	event?: string;
	matchedHardDeny?: GateSemanticMatch;
	matchedAlwaysAllow?: GateSemanticMatch;
	modelDecision?: GateSemanticDecision;
	modelOutcome?: GateSemanticOutcome;
	modelReason?: string;
	guardOverride?: boolean;
	riskFlags?: string[];
	riskRecommendedDecision?: string;
}

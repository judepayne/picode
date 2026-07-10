export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRuleMap = Record<string, PermissionAction>;
export type PermissionSubjectConfig = PermissionAction | PermissionRuleMap;
export type PermissionConfig = PermissionAction | Record<string, PermissionSubjectConfig>;

export interface RawPolicy {
	$schema?: string;
	activeProfile?: string;
	permission?: PermissionConfig;
	profiles?: Record<string, RawProfile>;
}

export interface RawProfile {
	"inherits-from"?: string;
	permission?: PermissionConfig;
	unattended?: boolean;
}

export interface JsonSchemaNode {
	$defs?: Record<string, JsonSchemaNode>;
	$ref?: string;
	additionalProperties?: boolean | JsonSchemaNode;
	anyOf?: JsonSchemaNode[];
	enum?: unknown[];
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	type?: "boolean" | "object" | "string";
}

export interface LoadedPolicy {
	policy?: RawPolicy;
	policyPath: string;
	schemaPath: string;
	error?: string;
}

export interface CompiledPatternRule {
	action: PermissionAction;
	expandedPattern: string;
	rawPattern: string;
	regex: RegExp;
}

export interface CompiledPolicy {
	profileName: string;
	requestedProfileName: string;
	globalActions: PermissionAction[];
	subjects: Record<string, CompiledPatternRule[]>;
	unattended: boolean;
}

export interface EffectiveGatePolicy {
	active: CompiledPolicy;
	lineage: CompiledPolicy[];
	lineageNames: string[];
	profileName: string;
	unattended: boolean;
}

export interface ResolvedProfileOptions {
	unattended: boolean;
}

export interface MergedPermissionConfig {
	globalActions: PermissionAction[];
	subjects: Record<string, Array<{ action: PermissionAction; rawPattern: string }>>;
}

export interface MutationAnalysis {
	mutating: boolean;
	complex: boolean;
	paths: string[];
	inferredCwdTarget: boolean;
	reason: string;
}

export interface Decision {
	action: PermissionAction;
	reasons: string[];
}

export const BASE_PROFILE_NAME = "$base";

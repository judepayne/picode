import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { loadGateAutoConfig } from "./auto-approver/config.ts";
import { GateAutoApproverManager } from "./auto-approver/manager.ts";
import type { GateAutoApprovalRequest } from "./auto-approver/types.ts";
import { evaluateGateSemantic } from "./semantic/evaluator.ts";
import { loadGateSemanticConfig } from "./semantic/loader.ts";
import { isGateSemanticSubject } from "./semantic/types.ts";
import type { GateSemanticEvaluation, GateSemanticMatch, GateSemanticRequest, GateSemanticResult, GateSemanticRoleType, GateSemanticSubject } from "./semantic/types.ts";
import {
	buildAbsolutePathGroups,
	buildExternalDirectoryGroups,
	buildPathCandidateGroup,
	expandPatternValue,
	isPathSubject,
	isWithinRoot,
	normalizeAbsPath,
	normalizeCommand,
	normalizePathArg,
	normalizeSlashes,
	wildcardToRegex,
	type CandidateGroup,
} from "./matching.ts";
import { assessGateRisk } from "./risk.ts";
import { analyzeShellCommand, parseConservativeShellPipeline, tokenizeShellCommand, type ConservativeShellAnalysis } from "../shared/shell-analysis.ts";
import { hasSensitivePathCandidate, hasSensitiveSearchTarget } from "./sensitive-paths.ts";
import { buildPromptVars, setGateAutoEnabled, setVar } from "../z-prompt-vars/prompt-vars.ts";

type PermissionAction = "allow" | "ask" | "deny";

type PermissionRuleMap = Record<string, PermissionAction>;
type PermissionSubjectConfig = PermissionAction | PermissionRuleMap;
type PermissionConfig = PermissionAction | Record<string, PermissionSubjectConfig>;

interface RawPolicy {
	$schema?: string;
	activeProfile?: string;
	permission?: PermissionConfig;
	profiles?: Record<string, RawProfile>;
}

interface RawProfile {
	"inherits-from"?: string;
	permission?: PermissionConfig;
	unattended?: boolean;
}

interface JsonSchemaNode {
	$defs?: Record<string, JsonSchemaNode>;
	$ref?: string;
	additionalProperties?: boolean | JsonSchemaNode;
	anyOf?: JsonSchemaNode[];
	enum?: unknown[];
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	type?: "boolean" | "object" | "string";
}

interface LoadedPolicy {
	policy?: RawPolicy;
	policyPath: string;
	schemaPath: string;
	error?: string;
}

interface CompiledPatternRule {
	action: PermissionAction;
	expandedPattern: string;
	rawPattern: string;
	regex: RegExp;
}

interface CompiledPolicy {
	profileName: string;
	requestedProfileName: string;
	globalActions: PermissionAction[];
	subjects: Record<string, CompiledPatternRule[]>;
	unattended: boolean;
}

interface EffectiveGatePolicy {
	active: CompiledPolicy;
	lineage: CompiledPolicy[];
	lineageNames: string[];
	profileName: string;
	unattended: boolean;
}

interface ResolvedProfileOptions {
	unattended: boolean;
}

interface MergedPermissionConfig {
	globalActions: PermissionAction[];
	subjects: Record<string, Array<{ action: PermissionAction; rawPattern: string }>>;
}

interface ProfileSwitchRequest {
	profile: string;
	notify?: boolean;
	source?: string;
}

interface MutationAnalysis {
	mutating: boolean;
	complex: boolean;
	paths: string[];
	inferredCwdTarget: boolean;
	reason: string;
}

interface Decision {
	action: PermissionAction;
	reasons: string[];
}

const SESSION_STATUS_KEY = "gate";
const GATE_PROFILE_ENV = "GATE_PROFILE";
const GATE_PROFILE_LOCK_ENV = "GATE_PROFILE_LOCK";
const PI_GATE_PROFILE_LINEAGE_ENV = "PI_GATE_PROFILE_LINEAGE";
const GATE_SWITCH_PROFILE_EVENT = "gate:switch-profile";
const POLICY_SCHEMA_FILE = "policy.schema.json";
const BASE_PROFILE_NAME = "$base";
const GATE_ERROR_STATUS = "gate:error";
const MAX_SESSION_ALLOWS = 100;
const AUTO_BLOCK_CONSECUTIVE_PROMPT_THRESHOLD = 3;
const AUTO_BLOCK_TOTAL_PROMPT_THRESHOLD = 20;
const GATE_AUTO_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const GATE_AUTO_SETUP_MAX_OUTPUT_CHARS = 8000;
const SHELL_SEPARATOR_TOKENS = new Set([";", "&&", "||", "|", "|&", "&", "then", "do", "else", "elif", "fi"]);
const ACTION_PRIORITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };
const BUILTIN_PERMISSION: PermissionConfig = {
	"*": "allow",
	"external_directory": {
		"*": "ask",
	},
	"read": {
		"*": "allow",
		"*.env": "deny",
		"*.env.*": "deny",
		"*.env.example": "allow",
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProfileName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed === "base" ? BASE_PROFILE_NAME : trimmed;
}

function isEnvEnabled(value: string | undefined): boolean {
	if (!value) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

function resolveSchemaRef(root: JsonSchemaNode, ref: string): JsonSchemaNode {
	if (!ref.startsWith("#/")) throw new Error(`unsupported schema ref ${ref}`);
	const segments = ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
	let current: unknown = root;
	for (const segment of segments) {
		if (!isPlainObject(current) || !(segment in current)) {
			throw new Error(`missing schema ref target ${ref}`);
		}
		current = current[segment];
	}
	if (!isPlainObject(current)) throw new Error(`invalid schema ref target ${ref}`);
	return current as JsonSchemaNode;
}

function formatSchemaPath(basePath: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${basePath}.${key}` : `${basePath}[${JSON.stringify(key)}]`;
}

function validateValueAgainstSchema(root: JsonSchemaNode, schema: JsonSchemaNode, value: unknown, currentPath: string): string | undefined {
	if (schema.$ref) {
		return validateValueAgainstSchema(root, resolveSchemaRef(root, schema.$ref), value, currentPath);
	}

	if (schema.anyOf && schema.anyOf.length > 0) {
		const errors = schema.anyOf
			.map((option) => validateValueAgainstSchema(root, option, value, currentPath))
			.filter((error): error is string => Boolean(error));
		if (errors.length === schema.anyOf.length) return errors[0];
		return undefined;
	}

	if (schema.type === "string" && typeof value !== "string") {
		return `${currentPath} must be a string`;
	}
	if (schema.type === "boolean" && typeof value !== "boolean") {
		return `${currentPath} must be a boolean`;
	}

	if (schema.type === "object") {
		if (!isPlainObject(value)) return `${currentPath} must be an object`;
		for (const required of schema.required ?? []) {
			if (!(required in value)) return `${formatSchemaPath(currentPath, required)} is required`;
		}

		const properties = schema.properties ?? {};
		for (const [key, childValue] of Object.entries(value)) {
			const propertySchema = properties[key];
			if (propertySchema) {
				const error = validateValueAgainstSchema(root, propertySchema, childValue, formatSchemaPath(currentPath, key));
				if (error) return error;
				continue;
			}

			if (schema.additionalProperties === false) {
				return `${formatSchemaPath(currentPath, key)} is not allowed`;
			}
			if (isPlainObject(schema.additionalProperties)) {
				const error = validateValueAgainstSchema(
					root,
					schema.additionalProperties as JsonSchemaNode,
					childValue,
					formatSchemaPath(currentPath, key),
				);
				if (error) return error;
			}
		}
	}

	if (schema.enum && !schema.enum.includes(value)) {
		return `${currentPath} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
	}

	return undefined;
}

export function validatePolicySchema(schema: JsonSchemaNode, policy: unknown): string | undefined {
	return validateValueAgainstSchema(schema, schema, policy, "$policy");
}

function validatePermissionConfigSemantics(config: PermissionConfig | undefined, scope: string): string | undefined {
	if (config === undefined) return undefined;
	if (typeof config === "string") return undefined;
	for (const [subject, rule] of Object.entries(config)) {
		if (!subject.trim()) return `${scope} permission subject keys must not be empty`;
		if (subject === "*" && typeof rule !== "string") {
			return `${scope}.${subject} must be an action string`;
		}
		if (typeof rule === "string") continue;
		for (const pattern of Object.keys(rule)) {
			if (!pattern) return `${scope}.${subject} contains an empty pattern key`;
		}
	}
	return undefined;
}

function validatePolicySemantics(policy: RawPolicy): string | undefined {
	const profiles = policy.profiles ?? {};
	const basePermissionError = validatePermissionConfigSemantics(policy.permission, "permission");
	if (basePermissionError) return basePermissionError;

	for (const [profileName, profile] of Object.entries(profiles)) {
		const permissionError = validatePermissionConfigSemantics(profile.permission, `profiles.${profileName}.permission`);
		if (permissionError) return permissionError;
		const inherited = normalizeProfileName(profile["inherits-from"]);
		if (inherited && inherited !== BASE_PROFILE_NAME && !profiles[inherited]) {
			return `profiles.${profileName}.inherits-from references unknown profile ${JSON.stringify(inherited)}`;
		}
	}

	const activeProfile = normalizeProfileName(policy.activeProfile);
	if (activeProfile && activeProfile !== BASE_PROFILE_NAME && !profiles[activeProfile]) {
		return `activeProfile references unknown profile ${JSON.stringify(activeProfile)}`;
	}

	const visited = new Set<string>();
	const stack = new Set<string>();
	const visit = (profileName: string): string | undefined => {
		if (visited.has(profileName)) return undefined;
		if (stack.has(profileName)) return `circular profile inheritance detected at ${JSON.stringify(profileName)}`;
		stack.add(profileName);
		const profile = profiles[profileName];
		const parent = normalizeProfileName(profile?.["inherits-from"]) ?? BASE_PROFILE_NAME;
		if (parent !== BASE_PROFILE_NAME) {
			const error = visit(parent);
			if (error) return error;
		}
		stack.delete(profileName);
		visited.add(profileName);
		return undefined;
	};

	for (const profileName of Object.keys(profiles)) {
		const error = visit(profileName);
		if (error) return error;
	}

	return undefined;
}

function loadPolicy(policyPath: string, schemaPath: string): LoadedPolicy {
	let rawPolicy: unknown;
	try {
		rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			policyPath,
			schemaPath,
			error: `failed to load gate policy: ${message}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	let schema: JsonSchemaNode;
	try {
		schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as JsonSchemaNode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			policy: isPlainObject(rawPolicy) ? (rawPolicy as RawPolicy) : undefined,
			policyPath,
			schemaPath,
			error: `schema validation failed! failed to load ${path.basename(schemaPath)}: ${message}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	const schemaError = validatePolicySchema(schema, rawPolicy);
	if (schemaError) {
		return {
			policy: isPlainObject(rawPolicy) ? (rawPolicy as RawPolicy) : undefined,
			policyPath,
			schemaPath,
			error: `schema validation failed! ${schemaError}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	const policy = rawPolicy as RawPolicy;
	const semanticError = validatePolicySemantics(policy);
	if (semanticError) {
		return {
			policy,
			policyPath,
			schemaPath,
			error: `policy validation failed! ${semanticError}. Tool calls are blocked until the gate policy is fixed.`,
		};
	}

	return { policy, policyPath, schemaPath };
}

function appendPermissionConfig(
	accumulator: { globalActions: PermissionAction[]; subjects: Record<string, Array<{ action: PermissionAction; rawPattern: string }>> },
	config: PermissionConfig | undefined,
): void {
	if (!config) return;
	if (typeof config === "string") {
		accumulator.globalActions.push(config);
		return;
	}

	for (const [subject, rule] of Object.entries(config)) {
		if (subject === "*") {
			if (typeof rule === "string") accumulator.globalActions.push(rule);
			continue;
		}
		const target = accumulator.subjects[subject] ?? (accumulator.subjects[subject] = []);
		if (typeof rule === "string") {
			target.push({ action: rule, rawPattern: "*" });
			continue;
		}
		for (const [pattern, action] of Object.entries(rule)) {
			target.push({ action, rawPattern: pattern });
		}
	}
}

function compilePattern(subject: string, rawPattern: string, cwd: string): CompiledPatternRule {
	let expandedPattern = normalizeSlashes(rawPattern);
	if (subject === "bash") {
		expandedPattern = normalizeCommand(expandedPattern);
	} else if (isPathSubject(subject)) {
		expandedPattern = expandPatternValue(expandedPattern, cwd);
	}
	return {
		action: "allow",
		expandedPattern,
		rawPattern,
		regex: wildcardToRegex(expandedPattern),
	};
}

function getProfileLineage(policy: RawPolicy, requestedProfileName: string): RawProfile[] {
	if (requestedProfileName === BASE_PROFILE_NAME) return [];
	const profiles = policy.profiles ?? {};
	const lineage: RawProfile[] = [];
	const seen = new Set<string>();
	const collect = (profileName: string) => {
		if (seen.has(profileName)) throw new Error(`circular profile inheritance detected at ${JSON.stringify(profileName)}`);
		const profile = profiles[profileName];
		if (!profile) throw new Error(`unknown profile ${JSON.stringify(profileName)}`);
		seen.add(profileName);
		const parent = normalizeProfileName(profile["inherits-from"]) ?? BASE_PROFILE_NAME;
		if (parent !== BASE_PROFILE_NAME) collect(parent);
		lineage.push(profile);
		seen.delete(profileName);
	};
	collect(requestedProfileName);
	return lineage;
}

function getProfileLayers(policy: RawPolicy, requestedProfileName: string): Array<PermissionConfig | undefined> {
	return [BUILTIN_PERMISSION, policy.permission, ...getProfileLineage(policy, requestedProfileName).map((profile) => profile.permission)];
}

function resolveProfileOptions(policy: RawPolicy, requestedProfileName: string): ResolvedProfileOptions {
	let unattended = false;
	for (const profile of getProfileLineage(policy, requestedProfileName)) {
		if (typeof profile.unattended === "boolean") unattended = profile.unattended;
	}
	return { unattended };
}

function mergePermissionLayers(layers: Array<PermissionConfig | undefined>): MergedPermissionConfig {
	const merged: MergedPermissionConfig = {
		globalActions: [],
		subjects: {},
	};
	for (const layer of layers) appendPermissionConfig(merged, layer);
	return merged;
}

function validateUnattendedProfile(policy: RawPolicy, requestedProfileName: string): string | undefined {
	if (!resolveProfileOptions(policy, requestedProfileName).unattended) return undefined;
	const merged = mergePermissionLayers(getProfileLayers(policy, requestedProfileName));
	if (merged.globalActions.at(-1) === "ask") {
		return `profiles.${requestedProfileName}.permission.* uses "ask", but unattended profiles only allow "allow" and "deny"`;
	}
	for (const [subject, rules] of Object.entries(merged.subjects)) {
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (!rule || rule.action !== "ask") continue;
			const shadowed = rules.slice(i + 1).some((later) =>
				later.action !== "ask" && (later.rawPattern === "*" || later.rawPattern === rule.rawPattern)
			);
			if (!shadowed) {
				return `profiles.${requestedProfileName}.permission.${subject}.${JSON.stringify(rule.rawPattern)} uses "ask", but unattended profiles only allow "allow" and "deny"`;
			}
		}
	}
	return undefined;
}

function compilePolicy(policy: RawPolicy, cwd: string, requestedProfileName: string): CompiledPolicy {
	const options = resolveProfileOptions(policy, requestedProfileName);
	const merged = mergePermissionLayers(getProfileLayers(policy, requestedProfileName));

	const subjects: Record<string, CompiledPatternRule[]> = {};
	for (const [subject, rawRules] of Object.entries(merged.subjects)) {
		subjects[subject] = rawRules.map((rule) => {
			const compiled = compilePattern(subject, rule.rawPattern, cwd);
			return {
				...compiled,
				action: rule.action,
			};
		});
	}

	return {
		profileName: requestedProfileName === BASE_PROFILE_NAME ? "base" : requestedProfileName,
		requestedProfileName,
		globalActions: merged.globalActions,
		subjects,
		unattended: options.unattended,
	};
}

function resolveGlobalAction(policy: CompiledPolicy): PermissionAction {
	return policy.globalActions[policy.globalActions.length - 1] ?? "allow";
}

function pickMoreRestrictive(left: PermissionAction, right: PermissionAction): PermissionAction {
	return ACTION_PRIORITY[right] > ACTION_PRIORITY[left] ? right : left;
}

function evaluateSubject(policy: CompiledPolicy, subject: string, groups: CandidateGroup[]): Decision {
	const rules = policy.subjects[subject] ?? [];
	let finalAction: PermissionAction = "allow";
	const reasons: string[] = [];

	for (const group of groups) {
		let action = resolveGlobalAction(policy);
		let matchedPattern: string | undefined;
		for (const rule of rules) {
			if (group.values.some((value) => rule.regex.test(value))) {
				action = rule.action;
				matchedPattern = rule.rawPattern;
			}
		}
		if (action !== "allow") {
			reasons.push(
				matchedPattern
					? `${subject} ${action}: ${group.display} (matched ${JSON.stringify(matchedPattern)})`
					: `${subject} ${action}: ${group.display}`,
			);
		}
		finalAction = pickMoreRestrictive(finalAction, action);
	}

	return { action: finalAction, reasons };
}

function annotateDecisionReasons(policy: CompiledPolicy, decision: Decision): string[] {
	return decision.reasons.map((reason) => `[${policy.profileName}] ${reason}`);
}

function evaluateSubjectAcrossLineage(effective: EffectiveGatePolicy, subject: string, groups: CandidateGroup[]): Decision {
	let finalAction: PermissionAction = "allow";
	const reasons: string[] = [];
	for (const policy of effective.lineage) {
		const decision = evaluateSubject(policy, subject, groups);
		finalAction = pickMoreRestrictive(finalAction, decision.action);
		reasons.push(...annotateDecisionReasons(policy, decision));
	}
	return { action: finalAction, reasons };
}

function evaluateExternalDirectory(policy: CompiledPolicy, absPaths: string[], cwd: string): Decision {
	const groups = buildExternalDirectoryGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, "external_directory", groups);
}

function evaluateExternalDirectoryAcrossLineage(effective: EffectiveGatePolicy, absPaths: string[], cwd: string): Decision {
	const groups = buildExternalDirectoryGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubjectAcrossLineage(effective, "external_directory", groups);
}

function evaluateAbsolutePaths(policy: CompiledPolicy, subject: string, absPaths: string[], cwd: string): Decision {
	const groups = buildAbsolutePathGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, subject, groups);
}

function evaluateAbsolutePathsAcrossLineage(effective: EffectiveGatePolicy, subject: string, absPaths: string[], cwd: string): Decision {
	const groups = buildAbsolutePathGroups(absPaths, cwd);
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubjectAcrossLineage(effective, subject, groups);
}

interface ProfileBashEvaluation {
	decision: Decision;
	normalizedCommand: string;
	analysis: MutationAnalysis;
	pathCandidates: string[];
}

function evaluateProfileBashCommand(effective: EffectiveGatePolicy, command: string, cwd: string): ProfileBashEvaluation {
	const normalizedCommand = normalizeCommand(command);
	const commandDecision = evaluateSubjectAcrossLineage(effective, "bash", [{ display: normalizedCommand || "<empty command>", values: [normalizedCommand] }]);
	const analysis = extractMutationTargets(command, cwd);
	const reasons = [...commandDecision.reasons];
	let pathDecision: Decision = { action: "allow", reasons: [] };
	let externalDecision: Decision = { action: "allow", reasons: [] };
	let pathCandidates: string[] = [];

	if (commandDecision.action !== "deny" && analysis.mutating) {
		pathCandidates = analysis.paths.length > 0 ? analysis.paths : analysis.inferredCwdTarget ? [normalizeAbsPath(cwd)] : [];
		if (pathCandidates.length === 0) {
			pathDecision = { action: "ask", reasons: [`bash ask: ${analysis.reason}`] };
		} else {
			externalDecision = evaluateExternalDirectoryAcrossLineage(effective, pathCandidates, cwd);
			pathDecision = evaluateAbsolutePathsAcrossLineage(effective, "edit", pathCandidates, cwd);
		}
	}

	reasons.push(...externalDecision.reasons, ...pathDecision.reasons);
	let finalAction = commandDecision.action;
	finalAction = pickMoreRestrictive(finalAction, externalDecision.action);
	finalAction = pickMoreRestrictive(finalAction, pathDecision.action);
	if (analysis.mutating && finalAction === "allow" && analysis.paths.length === 0 && !analysis.inferredCwdTarget) {
		finalAction = "ask";
		reasons.push(`bash ask: ${analysis.reason}`);
	}
	if (analysis.complex && finalAction === "allow") {
		finalAction = "ask";
		reasons.push("bash ask: complex shell command requires review");
	}

	return {
		decision: { action: finalAction, reasons },
		normalizedCommand,
		analysis,
		pathCandidates,
	};
}

function extractPathStrings(input: Record<string, unknown>, fields: string[]): string[] {
	const paths: string[] = [];
	for (const field of fields) {
		const value = input[field];
		if (typeof value === "string") paths.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") paths.push(item);
			}
		}
	}
	return paths;
}

function getToolPermissionSubject(toolName: string): string {
	switch (toolName) {
		case "write":
		case "apply_migration":
			return "edit";
		case "find":
			return "glob";
		case "ls":
			return "list";
		default:
			return toolName;
	}
}

const SEMANTIC_GENERIC_TOOL_NAMES = new Set(["vars"]);

function getGenericToolSubjectGroups(toolName: string, input: Record<string, unknown>): CandidateGroup[] {
	const values = new Set<string>([toolName]);
	const action = input.action;
	if (typeof action === "string" && action.trim()) values.add(`${toolName}:${action.trim()}`);
	const key = input.key;
	if (typeof key === "string" && key.trim()) values.add(`${toolName}:key:${key.trim()}`);
	const pathValue = input.path;
	if (typeof pathValue === "string" && pathValue.trim()) values.add(`${toolName}:path:${normalizeSlashes(pathValue.trim())}`);
	return [{ display: `${toolName} ${JSON.stringify(boundedJson(input, 500))}`, values: Array.from(values) }];
}

function getToolSubjectGroups(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): CandidateGroup[] {
	switch (toolName) {
		case "read": {
			const rawPath = typeof input.path === "string" ? input.path : "";
			return rawPath ? [buildPathCandidateGroup(rawPath, ctx.cwd)] : [];
		}
		case "write":
		case "edit":
		case "apply_migration": {
			return extractPathStrings(input, toolName === "apply_migration" ? ["path", "backupPath"] : ["path"])
				.map((rawPath) => buildPathCandidateGroup(rawPath, ctx.cwd));
		}
		case "ls": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [buildPathCandidateGroup(rawPath, ctx.cwd)];
		}
		case "find": {
			const pattern = typeof input.pattern === "string" ? normalizeSlashes(input.pattern) : "";
			return [{ display: pattern || "<empty glob>", values: [pattern] }];
		}
		case "grep": {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			return [{ display: pattern || "<empty pattern>", values: [pattern] }];
		}
		default:
			return [];
	}
}

function extractGenericPathCandidates(input: Record<string, unknown>, ctx: ExtensionContext): string[] {
	const pathLike = /(^|_)(path|file|filename|source|target|destination|backupPath)(_|$)/i;
	const values: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (!pathLike.test(key)) continue;
		if (typeof value === "string") values.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") values.push(item);
			}
		}
	}
	return values.map((value) => normalizePathArg(value, ctx.cwd));
}

function getToolPathCandidates(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): string[] {
	switch (toolName) {
		case "read":
			return typeof input.path === "string" ? [normalizePathArg(input.path, ctx.cwd)] : [];
		case "write":
		case "edit":
			return extractPathStrings(input, ["path"]).map((value) => normalizePathArg(value, ctx.cwd));
		case "apply_migration":
			return extractPathStrings(input, ["path", "backupPath"]).map((value) => normalizePathArg(value, ctx.cwd));
		case "ls": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [normalizePathArg(rawPath, ctx.cwd)];
		}
		case "find":
		case "grep": {
			const rawPath = typeof input.path === "string" && input.path.trim() ? input.path : ctx.cwd;
			return [normalizePathArg(rawPath, ctx.cwd)];
		}
		default:
			return extractGenericPathCandidates(input, ctx);
	}
}

function isIgnorableRedirectionTarget(candidate: string): boolean {
	const normalized = normalizeAbsPath(candidate);
	return normalized === "/dev/null" || normalized === "/dev/stdout" || normalized === "/dev/stderr" || normalized === "/dev/tty";
}

function isComplexShellCommand(analysis: ConservativeShellAnalysis): boolean {
	return !analysis.tokens || analysis.hasSubstitution || analysis.hasControlOperator;
}

function normalizeShellToken(token: string): string {
	return token.replace(/^[;()]+/, "").replace(/[;()]+$/, "");
}

function isShellSeparator(token: string): boolean {
	return SHELL_SEPARATOR_TOKENS.has(token);
}

function collectComplexCommandArgs(tokens: string[], start: number): string[] {
	const args: string[] = [];
	for (let i = start; i < tokens.length; i++) {
		const raw = normalizeShellToken(tokens[i] ?? "");
		if (!raw) continue;
		if (isShellSeparator(raw)) break;
		args.push(raw);
	}
	return args;
}

function extractComplexMutationTargets(tokens: string[], cwd: string): MutationAnalysis {
	const candidates = new Set<string>();
	let inferredCwdTarget = false;

	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		if ((token === ">" || token === ">>") && tokens[i + 1]) {
			const redirected = normalizePathArg(normalizeShellToken(tokens[i + 1]!), cwd);
			if (!isIgnorableRedirectionTarget(redirected)) candidates.add(redirected);
		}
	}

	const collectPaths = (values: string[]) => {
		for (const value of values) {
			if (!value || value === ">" || value === ">>") continue;
			candidates.add(normalizePathArg(value, cwd));
		}
	};

	for (let i = 0; i < tokens.length; i++) {
		const primary = normalizeShellToken(tokens[i] ?? "");
		const secondary = normalizeShellToken(tokens[i + 1] ?? "");
		if (!primary || isShellSeparator(primary)) continue;

		const args = collectComplexCommandArgs(tokens, i + 1);
		if (["rm", "rmdir", "mkdir", "touch", "tee", "ln", "install"].includes(primary)) {
			collectPaths(args.filter((token) => !token.startsWith("-")));
			continue;
		}
		if (["mv", "cp"].includes(primary)) {
			collectPaths(args.filter((token) => !token.startsWith("-")));
			continue;
		}
		if (["chmod", "chown"].includes(primary)) {
			const nonOptions = args.filter((token) => !token.startsWith("-"));
			collectPaths(nonOptions.slice(1));
			continue;
		}
		if (primary === "git" && secondary === "clean") {
			const gitArgs = collectComplexCommandArgs(tokens, i + 2);
			const pathspecs = gitArgs.filter((token) => !token.startsWith("-"));
			if (pathspecs.length > 0) collectPaths(pathspecs);
			else inferredCwdTarget = true;
			continue;
		}
		if (primary === "find") {
			const deleteIndex = args.findIndex((token) => token === "-delete");
			if (deleteIndex >= 0) {
				const pathTokens = args.filter((token, index) => index < deleteIndex && !token.startsWith("-"));
				if (pathTokens.length > 0) collectPaths(pathTokens);
				else inferredCwdTarget = true;
			}
			continue;
		}
	}

	return {
		mutating: true,
		complex: true,
		paths: Array.from(candidates),
		inferredCwdTarget,
		reason:
			candidates.size > 0 || inferredCwdTarget
				? "complex shell command with extracted mutation targets"
				: "complex shell command without reliable target extraction",
	};
}

function firstCommandIndex(tokens: string[]): number {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
			index++;
			continue;
		}
		if (token === "env") {
			index++;
			continue;
		}
		break;
	}
	return index;
}

function collectNonOptionArgs(tokens: string[], start: number): string[] {
	return tokens.slice(start).filter((token) => token !== ">" && token !== ">>" && !token.startsWith("-"));
}

function hasMutatingAwkPattern(command: string): boolean {
	if (!/\bawk\b/i.test(command)) return false;
	return /\bsystem\s*\(/i.test(command) || /\bprint\b[\s\S]*>>?/i.test(command);
}

function getUnknownExecutableReason(tokens: string[] | undefined): string | undefined {
	if (!tokens || tokens.length === 0) return undefined;
	const commandIndex = firstCommandIndex(tokens);
	const primary = normalizeShellToken(tokens[commandIndex] ?? "");
	if (!primary) return undefined;
	if (primary.startsWith("./") || primary.startsWith("../")) return "unknown local executable; side effects unknown";
	if (primary.includes("/") && !primary.startsWith("/bin/") && !primary.startsWith("/usr/bin/")) return "unknown executable path; side effects unknown";
	return undefined;
}

export function extractMutationTargets(command: string, cwd: string): MutationAnalysis {
	const lower = command.toLowerCase();
	const shellAnalysis = analyzeShellCommand(command);
	const tokens = shellAnalysis.tokens;
	const tokenizedFindDelete = tokens?.some((token, index) =>
		normalizeShellToken(token).toLowerCase() === "find"
		&& tokens.slice(index + 1).some((arg) => normalizeShellToken(arg) === "-delete")
	) ?? false;
	const mutating = /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btee\b|\bln\b|\binstall\b|\bchmod\b|\bchown\b|\bfind\b[^\n]*\s-delete\b|\bgit\s+clean\b|>|\bsed\b[^\n]*\s-i|\bperl\b[^\n]*\s-pi/.test(lower)
		|| tokenizedFindDelete
		|| hasMutatingAwkPattern(command);
	const complex = isComplexShellCommand(shellAnalysis);
	if (!mutating) {
		return { mutating: false, complex, paths: [], inferredCwdTarget: false, reason: getUnknownExecutableReason(tokens) ?? "read-only command" };
	}

	if (complex && tokens && tokens.length > 0) {
		return extractComplexMutationTargets(tokens, cwd);
	}
	if (!tokens || tokens.length === 0) {
		return { mutating: true, complex: false, paths: [], inferredCwdTarget: false, reason: "could not parse command" };
	}

	const candidates = new Set<string>();
	let inferredCwdTarget = false;
	for (let i = 0; i < tokens.length - 1; i++) {
		if ((tokens[i] === ">" || tokens[i] === ">>") && tokens[i + 1]) {
			const redirected = normalizePathArg(tokens[i + 1]!, cwd);
			if (!isIgnorableRedirectionTarget(redirected)) candidates.add(redirected);
		}
	}

	const commandIndex = firstCommandIndex(tokens);
	const primary = tokens[commandIndex];
	const secondary = tokens[commandIndex + 1];
	if (!primary) {
		return { mutating: true, complex: false, paths: Array.from(candidates), inferredCwdTarget: false, reason: "missing command token" };
	}

	const args = tokens.slice(commandIndex + 1);
	const collectPaths = (rawValues: string[]) => {
		for (const value of rawValues) {
			if (!value || value === ">" || value === ">>") continue;
			candidates.add(normalizePathArg(value, cwd));
		}
	};

	if (primary === "git" && secondary === "clean") {
		const pathspecs = collectNonOptionArgs(tokens, commandIndex + 2);
		if (pathspecs.length > 0) collectPaths(pathspecs);
		else inferredCwdTarget = true;
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget,
			reason: inferredCwdTarget ? "git clean in current working directory" : "git clean pathspecs",
		};
	}

	if (primary === "find") {
		const deleteIndex = args.findIndex((token) => token === "-delete");
		if (deleteIndex >= 0) {
			const pathTokens = args.filter((token, index) => index < deleteIndex && !token.startsWith("-"));
			if (pathTokens.length > 0) collectPaths(pathTokens);
			else inferredCwdTarget = true;
		}
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget,
			reason: inferredCwdTarget ? "find -delete in current working directory" : "find -delete targets",
		};
	}

	if (["rm", "rmdir", "mkdir", "touch", "tee", "ln", "install"].includes(primary)) {
		collectPaths(args.filter((token) => !token.startsWith("-")));
	} else if (["mv", "cp"].includes(primary)) {
		collectPaths(args.filter((token) => !token.startsWith("-")));
	} else if (["chmod", "chown"].includes(primary)) {
		const nonOptions = args.filter((token) => !token.startsWith("-"));
		collectPaths(nonOptions.slice(1));
	} else if (primary === "sed" && args.some((token) => token.startsWith("-i"))) {
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget: false,
			reason: "sed -i without reliable path extraction",
		};
	} else if (primary === "perl" && args.some((token) => token.includes("-pi"))) {
		return {
			mutating: true,
			complex: false,
			paths: Array.from(candidates),
			inferredCwdTarget: false,
			reason: "perl -pi without reliable path extraction",
		};
	}

	return {
		mutating: true,
		complex: false,
		paths: Array.from(candidates),
		inferredCwdTarget,
		reason: candidates.size > 0 ? "extracted mutation targets" : "could not determine mutation target",
	};
}

function buildBashSessionKey(command: string): string {
	return `bash:${normalizeCommand(command)}`;
}

interface PolicyBashComposite {
	segments?: string[];
	error?: string;
}

function isSafePipefailPrologue(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens[0] !== "set" || tokens.length < 3) return false;
	let sawPipefail = false;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (/^-[eEu]+$/.test(token)) continue;
		if (token === "-o" || /^-[eEu]+o$/.test(token)) {
			if (tokens[index + 1] !== "pipefail") return false;
			sawPipefail = true;
			index++;
			continue;
		}
		return false;
	}
	return sawPipefail;
}

function analyzePolicyBashComposite(command: string): PolicyBashComposite | undefined {
	const rawLooksComposite = /&&|\|/.test(command);
	const parsed = parseConservativeShellPipeline(command);
	if (!parsed) return rawLooksComposite ? { error: "unparseable shell composite requires review" } : undefined;
	const hasAnd = parsed.operators.includes("&&");
	const hasPipeline = parsed.operators.includes("|") || parsed.operators.includes("|&");
	if (!hasAnd && !hasPipeline) return undefined;
	if (parsed.segments.length < 2) return { error: "unparseable shell composite requires review" };
	const segments = [...parsed.segments];
	if (hasPipeline && isSafePipefailPrologue(segments[0] ?? "")) segments.shift();
	return segments.length > 0 ? { segments } : { error: "shell composite has no commands to review" };
}

function getChainUnsafeShellSegmentReason(command: string): string | undefined {
	const tokens = tokenizeShellCommand(command);
	if (!tokens || tokens.length === 0) return "unparseable chain component requires review";
	const commandIndex = firstCommandIndex(tokens);
	const primary = normalizeShellToken(tokens[commandIndex] ?? "");
	const secondary = normalizeShellToken(tokens[commandIndex + 1] ?? "");
	if (!primary) return "shell assignment chain components require review";
	const cwdUnsafeBuiltins = new Set(["cd", "pushd", "popd", "source", ".", "eval"]);
	let wrapped = secondary;
	if (primary === "builtin" || primary === "command") {
		let wrappedIndex = commandIndex + 1;
		while (wrappedIndex < tokens.length) {
			const token = normalizeShellToken(tokens[wrappedIndex] ?? "");
			if (token === "--" || token.startsWith("-")) {
				wrappedIndex++;
				continue;
			}
			wrapped = token;
			break;
		}
	}
	if (cwdUnsafeBuiltins.has(primary) || ((primary === "builtin" || primary === "command") && cwdUnsafeBuiltins.has(wrapped))) {
		return "cwd-changing chain components require review";
	}
	const shellStateBuiltins = new Set(["alias", "unalias", "declare", "enable", "export", "local", "readonly", "set", "shopt", "typeset", "unset"]);
	if (shellStateBuiltins.has(primary)) return "shell-state-changing chain components require review";
	if (primary.startsWith("~") || primary.includes("/")) return "path-like command chain components require review";
	return undefined;
}

function buildPathSessionKey(subject: string, values: string[]): string {
	return `${subject}:${[...values].sort().join("|")}`;
}

function displayStatusPath(cwd: string, value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizeAbsPath(value);
	const cwdPath = normalizeAbsPath(cwd);
	const homePath = normalizeAbsPath(os.homedir());
	if (isWithinRoot(cwdPath, normalized)) return normalizeSlashes(path.relative(cwdPath, normalized) || ".");
	if (isWithinRoot(homePath, normalized)) return `~/${normalizeSlashes(path.relative(homePath, normalized))}`;
	return value;
}

function formatGateAutoStatusMessage(ctx: ExtensionContext, status: ReturnType<GateAutoApproverManager["status"]>, startOnSession: boolean, runtimeEnabled: boolean): string {
	const configured = status.backendType === "pi-model" ? Boolean(status.provider && status.model) : Boolean(status.endpoint || (status.serverPath && status.modelPath));
	const loadedSemantic = loadGateSemanticConfig(path.dirname(fileURLToPath(import.meta.url)), ctx.cwd);
	const lines = [
		`Gate auto: ${status.enabled ? runtimeEnabled ? "on" : "configured, not running" : "off"}`,
		`Config: ${displayStatusPath(ctx.cwd, loadedSemantic.configPath)}`,
		`Backend: ${status.backendType ?? "managed-llama"}`,
	];
	if (runtimeEnabled) {
		lines.push(`Runtime: ${status.healthy ? "ready" : "not ready"}${status.mode !== "disabled" ? ` (${status.mode}${status.pid ? `, pid ${status.pid}` : ""})` : ""}`);
		if (status.endpoint) lines.push(`Endpoint: ${status.endpoint}`);
	} else if (status.enabled) {
		lines.push(status.backendType === "pi-model" ? "Runtime: stopped (run /gate auto on to validate model access)" : "Runtime: stopped (run /gate auto on to start)");
	}
	if (status.enabled || startOnSession) lines.push(`Starts on Pi launch: ${startOnSession ? "yes" : "no"}`);
	if (configured) {
		if (status.backendType === "pi-model") {
			lines.push(`Provider: ${status.provider}`);
			lines.push(`Model: ${status.model}`);
			lines.push(`Thinking: ${status.thinking ?? "off"}`);
			lines.push(`Cache: provider-dependent`);
			lines.push("Privacy: full Gate auto semantic context is sent to this provider.");
		} else {
			if (status.serverPath) lines.push(`Server: ${displayStatusPath(ctx.cwd, status.serverPath)}`);
			if (status.modelPath) lines.push(`Model: ${displayStatusPath(ctx.cwd, status.modelPath)}`);
		}
	} else {
		lines.push("Setup: not configured (run /gate auto setup)");
	}
	if (status.migrationNotice) lines.push(`Migration: ${status.migrationNotice}`);
	if (runtimeEnabled && status.auditPath) lines.push(`Audit: ${displayStatusPath(ctx.cwd, status.auditPath)}`);
	if (loadedSemantic.error) lines.push(`Problem: ${loadedSemantic.error}`);
	if (status.lastError) lines.push(`Runtime problem: ${status.lastError}`);
	return lines.join("\n");
}

function updateStatus(
	ctx: ExtensionContext,
	profileName: string | undefined,
	sessionAllows: Set<string>,
	yolo = false,
	locked = false,
	autoEnabled = false,
): void {
	if (!ctx.hasUI) return;
	if (yolo) {
		ctx.ui.setStatus(SESSION_STATUS_KEY, GATE_ERROR_STATUS);
		return;
	}
	const lockSuffix = locked ? "🔒" : "";
	const autoSuffix = autoEnabled ? " \u001b[1;38;2;247;207;5mauto\u001b[0m" : "";
	const sessionSuffix = sessionAllows.size > 0 ? ` +${sessionAllows.size}` : "";
	ctx.ui.setStatus(SESSION_STATUS_KEY, `gate:${profileName ?? "base"}${lockSuffix}${autoSuffix}${sessionSuffix}`);
}

async function confirmDecision(
	ctx: ExtensionContext,
	title: string,
	message: string,
	sessionKey: string,
	sessionAllows: Set<string>,
	profileName: string,
	locked = false,
	autoEnabled = false,
): Promise<{ allow: boolean; sessionStored: boolean }> {
	if (!ctx.hasUI) return { allow: false, sessionStored: false };
	const choices = autoEnabled ? ["Allow once", "Deny"] : ["Allow once", "Allow for session", "Deny"];
	const choice = await ctx.ui.select(`${title}\n\n${message}`, choices);
	if (choice === "Allow once") return { allow: true, sessionStored: false };
	if (!autoEnabled && choice === "Allow for session") {
		// Cap at MAX_SESSION_ALLOWS to prevent unbounded memory growth.
		if (sessionAllows.size >= MAX_SESSION_ALLOWS) sessionAllows.clear();
		sessionAllows.add(sessionKey);
		updateStatus(ctx, profileName, sessionAllows, false, locked, autoEnabled);
		return { allow: true, sessionStored: true };
	}
	return { allow: false, sessionStored: false };
}

function pickReason(reasons: string[], action: PermissionAction, fallback: string): string {
	return reasons.find((reason) => reason.includes(` ${action}:`)) ?? reasons[0] ?? fallback;
}

function hashSessionKey(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedJson(value: unknown, maxChars = 2000): unknown {
	try {
		const text = JSON.stringify(value);
		if (text.length <= maxChars) return value;
		return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
	} catch {
		return "<unserializable>";
	}
}

interface GateAskDecisionInput {
	ctx: ExtensionContext;
	effective: EffectiveGatePolicy;
	event: { toolName: string; input: unknown };
	title: string;
	message: string;
	sessionKey: string;
	reasons: string[];
	fallbackDenyReason: string;
	subject: string;
	pathCandidates?: string[];
	bash?: {
		command: string;
		normalizedCommand: string;
		analysis: MutationAnalysis;
	};
}

function buildAutoApprovalRequest(input: GateAskDecisionInput): GateAutoApprovalRequest {
	return {
		requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		profileName: input.effective.profileName,
		lineageNames: input.effective.lineageNames,
		cwd: input.ctx.cwd,
		unattended: input.effective.unattended,
		toolName: input.event.toolName,
		subject: input.subject,
		sessionKeyHash: hashSessionKey(input.sessionKey),
		reasons: input.reasons,
		inputSummary: boundedJson(input.event.input),
		pathCandidates: input.pathCandidates,
		bash: input.bash,
	};
}

function normalizeSemanticRoleName(value: string): string {
	return value.trim().toLowerCase() || "base";
}

function getSemanticRole(effective: EffectiveGatePolicy): { roleType: GateSemanticRoleType; roleName: string } {
	const subagentName = process.env.PI_GATE_SUBAGENT_AGENT;
	if (subagentName?.trim()) return { roleType: "subagent", roleName: normalizeSemanticRoleName(subagentName) };
	return { roleType: "agent", roleName: normalizeSemanticRoleName(effective.profileName) };
}

function buildGateSemanticRequest(input: GateAskDecisionInput, evaluation: GateSemanticEvaluation, match?: { hardDeny?: GateSemanticMatch; alwaysAllow?: GateSemanticMatch }): GateSemanticRequest {
	return {
		...buildAutoApprovalRequest(input),
		roleType: evaluation.role.roleType,
		roleName: evaluation.role.roleName,
		guidance: evaluation.role.guidance,
		matchedHardDeny: match?.hardDeny,
		matchedAlwaysAllow: match?.alwaysAllow,
	};
}

interface GateAutoBlockState {
	consecutive: number;
	total: number;
	paused: boolean;
}

function resetAutoBlockState(state: GateAutoBlockState): void {
	state.consecutive = 0;
	state.total = 0;
	state.paused = false;
}

function truncateSetupOutput(value: string): string {
	if (value.length <= GATE_AUTO_SETUP_MAX_OUTPUT_CHARS) return value;
	return `${value.slice(0, GATE_AUTO_SETUP_MAX_OUTPUT_CHARS)}\n[truncated ${value.length - GATE_AUTO_SETUP_MAX_OUTPUT_CHARS} chars]`;
}

interface GateAutoSetupWriteResult {
	scope: "project" | "global";
	configPath: string;
}

export function setGateAutoBackendFromSetup(ctx: Pick<ExtensionContext, "cwd">, backend: Record<string, unknown>): GateAutoSetupWriteResult {
	setVar(ctx.cwd, "gate.auto.backend", backend);
	const state = setVar(ctx.cwd, "gate.auto.timeoutMs", 4000);
	return { scope: state.writeLocation, configPath: state.configPath };
}

interface ConfiguredPiModelChoice {
	provider: string;
	model: string;
	display: string;
}

function listConfiguredPiModels(): ConfiguredPiModelChoice[] {
	const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as { providers?: Record<string, { models?: Array<{ id?: unknown; name?: unknown }> }> };
		const out: ConfiguredPiModelChoice[] = [];
		for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
			for (const model of config.models ?? []) {
				if (typeof model.id !== "string" || !model.id.trim()) continue;
				const label = typeof model.name === "string" && model.name.trim() ? `${model.name} (${model.id})` : model.id;
				out.push({ provider, model: model.id, display: `${provider}/${label}` });
			}
		}
		return out.sort((a, b) => a.display.localeCompare(b.display));
	} catch {
		return [];
	}
}

function managedLlamaBackendConfig(setup: { serverPath: string; modelPath: string }): Record<string, unknown> {
	return {
		type: "managed-llama",
		serverPath: setup.serverPath,
		modelPath: setup.modelPath,
		host: "127.0.0.1",
		port: 0,
		parallel: 2,
		cachePrompt: true,
		startupTimeoutMs: 30000,
		responseFormat: "auto",
		enableThinking: false,
		warmup: true,
	};
}

function runGateAutoSetupScript(extensionDir: string, onChild?: (child: ChildProcessWithoutNullStreams) => void): Promise<{ installDir: string; serverPath: string; modelPath: string; modelSha256?: string }> {
	const packageRoot = path.resolve(extensionDir, "..", "..");
	const scriptPath = path.join(packageRoot, "scripts", "setup-gate-auto-approver.mjs");
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(scriptPath)) {
			reject(new Error(`setup script not found: ${scriptPath}`));
			return;
		}
		const child = spawn(process.execPath, [scriptPath, "--json"], { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
		onChild?.(child);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Best effort; close/error will settle the promise.
			}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Best effort.
				}
			}, 3000);
		}, GATE_AUTO_SETUP_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout = truncateSetupOutput(stdout + chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = truncateSetupOutput(stderr + chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (timedOut) {
				reject(new Error(`setup timed out after ${GATE_AUTO_SETUP_TIMEOUT_MS}ms`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`setup failed${signal ? ` signal=${signal}` : ` code=${code}`}\n${truncateSetupOutput([stderr, stdout].filter(Boolean).join("\n"))}`.trim()));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { installDir?: unknown; serverPath?: unknown; modelPath?: unknown; modelSha256?: unknown };
				if (typeof parsed.installDir !== "string" || typeof parsed.serverPath !== "string" || typeof parsed.modelPath !== "string") {
					throw new Error("setup JSON did not include installDir, serverPath, and modelPath");
				}
				resolve({ installDir: parsed.installDir, serverPath: parsed.serverPath, modelPath: parsed.modelPath, modelSha256: typeof parsed.modelSha256 === "string" ? parsed.modelSha256 : undefined });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reject(new Error(`setup completed but returned invalid JSON: ${message}\n${truncateSetupOutput(stdout)}`));
			}
		});
	});
}

function formatSemanticFallbackReason(result: GateSemanticResult | undefined): string | undefined {
	if (!result) return undefined;
	if (result.outcome === "blocked") return `Gate auto blocked: ${result.reason}`;
	if (result.outcome === "fallback_prompt") return `Gate auto requests review: ${result.reason}`;
	if (["timeout", "malformed", "unavailable", "error"].includes(result.outcome)) return `Gate auto unavailable: ${result.reason}`;
	return undefined;
}

function isSemanticSoftBlock(result: GateSemanticResult): boolean {
	return result.outcome === "blocked";
}

async function promptForAskDecision(
	input: GateAskDecisionInput,
	sessionAllows: Set<string>,
	profileLocked: boolean,
	autoEnabled: boolean,
	fallbackReason?: string,
): Promise<{ block?: boolean; reason?: string; allowed?: boolean }> {
	if (input.effective.unattended) {
		return {
			block: true,
			reason: `${fallbackReason ? `${fallbackReason}. ` : ""}${pickReason(input.reasons, "ask", input.fallbackDenyReason)}. Profile ${input.effective.profileName} is unattended and cannot prompt for approval.`,
		};
	}
	if (!input.ctx.hasUI) {
		return {
			block: true,
			reason: `${fallbackReason ? `${fallbackReason}. ` : ""}${pickReason(input.reasons, "ask", `${input.fallbackDenyReason} but no UI is available`)}`,
		};
	}
	const result = await confirmDecision(
		input.ctx,
		input.title,
		[fallbackReason, input.message].filter(Boolean).join("\n\n"),
		input.sessionKey,
		sessionAllows,
		input.effective.profileName,
		profileLocked,
		autoEnabled,
	);
	if (result.allow) return { allowed: true };
	return { block: true, reason: pickReason(input.reasons, "ask", input.fallbackDenyReason) };
}

async function resolveAskDecision(
	input: GateAskDecisionInput,
	sessionAllows: Set<string>,
	profileLocked: boolean,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, false);
	if (prompted.allowed) return undefined;
	return prompted;
}

async function resolveSemanticDecision(
	input: GateAskDecisionInput,
	evaluation: GateSemanticEvaluation,
	sessionAllows: Set<string>,
	profileLocked: boolean,
	autoManager: GateAutoApproverManager,
	autoBlockState: GateAutoBlockState,
	autoRuntimeEnabled: boolean,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (evaluation.action === "block") {
		return { block: true, reason: `Gate auto hard-denied ${input.event.toolName}: ${evaluation.match.display} matched ${JSON.stringify(evaluation.match.pattern)}` };
	}
	if (evaluation.action === "allow") {
		const risk = assessGateRisk(buildAutoApprovalRequest(input));
		if (risk.recommendedDecision === "deny") {
			return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${risk.reason ?? "risk guard denied deterministic allow"}` };
		}
		if (risk.recommendedDecision === "escalate") {
			const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, `Gate auto deterministic allow requires review: ${risk.reason ?? "risk guard requested review"}`);
			if (prompted.allowed) return undefined;
			return prompted;
		}
		autoBlockState.consecutive = 0;
		return undefined;
	}

	const semanticRisk = assessGateRisk(buildAutoApprovalRequest(input));
	const readOnlySearchTool = input.event.toolName === "grep" || input.event.toolName === "find";
	const searchOnlySensitiveTerm = readOnlySearchTool && semanticRisk.flags.includes("credential_or_secret") && !hasSensitivePathCandidate(input.pathCandidates) && !hasSensitiveSearchTarget(input.event.input);
	if ((!searchOnlySensitiveTerm && semanticRisk.flags.includes("credential_or_secret")) || semanticRisk.flags.includes("broad_destructive")) {
		return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${semanticRisk.reason ?? "deterministic safety floor denied semantic review"}` };
	}

	let autoFallback: GateSemanticResult | undefined;
	if (autoRuntimeEnabled) await autoManager.refresh(input.ctx);
	if (autoRuntimeEnabled && autoManager.isEnabled()) {
		if (autoBlockState.paused) {
			const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, "Gate auto is paused after repeated blocks; approving resumes auto mode");
			if (prompted.allowed) {
				resetAutoBlockState(autoBlockState);
				return undefined;
			}
			return prompted;
		}
		const autoResult = await autoManager.decide(input.ctx, buildGateSemanticRequest(input, evaluation));
		if (autoResult.decision === "allow" && autoResult.outcome === "allowed") {
			autoBlockState.consecutive = 0;
			return undefined;
		}
		if (isSemanticSoftBlock(autoResult)) {
			autoBlockState.consecutive += 1;
			autoBlockState.total += 1;
			const fallbackReason = formatSemanticFallbackReason(autoResult);
			if (autoBlockState.consecutive >= AUTO_BLOCK_CONSECUTIVE_PROMPT_THRESHOLD || autoBlockState.total >= AUTO_BLOCK_TOTAL_PROMPT_THRESHOLD) {
				autoBlockState.paused = true;
				const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, true, `${fallbackReason}. Gate auto paused after ${autoBlockState.consecutive} consecutive / ${autoBlockState.total} total blocks; approving resumes auto mode`);
				if (prompted.allowed) {
					resetAutoBlockState(autoBlockState);
					return undefined;
				}
				return prompted;
			}
			return { block: true, reason: `Gate auto blocked ${input.event.toolName}: ${autoResult.reason}` };
		}
		autoFallback = autoResult;
	}

	const fallbackReason = formatSemanticFallbackReason(autoFallback);
	const prompted = await promptForAskDecision(input, sessionAllows, profileLocked, autoRuntimeEnabled && autoManager.isEnabled(), fallbackReason);
	if (prompted.allowed) return undefined;
	return prompted;
}

export default function piGate(pi: ExtensionAPI) {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const policyPath = path.join(extensionDir, "policy.json");
	const schemaPath = path.join(extensionDir, POLICY_SCHEMA_FILE);
	const loaded = loadPolicy(policyPath, schemaPath);
	const autoManager = new GateAutoApproverManager(pi);
	const autoBlockState: GateAutoBlockState = { consecutive: 0, total: 0, paused: false };
	let autoRuntimeEnabled = false;
	const sessionAllows = new Set<string>();
	const profileLocked = isEnvEnabled(process.env[GATE_PROFILE_LOCK_ENV]);
	let policyErrorShown = false;
	let selectedProfileOverride: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let pendingProfileSwitch: ProfileSwitchRequest | undefined;
	let activeAutoSetup: ChildProcessWithoutNullStreams | undefined;

	function resolveRequestedProfile(): string {
		return (
			normalizeProfileName(selectedProfileOverride)
			?? normalizeProfileName(process.env[GATE_PROFILE_ENV])
			?? normalizeProfileName(loaded.policy?.activeProfile)
			?? BASE_PROFILE_NAME
		);
	}

	function resolveLineageProfileNames(activeProfile: string): string[] {
		const raw = process.env[PI_GATE_PROFILE_LINEAGE_ENV];
		const names = raw
			? raw.split(",").map(normalizeProfileName).filter((entry): entry is string => Boolean(entry))
			: [];
		if (names.length === 0) names.push(activeProfile);
		if (!names.includes(activeProfile)) names.push(activeProfile);
		return names;
	}

	function getEffectivePolicy(cwd: string): { compiled?: EffectiveGatePolicy; error?: string } {
		if (loaded.error) return { error: loaded.error };
		if (!loaded.policy) return { error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		try {
			const activeProfile = resolveRequestedProfile();
			const lineageNames = resolveLineageProfileNames(activeProfile);
			const lineage = lineageNames.map((profileName) => compilePolicy(loaded.policy!, cwd, profileName));
			const active = lineage.find((policy) => policy.requestedProfileName === activeProfile)
				?? compilePolicy(loaded.policy, cwd, activeProfile);
			return {
				compiled: {
					active,
					lineage,
					lineageNames,
					profileName: active.profileName,
					unattended: active.unattended,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `policy resolution failed! ${message}. Tool calls are blocked until the gate policy is fixed.` };
		}
	}

	function scopeSessionKey(effective: EffectiveGatePolicy, sessionKey: string): string {
		return `profiles:${effective.lineageNames.join(">")}:${sessionKey}`;
	}

	function switchProfile(
		ctx: ExtensionContext,
		profileName: string,
		options?: { notify?: boolean },
	): { ok: true; compiled: CompiledPolicy } | { ok: false; error: string } {
		if (profileLocked) {
			return { ok: false, error: `Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}` };
		}
		if (loaded.error) return { ok: false, error: loaded.error };
		if (!loaded.policy) {
			return { ok: false, error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		}
		const normalizedProfile = normalizeProfileName(profileName) ?? BASE_PROFILE_NAME;
		if (normalizedProfile !== BASE_PROFILE_NAME && !loaded.policy.profiles?.[normalizedProfile]) {
			return { ok: false, error: `Gate: unknown profile ${profileName}` };
		}
		selectedProfileOverride = normalizedProfile;
		sessionAllows.clear();
		try {
			const compiled = compilePolicy(loaded.policy, ctx.cwd, normalizedProfile);
			updateStatus(ctx, compiled.profileName, sessionAllows, false, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
			if (options?.notify ?? true) {
				ctx.ui.notify(`Gate profile switched to ${compiled.profileName}`, "info");
			}
			return { ok: true, compiled };
		} catch (error) {
			selectedProfileOverride = undefined;
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Gate: ${message}` };
		}
	}

	function processProfileSwitchRequest(
		ctx: ExtensionContext,
		request: ProfileSwitchRequest,
	): { ok: true; queued: boolean } | { ok: false; error: string } {
		if (profileLocked) {
			return { ok: false, error: `Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}` };
		}
		if (loaded.error) return { ok: false, error: loaded.error };
		if (!loaded.policy) {
			return { ok: false, error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		}
		const normalizedProfile = normalizeProfileName(request.profile) ?? BASE_PROFILE_NAME;
		if (normalizedProfile !== BASE_PROFILE_NAME && !loaded.policy.profiles?.[normalizedProfile]) {
			return { ok: false, error: `Gate: unknown profile ${request.profile}` };
		}
		if (ctx.isIdle()) {
			const result = switchProfile(ctx, normalizedProfile, { notify: request.notify });
			if (!result.ok) return result;
			return { ok: true, queued: false };
		}
		pendingProfileSwitch = { ...request, profile: normalizedProfile };
		if (request.notify ?? true) {
			const from = request.source ? ` from ${request.source}` : "";
			ctx.ui.notify(`Gate will switch to ${normalizedProfile === BASE_PROFILE_NAME ? "base" : normalizedProfile}${from} when the current turn finishes`, "info");
		}
		return { ok: true, queued: true };
	}

	function flushPendingProfileSwitch(ctx: ExtensionContext): void {
		if (!pendingProfileSwitch) return;
		const request = pendingProfileSwitch;
		pendingProfileSwitch = undefined;
		const result = switchProfile(ctx, request.profile, { notify: request.notify });
		if (!result.ok) {
			ctx.ui.notify(result.error, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const autoConfig = loadGateAutoConfig(ctx.cwd);
		autoRuntimeEnabled = autoConfig.enabled && (autoConfig.startOnSession || (autoConfig.processKind === "subagent" && (Boolean(autoConfig.inheritedEndpoint) || autoConfig.backend.type === "pi-model")));
		if (autoRuntimeEnabled) await autoManager.refresh(ctx);
		else await autoManager.disable(ctx);
		const result = getEffectivePolicy(ctx.cwd);
		if (result.compiled) updateStatus(ctx, result.compiled.profileName, sessionAllows, false, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
		else updateStatus(ctx, undefined, sessionAllows, true, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
		if (result.error && ctx.hasUI && !policyErrorShown) {
			policyErrorShown = true;
			ctx.ui.notify(result.error, "warning");
		}
		flushPendingProfileSwitch(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		flushPendingProfileSwitch(ctx);
		const result = getEffectivePolicy(ctx.cwd);
		if (result.compiled) updateStatus(ctx, result.compiled.profileName, sessionAllows, false, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
	});

	pi.on("session_shutdown", async () => {
		if (activeAutoSetup && !activeAutoSetup.killed) {
			try {
				activeAutoSetup.kill("SIGTERM");
			} catch {
				// Best effort cleanup for an in-progress setup helper.
			}
		}
		activeAutoSetup = undefined;
		await autoManager.shutdown();
		currentCtx = undefined;
		pendingProfileSwitch = undefined;
	});

	const handleProfileSwitchEvent = (data: unknown) => {
		if (profileLocked) return;
		const request = data as Partial<ProfileSwitchRequest> | undefined;
		const profile = typeof request?.profile === "string" ? request.profile.trim() : "";
		if (!profile) return;

		const normalizedRequest: ProfileSwitchRequest = {
			profile,
			notify: request?.notify,
			source: typeof request?.source === "string" ? request.source : undefined,
		};

		if (!currentCtx) {
			pendingProfileSwitch = normalizedRequest;
			return;
		}

		const result = processProfileSwitchRequest(currentCtx, normalizedRequest);
		if (!result.ok) {
			currentCtx.ui.notify(result.error, "warning");
		}
	};

	pi.events.on(GATE_SWITCH_PROFILE_EVENT, handleProfileSwitchEvent);

	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		const autoArgs = trimmed.split(/\s+/);
		if (autoArgs[0] === "auto") {
			const action = autoArgs[1] ?? "status";
			if (action === "setup") {
				if (activeAutoSetup) {
					ctx.ui.notify("Gate auto setup is already running", "warning");
					return;
				}
				const backendChoice = ctx.hasUI
					? await ctx.ui.select("Choose Gate auto approver backend", ["Local managed llama.cpp", "Pi configured model"])
					: "Local managed llama.cpp";
				if (backendChoice === "Pi configured model") {
					const models = listConfiguredPiModels();
					if (models.length === 0) {
						ctx.ui.notify("No models found in ~/.pi/agent/models.json for Gate auto setup", "warning");
						return;
					}
					const choice = await ctx.ui.select("Select Pi model for Gate auto. Full semantic approval context may be sent to this provider.", models.map((model) => model.display));
					const selected = models.find((model) => model.display === choice);
					if (!selected) return;
					const confirm = await ctx.ui.select(`Use ${selected.provider}/${selected.model} for Gate auto? Full semantic approval context may be sent to this provider.`, ["Use this model", "Cancel"]);
					if (confirm !== "Use this model") return;
					const writeResult = setGateAutoBackendFromSetup(ctx, { type: "pi-model", provider: selected.provider, model: selected.model, thinking: "off", cacheRetention: "short", temperature: 0, maxTokens: 128 });
					ctx.ui.notify(`Gate auto setup complete. backend=pi-model model=${selected.provider}/${selected.model} | config=${writeResult.scope}:${displayStatusPath(ctx.cwd, writeResult.configPath)} | run /gate auto on when ready`, "info");
					return;
				}
				ctx.ui.notify("Gate auto setup started. This may download the default model the first time; leave Pi running until it completes.", "info");
				try {
					const setup = await runGateAutoSetupScript(extensionDir, (child) => {
						activeAutoSetup = child;
					});
					const writeResult = setGateAutoBackendFromSetup(ctx, managedLlamaBackendConfig(setup));
					ctx.ui.notify(`Gate auto setup complete. server=${setup.serverPath} | model=${setup.modelPath} | config=${writeResult.scope}:${displayStatusPath(ctx.cwd, writeResult.configPath)} | run /gate auto on when ready`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Gate auto setup failed: ${message}`, "warning");
				} finally {
					activeAutoSetup = undefined;
				}
				return;
			}
			if (action === "on") {
				setGateAutoEnabled(ctx.cwd, true);
				autoRuntimeEnabled = true;
				resetAutoBlockState(autoBlockState);
				const status = await autoManager.enable(ctx);
				const resolved = getEffectivePolicy(ctx.cwd);
				updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
				ctx.ui.notify(
					status.mode === "managed" || status.mode === "external" || status.mode === "inherited" || status.mode === "pi-model"
						? `Gate auto enabled (${status.mode}${status.endpoint ? ` ${status.endpoint}` : status.provider && status.model ? ` ${status.provider}/${status.model}` : ""})`
						: `Gate auto enabled but not ready: ${status.lastError ?? status.mode}`,
					status.mode === "managed" || status.mode === "external" || status.mode === "inherited" || status.mode === "pi-model" ? "info" : "warning",
				);
				return;
			}
			if (action === "off") {
				setGateAutoEnabled(ctx.cwd, false);
				autoRuntimeEnabled = false;
				await autoManager.disable(ctx);
				resetAutoBlockState(autoBlockState);
				const resolved = getEffectivePolicy(ctx.cwd);
				updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, false);
				ctx.ui.notify("Gate auto disabled", "info");
				return;
			}
			if (action === "status") {
				if (autoRuntimeEnabled) await autoManager.refresh(ctx);
				else await autoManager.disable(ctx);
				const status = autoManager.status(ctx);
				const autoConfig = loadGateAutoConfig(ctx.cwd);
				ctx.ui.notify(
					formatGateAutoStatusMessage(ctx, status, autoConfig.startOnSession, autoRuntimeEnabled && autoManager.isEnabled()),
					status.lastError ? "warning" : "info",
				);
				return;
			}
			ctx.ui.notify("Gate: unknown auto subcommand. Use /gate auto setup, /gate auto on, /gate auto off, or /gate auto status", "warning");
			return;
		}
		if (trimmed === "switch") {
			if (profileLocked) {
				ctx.ui.notify(`Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}`, "warning");
				return;
			}
			if (loaded.error) {
				ctx.ui.notify(loaded.error, "warning");
				return;
			}
			const profileNames = [BASE_PROFILE_NAME, ...Object.keys(loaded.policy?.profiles ?? {}).sort()];
			if (profileNames.length === 0) {
				ctx.ui.notify("Gate: no profiles defined", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Gate: profile switching requires a UI", "warning");
				return;
			}
			const current = getEffectivePolicy(ctx.cwd).compiled?.profileName ?? "error";
			const choice = await ctx.ui.select(`Select gate profile (current: ${current})`, profileNames);
			if (!choice) return;
			if (choice === current) {
				// Selecting the current profile clears the override, falling back
				// to GATE_PROFILE env var, policy.activeProfile, or $base. Session
				// approvals are scoped to the effective profile and must not survive
				// a reset to a different fallback profile.
				const previousProfile = current;
				selectedProfileOverride = undefined;
				const fresh = getEffectivePolicy(ctx.cwd);
				if (fresh.compiled?.profileName !== previousProfile) sessionAllows.clear();
				updateStatus(ctx, fresh.compiled?.profileName, sessionAllows, !fresh.compiled, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
				ctx.ui.notify(`Gate profile reset to ${fresh.compiled?.profileName ?? "error"}`, "info");
				return;
			}
			const result = switchProfile(ctx, choice);
			if (!result.ok) {
				ctx.ui.notify(result.error, "warning");
			}
			return;
		}

		const resolved = getEffectivePolicy(ctx.cwd);
		if (trimmed === "clear") {
			sessionAllows.clear();
			updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, autoRuntimeEnabled && autoManager.isEnabled());
			ctx.ui.notify("Gate session approvals cleared", "info");
			return;
		}

		if (trimmed !== "" && trimmed !== "status") {
			ctx.ui.notify(
				"Gate: unknown subcommand. Use /gate status, /gate switch, /gate clear, or /gate auto setup|status|on|off",
				"warning",
			);
			return;
		}

		if (autoRuntimeEnabled) await autoManager.refresh(ctx);
		else await autoManager.disable(ctx);
		const autoStatus = autoManager.status(ctx);
		const autoConfig = loadGateAutoConfig(ctx.cwd);
		const summary = [
			resolved.compiled ? `Gate profile=${resolved.compiled.profileName}` : "Gate profile=error",
			resolved.compiled && resolved.compiled.lineageNames.length > 1 ? `lineage=${resolved.compiled.lineageNames.join(">")}` : undefined,
			resolved.compiled?.unattended ? "unattended=true" : undefined,
			profileLocked ? `profile locked by=${GATE_PROFILE_LOCK_ENV}` : undefined,
			selectedProfileOverride ? `profile override=${selectedProfileOverride === BASE_PROFILE_NAME ? "base" : selectedProfileOverride}` : undefined,
			`session approvals=${sessionAllows.size}`,
			`auto enabled=${autoStatus.enabled}`,
			`auto runtime=${autoRuntimeEnabled && autoManager.isEnabled()}`,
			`auto startOnSession=${autoConfig.startOnSession}`,
			`auto backend=${autoStatus.mode}`,
			autoStatus.lastError ? `auto lastError=${autoStatus.lastError}` : undefined,
			`policy file=${loaded.policyPath}`,
			`schema file=${loaded.schemaPath}`,
			resolved.error ? `status=${resolved.error}` : undefined,
		]
			.filter(Boolean)
			.join(" | ");
		ctx.ui.notify(summary, resolved.error ? "warning" : "info");
	};

	pi.registerCommand("gate", {
		description: "status, switch (switch profiles), clear (clear cached approvals), auto setup|on|off|status",
		handler: commandHandler,
	});

	pi.on("tool_call", async (event, ctx) => {
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

			const composite = analyzePolicyBashComposite(command);
			if (composite?.error) return { block: true, reason: `Gate blocked bash command chain: ${composite.error}` };
			if (composite?.segments) {
				for (const segment of composite.segments) {
					const chainUnsafeReason = getChainUnsafeShellSegmentReason(segment);
					if (chainUnsafeReason) {
						return { block: true, reason: `Gate blocked bash command chain at ${JSON.stringify(segment)}: ${chainUnsafeReason}` };
					}
					const segmentEvaluation = evaluateProfileBashCommand(compiled, segment, ctx.cwd);
					if (segmentEvaluation.decision.action !== "allow") {
						const reason = segmentEvaluation.decision.action === "deny"
							? pickReason(segmentEvaluation.decision.reasons, "deny", "Gate denied bash command chain")
							: pickReason(segmentEvaluation.decision.reasons, "ask", "Gate blocked bash command chain: a component requires review");
						return { block: true, reason: `Gate blocked bash command chain at ${JSON.stringify(segment)}: ${reason}` };
					}
				}
				return undefined;
			}

			const evaluation = evaluateProfileBashCommand(compiled, command, ctx.cwd);
			const { normalizedCommand, analysis } = evaluation;
			const reasons = evaluation.decision.reasons;

			if (evaluation.decision.action === "allow") return undefined;
			if (evaluation.decision.action === "deny") {
				return { block: true, reason: pickReason(reasons, "deny", "Gate denied bash command") };
			}

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
	});
}

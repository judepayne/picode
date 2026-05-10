import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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
	type?: "object" | "string";
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

interface CandidateGroup {
	display: string;
	values: string[];
}

interface Decision {
	action: PermissionAction;
	reasons: string[];
}

const SESSION_STATUS_KEY = "gate";
const GATE_PROFILE_ENV = "GATE_PROFILE";
const GATE_PROFILE_LOCK_ENV = "GATE_PROFILE_LOCK";
const GATE_SWITCH_PROFILE_EVENT = "gate:switch-profile";
const POLICY_SCHEMA_FILE = "policy.schema.json";
const BASE_PROFILE_NAME = "$base";
const GATE_ERROR_STATUS = "gate:error";
const MAX_SESSION_ALLOWS = 100;
const SHELL_COMPLEXITY_PATTERN = /(^|[^\\])(\|\||&&|[;`]|\$\()/;
const SHELL_SEPARATOR_TOKENS = new Set([";", "&&", "||", "|", "then", "do", "else", "elif", "fi"]);
const PATH_SUBJECTS = new Set(["read", "edit", "list", "external_directory"]);
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

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function normalizeAbsPath(value: string): string {
	return normalizeSlashes(path.resolve(value));
}

function normalizePathArg(rawPath: string, cwd: string): string {
	const trimmed = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (trimmed === "~" || trimmed === "$HOME") return normalizeAbsPath(os.homedir());
	if (trimmed.startsWith("~/")) return normalizeAbsPath(path.join(os.homedir(), trimmed.slice(2)));
	if (trimmed.startsWith("$HOME/")) return normalizeAbsPath(path.join(os.homedir(), trimmed.slice(6)));
	return normalizeAbsPath(path.resolve(cwd, trimmed));
}

function expandPatternValue(pattern: string, cwd: string): string {
	const home = normalizeSlashes(os.homedir());
	let expanded = normalizeSlashes(pattern).replaceAll("${cwd}", normalizeAbsPath(cwd));
	if (expanded === "~" || expanded === "$HOME") expanded = home;
	else if (expanded.startsWith("~/")) expanded = `${home}/${expanded.slice(2)}`;
	else if (expanded.startsWith("$HOME/")) expanded = `${home}/${expanded.slice(6)}`;
	return expanded;
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegex(pattern: string): RegExp {
	let regex = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			regex += ".*";
			continue;
		}
		if (ch === "?") {
			regex += ".";
			continue;
		}
		regex += escapeRegex(ch);
	}
	return new RegExp(`^${regex}$`);
}

function isWithinRoot(root: string, candidate: string): boolean {
	const normalizedRoot = normalizeAbsPath(root);
	const normalizedCandidate = normalizeAbsPath(candidate);
	if (normalizedCandidate === normalizedRoot) return true;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeCommand(value: string): string {
	return value.trim().replace(/\s+/g, " ");
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

function validatePolicySchema(schema: JsonSchemaNode, policy: unknown): string | undefined {
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

	for (const profileName of Object.keys(profiles)) {
		const error = validateUnattendedProfile(policy, profileName);
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

function isPathSubject(subject: string): boolean {
	return PATH_SUBJECTS.has(subject);
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

function buildPathCandidateGroup(rawPath: string, cwd: string): CandidateGroup {
	const absPath = normalizePathArg(rawPath, cwd);
	const values = new Set<string>([absPath]);
	const normalizedRaw = normalizeSlashes(rawPath);
	if (normalizedRaw) values.add(normalizedRaw);
	if (isWithinRoot(cwd, absPath)) {
		values.add(normalizeSlashes(path.relative(normalizeAbsPath(cwd), absPath) || "."));
	}
	return {
		display: absPath,
		values: Array.from(values),
	};
}

function evaluateExternalDirectory(policy: CompiledPolicy, absPaths: string[], cwd: string): Decision {
	const normalizedCwd = normalizeAbsPath(cwd);
	const groups = absPaths
		.map((candidate) => normalizeAbsPath(candidate))
		.filter((candidate) => !isWithinRoot(normalizedCwd, candidate))
		.map((candidate) => ({ display: candidate, values: [candidate] }));
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, "external_directory", groups);
}

function evaluateAbsolutePaths(policy: CompiledPolicy, subject: string, absPaths: string[], cwd: string): Decision {
	const groups = absPaths.map((candidate) => {
		const values = new Set<string>([normalizeAbsPath(candidate)]);
		if (isWithinRoot(cwd, candidate)) {
			values.add(normalizeSlashes(path.relative(normalizeAbsPath(cwd), normalizeAbsPath(candidate)) || "."));
		}
		return { display: normalizeAbsPath(candidate), values: Array.from(values) };
	});
	if (groups.length === 0) return { action: "allow", reasons: [] };
	return evaluateSubject(policy, subject, groups);
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
			return [];
	}
}

function isIgnorableRedirectionTarget(candidate: string): boolean {
	const normalized = normalizeAbsPath(candidate);
	return normalized === "/dev/null" || normalized === "/dev/stdout" || normalized === "/dev/stderr" || normalized === "/dev/tty";
}

function tokenizeShell(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;

	const flush = () => {
		if (current) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			else current += ch;
			continue;
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && i + 1 < command.length) current += command[++i] ?? "";
			else current += ch;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			continue;
		}
		if (ch === '"') {
			quote = "double";
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i] ?? "";
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (ch === ">") {
			flush();
			if (command[i + 1] === ">") {
				tokens.push(">>");
				i++;
			} else {
				tokens.push(">");
			}
			continue;
		}
		if (ch === ";") {
			flush();
			tokens.push(";");
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			flush();
			tokens.push("&&");
			i++;
			continue;
		}
		if (ch === "|") {
			flush();
			if (command[i + 1] === "|") {
				tokens.push("||");
				i++;
			} else {
				tokens.push("|");
			}
			continue;
		}
		current += ch;
	}

	if (quote) return undefined;
	flush();
	return tokens;
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

export function extractMutationTargets(command: string, cwd: string): MutationAnalysis {
	const lower = command.toLowerCase();
	const tokens = tokenizeShell(command);
	const tokenizedFindDelete = tokens?.some((token, index) =>
		normalizeShellToken(token).toLowerCase() === "find"
		&& tokens.slice(index + 1).some((arg) => normalizeShellToken(arg) === "-delete")
	) ?? false;
	const mutating = /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btee\b|\bln\b|\binstall\b|\bchmod\b|\bchown\b|\bfind\b[^\n]*\s-delete\b|\bgit\s+clean\b|>|\bsed\b[^\n]*\s-i|\bperl\b[^\n]*\s-pi/.test(lower)
		|| tokenizedFindDelete
		|| hasMutatingAwkPattern(command);
	const complex = SHELL_COMPLEXITY_PATTERN.test(command);
	if (!mutating) {
		return { mutating: false, complex, paths: [], inferredCwdTarget: false, reason: "read-only command" };
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

function buildPathSessionKey(subject: string, values: string[]): string {
	return `${subject}:${[...values].sort().join("|")}`;
}

function updateStatus(
	ctx: ExtensionContext,
	profileName: string | undefined,
	sessionAllows: Set<string>,
	yolo = false,
	locked = false,
): void {
	if (!ctx.hasUI) return;
	if (yolo) {
		ctx.ui.setStatus(SESSION_STATUS_KEY, GATE_ERROR_STATUS);
		return;
	}
	const lockSuffix = locked ? "🔒" : "";
	const sessionSuffix = sessionAllows.size > 0 ? ` +${sessionAllows.size}` : "";
	ctx.ui.setStatus(SESSION_STATUS_KEY, `gate:${profileName ?? "base"}${lockSuffix}${sessionSuffix}`);
}

async function confirmDecision(
	ctx: ExtensionContext,
	title: string,
	message: string,
	sessionKey: string,
	sessionAllows: Set<string>,
	profileName: string,
	locked = false,
): Promise<{ allow: boolean; sessionStored: boolean }> {
	if (!ctx.hasUI) return { allow: false, sessionStored: false };
	const choice = await ctx.ui.select(`${title}\n\n${message}`, ["Allow once", "Allow for session", "Deny"]);
	if (choice === "Allow once") return { allow: true, sessionStored: false };
	if (choice === "Allow for session") {
		// Cap at MAX_SESSION_ALLOWS to prevent unbounded memory growth.
		if (sessionAllows.size >= MAX_SESSION_ALLOWS) sessionAllows.clear();
		sessionAllows.add(sessionKey);
		updateStatus(ctx, profileName, sessionAllows, false, locked);
		return { allow: true, sessionStored: true };
	}
	return { allow: false, sessionStored: false };
}

function pickReason(reasons: string[], action: PermissionAction, fallback: string): string {
	return reasons.find((reason) => reason.includes(` ${action}:`)) ?? reasons[0] ?? fallback;
}

export default function piGate(pi: ExtensionAPI) {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const policyPath = path.join(extensionDir, "policy.json");
	const schemaPath = path.join(extensionDir, POLICY_SCHEMA_FILE);
	const loaded = loadPolicy(policyPath, schemaPath);
	const sessionAllows = new Set<string>();
	const profileLocked = isEnvEnabled(process.env[GATE_PROFILE_LOCK_ENV]);
	let policyErrorShown = false;
	let selectedProfileOverride: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let pendingProfileSwitch: ProfileSwitchRequest | undefined;

	function resolveRequestedProfile(): string {
		return (
			normalizeProfileName(selectedProfileOverride)
			?? normalizeProfileName(process.env[GATE_PROFILE_ENV])
			?? normalizeProfileName(loaded.policy?.activeProfile)
			?? BASE_PROFILE_NAME
		);
	}

	function getCompiledPolicy(cwd: string): { compiled?: CompiledPolicy; error?: string } {
		if (loaded.error) return { error: loaded.error };
		if (!loaded.policy) return { error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		try {
			return { compiled: compilePolicy(loaded.policy, cwd, resolveRequestedProfile()) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `policy resolution failed! ${message}. Tool calls are blocked until the gate policy is fixed.` };
		}
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
			updateStatus(ctx, compiled.profileName, sessionAllows, false, profileLocked);
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
		const result = getCompiledPolicy(ctx.cwd);
		if (result.compiled) updateStatus(ctx, result.compiled.profileName, sessionAllows, false, profileLocked);
		else updateStatus(ctx, undefined, sessionAllows, true, profileLocked);
		if (result.error && ctx.hasUI && !policyErrorShown) {
			policyErrorShown = true;
			ctx.ui.notify(result.error, "warning");
		}
		flushPendingProfileSwitch(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		flushPendingProfileSwitch(ctx);
	});

	pi.on("session_shutdown", async () => {
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
			const current = getCompiledPolicy(ctx.cwd).compiled?.profileName ?? "error";
			const choice = await ctx.ui.select(`Select gate profile (current: ${current})`, profileNames);
			if (!choice) return;
			if (choice === current) {
				// Selecting the current profile clears the override, falling back
				// to GATE_PROFILE env var, policy.activeProfile, or $base.
				selectedProfileOverride = undefined;
				const fresh = getCompiledPolicy(ctx.cwd);
				updateStatus(ctx, fresh.compiled?.profileName, sessionAllows, !fresh.compiled, profileLocked);
				ctx.ui.notify(`Gate profile reset to ${fresh.compiled?.profileName ?? "error"}`, "info");
				return;
			}
			const result = switchProfile(ctx, choice);
			if (!result.ok) {
				ctx.ui.notify(result.error, "warning");
			}
			return;
		}

		const resolved = getCompiledPolicy(ctx.cwd);
		if (trimmed === "clear") {
			sessionAllows.clear();
			updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked);
			ctx.ui.notify("Gate session approvals cleared", "info");
			return;
		}

		if (trimmed !== "" && trimmed !== "status") {
			ctx.ui.notify(
				"Gate: unknown subcommand. Use /gate status, /gate switch, or /gate clear",
				"warning",
			);
			return;
		}

		const summary = [
			resolved.compiled ? `Gate profile=${resolved.compiled.profileName}` : "Gate profile=error",
			resolved.compiled?.unattended ? "unattended=true" : undefined,
			profileLocked ? `profile locked by=${GATE_PROFILE_LOCK_ENV}` : undefined,
			selectedProfileOverride ? `profile override=${selectedProfileOverride === BASE_PROFILE_NAME ? "base" : selectedProfileOverride}` : undefined,
			`session approvals=${sessionAllows.size}`,
			`policy file=${loaded.policyPath}`,
			`schema file=${loaded.schemaPath}`,
			resolved.error ? `status=${resolved.error}` : undefined,
		]
			.filter(Boolean)
			.join(" | ");
		ctx.ui.notify(summary, resolved.error ? "warning" : "info");
	};

	pi.registerCommand("gate", {
		description: "status, switch (switch profiles), clear (clear cached approvals)",
		handler: commandHandler,
	});

	pi.on("tool_call", async (event, ctx) => {
		const resolved = getCompiledPolicy(ctx.cwd);
		if (!resolved.compiled) {
			return {
				block: true,
				reason: resolved.error ?? "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed.",
			};
		}
		const compiled = resolved.compiled;

		if (event.toolName === "bash") {
			const command = String((event.input as Record<string, unknown>).command ?? "");
			const sessionKey = buildBashSessionKey(command);
			if (sessionAllows.has(sessionKey)) return undefined;

			const normalizedCommand = normalizeCommand(command);
			const commandDecision = evaluateSubject(compiled, "bash", [{ display: normalizedCommand || "<empty command>", values: [normalizedCommand] }]);
			const analysis = extractMutationTargets(command, ctx.cwd);
			const reasons = [...commandDecision.reasons];

			if (commandDecision.action === "deny") {
				return { block: true, reason: pickReason(commandDecision.reasons, "deny", "Gate denied bash command") };
			}

			if (commandDecision.action === "allow" && !analysis.mutating) {
				return undefined;
			}

			let pathDecision: Decision = { action: "allow", reasons: [] };
			let externalDecision: Decision = { action: "allow", reasons: [] };
			if (analysis.mutating) {
				const candidatePaths = analysis.paths.length > 0 ? analysis.paths : analysis.inferredCwdTarget ? [normalizeAbsPath(ctx.cwd)] : [];
				if (candidatePaths.length === 0) {
					pathDecision = { action: "ask", reasons: [`bash ask: ${analysis.reason}`] };
				} else {
					externalDecision = evaluateExternalDirectory(compiled, candidatePaths, ctx.cwd);
					pathDecision = evaluateAbsolutePaths(compiled, "edit", candidatePaths, ctx.cwd);
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

			if (finalAction === "allow") return undefined;
			if (finalAction === "deny") {
				return { block: true, reason: pickReason(reasons, "deny", "Gate denied bash command") };
			}

			if (compiled.unattended) {
				return {
					block: true,
					reason: `${pickReason(reasons, "ask", "Gate requires confirmation for bash command")}. Profile ${compiled.profileName} is unattended and cannot prompt for approval.`,
				};
			}
			if (!ctx.hasUI) {
				return { block: true, reason: pickReason(reasons, "ask", "Gate requires confirmation for bash command but no UI is available") };
			}
			const result = await confirmDecision(
				ctx,
				"Gate: confirm bash command",
				[
					normalizedCommand || command,
					"",
					...reasons,
					`Profile: ${compiled.profileName}`,
				].join("\n"),
				sessionKey,
				sessionAllows,
				compiled.profileName,
				profileLocked,
			);
			if (result.allow) return undefined;
			return { block: true, reason: pickReason(reasons, "ask", "Gate denied bash command") };
		}

		const input = event.input as Record<string, unknown>;
		const subject = getToolPermissionSubject(event.toolName);
		const subjectGroups = getToolSubjectGroups(event.toolName, input, ctx);
		const pathCandidates = getToolPathCandidates(event.toolName, input, ctx);
		const sessionKey =
			subjectGroups.length > 0
				? buildPathSessionKey(subject, subjectGroups.map((group) => group.display))
				: `${subject}:unknown`;
		if (sessionAllows.has(sessionKey)) return undefined;

		let subjectDecision = evaluateSubject(compiled, subject, subjectGroups.length > 0 ? subjectGroups : [{ display: "unknown input", values: [""] }]);
		let externalDecision = evaluateExternalDirectory(compiled, pathCandidates, ctx.cwd);
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
		if (compiled.unattended) {
			return {
				block: true,
				reason: `${pickReason(reasons, "ask", `Gate requires confirmation for ${event.toolName}`)}. Profile ${compiled.profileName} is unattended and cannot prompt for approval.`,
			};
		}
		if (!ctx.hasUI) {
			return { block: true, reason: pickReason(reasons, "ask", `Gate requires confirmation for ${event.toolName} but no UI is available`) };
		}
		const result = await confirmDecision(
			ctx,
			`Gate: confirm ${event.toolName}`,
			[...reasons, `Profile: ${compiled.profileName}`].join("\n"),
			sessionKey,
			sessionAllows,
			compiled.profileName,
			profileLocked,
		);
		if (result.allow) return undefined;
		return { block: true, reason: pickReason(reasons, "ask", `Gate denied ${event.toolName}`) };
	});
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DESIGN_MODE_ID = "designer";
const PLAN_MODE_ID = "planner";
const VARS_DIR_SEGMENTS = [".pi"] as const;
const VARS_FILE_NAME = "agent-mode-vars.json";
const WRITE_LOCATION_FILE_NAME = "agent-mode-vars-config.json";
const WRITE_LOCATION_KEY = "pi-location";
const WRITE_FILE_NAME_KEY = "vars-file-name";
const DEFAULT_WRITE_LOCATION = "project" as const;
const DEFAULT_PLAN_PATH = ".pi/plans/active.md";
const DEFAULT_DESIGN_PATH = ".pi/designs/active.md";
const DEFAULT_PROMPT_VARS: PromptVarMap = {
	"automode.enabled": "false",
};

const RESERVED_DERIVED_VAR_KEYS = new Set([
	"plan",
	"plan.path",
	"plan.exists",
	"plan.active",
	"design",
	"design.path",
	"design.exists",
	"design.active",
]);
const MUTABLE_VAR_KEY_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export type PromptVarMap = Record<string, string>;
export type StoredVarMap = Record<string, unknown>;
export type VarsConfig = Record<string, unknown>;
export type PiLocation = "project" | "global";

interface ReadConfigResult {
	config: VarsConfig;
	actualPath: string;
	error?: string;
}

interface WriteLocationConfig {
	[WRITE_LOCATION_KEY]: PiLocation;
	[WRITE_FILE_NAME_KEY]?: string;
}

export interface VarsState {
	configPath: string;
	configError?: string;
	config: VarsConfig;
	globalConfig: VarsConfig;
	projectConfig: VarsConfig;
	storedVars: StoredVarMap;
	promptVars: PromptVarMap;
	writeLocation: PiLocation;
	varsFileName: string;
	writeConfigPath: string;
	projectConfigPath: string;
	globalConfigPath: string;
	projectReadPath: string;
	globalReadPath: string;
}

export interface VarsBootstrapResult {
	state: VarsState;
	created: string[];
	existing: string[];
}

function boolString(value: boolean): string {
	return value ? "true" : "false";
}

function buildStatusBlock(label: string, filePath: string, exists: boolean, active: boolean): string {
	const state = exists ? "exists" : "does not exist";
	const activity = active ? `${label} mode is active.` : `${label} mode is not active.`;
	return `${label} file: ${filePath} (${state}). ${activity}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeVarsConfig(input: unknown, fileLabel = VARS_FILE_NAME): VarsConfig {
	if (input === undefined) return {};
	if (!isPlainObject(input)) {
		throw new Error(`${fileLabel} must contain a JSON object.`);
	}
	return input;
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value) && Object.keys(value).length > 0;
}

function resolveHomeDir(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

function getProjectPiDir(cwd: string): string {
	return path.join(cwd, ...VARS_DIR_SEGMENTS);
}

function getGlobalPiDir(): string {
	return path.join(resolveHomeDir(), ".pi", "agent");
}

function normalizeVarsFileName(value: unknown): string {
	if (typeof value !== "string") return VARS_FILE_NAME;
	const trimmed = value.trim();
	if (!trimmed) return VARS_FILE_NAME;
	const normalizedSeparators = trimmed.replace(/\\/g, "/");
	const tail = normalizedSeparators.split("/").pop()?.trim() ?? "";
	return tail || VARS_FILE_NAME;
}

export function getProjectVarsConfigPath(cwd: string, varsFileName = VARS_FILE_NAME): string {
	return path.join(getProjectPiDir(cwd), normalizeVarsFileName(varsFileName));
}

export function getGlobalVarsConfigPath(varsFileName = VARS_FILE_NAME): string {
	return path.join(getGlobalPiDir(), normalizeVarsFileName(varsFileName));
}

export function getVarsConfigPath(cwd: string, varsFileName = VARS_FILE_NAME): string {
	return getProjectVarsConfigPath(cwd, varsFileName);
}

export function getWriteLocationConfigPath(cwd: string): string {
	return path.join(getProjectPiDir(cwd), WRITE_LOCATION_FILE_NAME);
}

function readJsonObjectFile(filePath: string, fileLabel: string, strict = false): ReadConfigResult {
	if (!fs.existsSync(filePath)) {
		return { config: {}, actualPath: filePath };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return { config: normalizeVarsConfig(parsed, fileLabel), actualPath: filePath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (strict) throw new Error(`Failed to read ${filePath}: ${message}`);
		return { config: {}, actualPath: filePath, error: `Failed to read ${filePath}: ${message}` };
	}
}

function readScopeConfig(cwd: string, location: PiLocation, varsFileName: string, strict = false): ReadConfigResult {
	const configPath = location === "project"
		? getProjectVarsConfigPath(cwd, varsFileName)
		: getGlobalVarsConfigPath(varsFileName);
	return readJsonObjectFile(configPath, normalizeVarsFileName(varsFileName), strict);
}

function normalizeWriteLocation(value: unknown): PiLocation {
	if (value === "global") return "global";
	return "project";
}

function readWriteLocation(cwd: string, strict = false): { value: PiLocation; varsFileName: string; path: string; error?: string } {
	const configPath = getWriteLocationConfigPath(cwd);
	if (!fs.existsSync(configPath)) {
		return { value: DEFAULT_WRITE_LOCATION, varsFileName: VARS_FILE_NAME, path: configPath };
	}

	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed)) {
			throw new Error(`${WRITE_LOCATION_FILE_NAME} must contain a JSON object.`);
		}
		const rawValue = parsed[WRITE_LOCATION_KEY];
		if (rawValue !== "project" && rawValue !== "global") {
			throw new Error(`${WRITE_LOCATION_FILE_NAME} must set ${WRITE_LOCATION_KEY} to \"project\" or \"global\".`);
		}
		return {
			value: rawValue,
			varsFileName: normalizeVarsFileName(parsed[WRITE_FILE_NAME_KEY]),
			path: configPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (strict) throw new Error(`Failed to read ${configPath}: ${message}`);
		return {
			value: DEFAULT_WRITE_LOCATION,
			varsFileName: VARS_FILE_NAME,
			path: configPath,
			error: `Failed to read ${configPath}: ${message}`,
		};
	}
}

function writeWriteLocation(cwd: string, location: PiLocation, varsFileName = VARS_FILE_NAME): string {
	const configPath = getWriteLocationConfigPath(cwd);
	const normalizedFileName = normalizeVarsFileName(varsFileName);
	const payload: WriteLocationConfig = {
		[WRITE_LOCATION_KEY]: location,
		...(normalizedFileName !== VARS_FILE_NAME ? { [WRITE_FILE_NAME_KEY]: normalizedFileName } : {}),
	};
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return configPath;
}

function ensureWriteLocationConfig(cwd: string): { value: PiLocation; varsFileName: string; path: string } {
	const current = readWriteLocation(cwd, false);
	if (!fs.existsSync(current.path)) {
		writeWriteLocation(cwd, current.value, current.varsFileName);
	}
	return current;
}

function writeVarsConfig(cwd: string, config: VarsConfig, location: PiLocation, varsFileName: string): string {
	const configPath = location === "project"
		? getProjectVarsConfigPath(cwd, varsFileName)
		: getGlobalVarsConfigPath(varsFileName);
	const normalized = normalizeVarsConfig(config);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	if (!isNonEmptyObject(normalized)) {
		fs.rmSync(configPath, { force: true });
		return configPath;
	}
	fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	return configPath;
}

function resolveConfiguredPath(cwd: string, value: string): string {
	return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function stringifyVarValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function flattenConfigVars(input: Record<string, unknown>, prefix = "", out: StoredVarMap = {}): StoredVarMap {
	for (const [key, value] of Object.entries(input)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		out[fullKey] = value;
		if (isPlainObject(value)) {
			flattenConfigVars(value, fullKey, out);
		}
	}
	return out;
}

function getNestedValue(input: Record<string, unknown>, key: string): unknown {
	const segments = key.split(".");
	let current: unknown = input;
	for (const segment of segments) {
		if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function cloneJsonValue<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function setNestedValue(input: VarsConfig, key: string, value: unknown): VarsConfig {
	const next = cloneJsonValue(input);
	const segments = key.split(".");
	let current: Record<string, unknown> = next;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];
		const child = current[segment];
		if (!isPlainObject(child)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = value;
	return next;
}

function unsetNestedValue(input: VarsConfig, key: string): VarsConfig {
	const next = cloneJsonValue(input);
	const segments = key.split(".");
	const stack: Record<string, unknown>[] = [next];
	let current: Record<string, unknown> = next;
	for (let index = 0; index < segments.length - 1; index += 1) {
		const child = current[segments[index]];
		if (!isPlainObject(child)) {
			return next;
		}
		current = child;
		stack.push(current);
	}

	delete current[segments[segments.length - 1]];
	for (let index = segments.length - 2; index >= 0; index -= 1) {
		const parent = stack[index];
		const segment = segments[index];
		const child = parent[segment];
		if (!isPlainObject(child) || Object.keys(child).length > 0) break;
		delete parent[segment];
	}
	return next;
}

function deepMergeConfig(base: VarsConfig, override: VarsConfig): VarsConfig {
	const result: VarsConfig = cloneJsonValue(base);
	for (const [key, value] of Object.entries(override)) {
		const existing = result[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			result[key] = deepMergeConfig(existing, value);
		} else {
			result[key] = cloneJsonValue(value);
		}
	}
	return result;
}

function defaultBootstrapVarsConfig(): VarsConfig {
	return {
		paths: {
			plan: DEFAULT_PLAN_PATH,
			design: DEFAULT_DESIGN_PATH,
		},
		subagents: {
			dispatch: {
				defaultContext: "fresh",
			},
		},
		automode: {
			enabled: false,
		},
	};
}

function defaultProjectBootstrapVarsConfig(globalConfig: VarsConfig): VarsConfig {
	let initialConfig = defaultBootstrapVarsConfig();
	if (getNestedValue(globalConfig, "paths.plan") !== undefined) {
		initialConfig = unsetNestedValue(initialConfig, "paths.plan");
	}
	if (getNestedValue(globalConfig, "paths.design") !== undefined) {
		initialConfig = unsetNestedValue(initialConfig, "paths.design");
	}
	return initialConfig;
}

function getConfiguredPathValue(config: VarsConfig, key: "paths.plan" | "paths.design", fallback: string): string {
	const rawValue = getNestedValue(config, key);
	if (typeof rawValue !== "string") return fallback;
	const trimmed = rawValue.trim();
	return trimmed || fallback;
}

function getBuiltInPromptVars(cwd: string, modeId: string | undefined, config: VarsConfig): PromptVarMap {
	const planPath = resolveConfiguredPath(cwd, getConfiguredPathValue(config, "paths.plan", DEFAULT_PLAN_PATH));
	const designPath = resolveConfiguredPath(cwd, getConfiguredPathValue(config, "paths.design", DEFAULT_DESIGN_PATH));
	const planExists = fs.existsSync(planPath);
	const designExists = fs.existsSync(designPath);
	const planActive = modeId === PLAN_MODE_ID;
	const designActive = modeId === DESIGN_MODE_ID;

	return {
		"plan.path": planPath,
		"plan.exists": boolString(planExists),
		"plan.active": boolString(planActive),
		plan: buildStatusBlock("Plan", planPath, planExists, planActive),
		"design.path": designPath,
		"design.exists": boolString(designExists),
		"design.active": boolString(designActive),
		design: buildStatusBlock("Design", designPath, designExists, designActive),
	};
}

function getPromptInterpolationVars(storedVars: StoredVarMap, builtInPromptVars: PromptVarMap): PromptVarMap {
	const customVars: PromptVarMap = {};
	for (const [key, value] of Object.entries(storedVars)) {
		customVars[key] = stringifyVarValue(value);
	}
	return {
		...DEFAULT_PROMPT_VARS,
		...customVars,
		...builtInPromptVars,
	};
}

function validateMutableVarKey(key: string): string {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("key is required.");
	if (!MUTABLE_VAR_KEY_PATTERN.test(trimmed)) {
		throw new Error(`Invalid var key: ${key}. Use dot-separated identifiers like feature.flag or paths.design.`);
	}
	if (RESERVED_DERIVED_VAR_KEYS.has(trimmed)) {
		throw new Error(`Cannot set or unset derived var: ${trimmed}`);
	}
	if (trimmed === "paths") {
		throw new Error('Cannot set "paths" directly. Use "paths.plan" or "paths.design" to set individual path values.');
	}
	if (trimmed === "automode") {
		throw new Error('Cannot set "automode" directly. Use "automode.enabled" to clear automode, or /automode from Designer to start it.');
	}
	if (trimmed.startsWith("paths.plan.") || trimmed.startsWith("paths.design.")) {
		throw new Error(`Cannot set nested keys under ${trimmed.startsWith("paths.plan.") ? "paths.plan" : "paths.design"}; those keys are scalar path values.`);
	}
	return trimmed;
}

function mergeErrors(...messages: Array<string | undefined>): string | undefined {
	const filtered = messages.filter((message): message is string => typeof message === "string" && message.trim().length > 0);
	return filtered.length > 0 ? filtered.join("\n") : undefined;
}

export function buildPromptVars(cwd: string, modeId?: string): VarsState {
	const writeLocation = readWriteLocation(cwd);
	const varsFileName = writeLocation.varsFileName;
	const project = readScopeConfig(cwd, "project", varsFileName);
	const global = readScopeConfig(cwd, "global", varsFileName);
	const mergedConfig = deepMergeConfig(global.config, project.config);
	const storedVars = flattenConfigVars(mergedConfig);
	const builtInPromptVars = getBuiltInPromptVars(cwd, modeId, mergedConfig);
	return {
		configPath: writeLocation.value === "project"
			? getProjectVarsConfigPath(cwd, varsFileName)
			: getGlobalVarsConfigPath(varsFileName),
		configError: mergeErrors(project.error, global.error, writeLocation.error),
		config: mergedConfig,
		globalConfig: global.config,
		projectConfig: project.config,
		storedVars,
		promptVars: getPromptInterpolationVars(storedVars, builtInPromptVars),
		writeLocation: writeLocation.value,
		varsFileName,
		writeConfigPath: writeLocation.path,
		projectConfigPath: getProjectVarsConfigPath(cwd, varsFileName),
		globalConfigPath: getGlobalVarsConfigPath(varsFileName),
		projectReadPath: project.actualPath,
		globalReadPath: global.actualPath,
	};
}

export function interpolatePrompt(text: string, vars: PromptVarMap): string {
	return text.replace(/\\\$\{([^}]+)\}|\$\{([^}]+)\}/g, (match, escapedKey: string | undefined, rawKey: string | undefined) => {
		if (escapedKey !== undefined) return `\${${escapedKey}}`;
		const key = (rawKey ?? "").trim();
		return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : match;
	});
}

export function getVisibleVars(state: VarsState): PromptVarMap {
	return state.promptVars;
}

export function getVarValue(state: VarsState, key: string): string | undefined {
	const vars = getVisibleVars(state);
	return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
}

export function getRawStoredVarValue(state: VarsState, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(state.storedVars, key) ? state.storedVars[key] : undefined;
}

export function getWriteLocation(state: VarsState): PiLocation {
	return state.writeLocation;
}

export function getMergedStoredVarValue(cwd: string, key: string): unknown {
	return getRawStoredVarValue(buildPromptVars(cwd), key);
}

export function formatVars(vars: PromptVarMap): string {
	return Object.keys(vars)
		.sort((left, right) => left.localeCompare(right))
		.map((key) => `${key}=${JSON.stringify(vars[key] ?? "")}`)
		.join("\n");
}

export function formatMutationResult(key: string, state: VarsState): string {
	const lines: string[] = [];
	const rawValue = getRawStoredVarValue(state, key);
	lines.push(`write-location=${JSON.stringify(state.writeLocation)}`);
	lines.push(`config-path=${JSON.stringify(state.configPath)}`);
	if (rawValue === undefined) {
		lines.push(`unset ${key}`);
	} else {
		lines.push(`${key}=${JSON.stringify(rawValue)}`);
	}
	if (key === "paths" || key === "paths.plan") {
		lines.push(`plan.path=${JSON.stringify(state.promptVars["plan.path"] ?? "")}`);
		lines.push(`plan.exists=${JSON.stringify(state.promptVars["plan.exists"] ?? "")}`);
	}
	if (key === "paths" || key === "paths.design") {
		lines.push(`design.path=${JSON.stringify(state.promptVars["design.path"] ?? "")}`);
		lines.push(`design.exists=${JSON.stringify(state.promptVars["design.exists"] ?? "")}`);
	}
	return lines.join("\n");
}

export function bootstrapVarsFiles(cwd: string, modeId?: string): VarsBootstrapResult {
	const writeLocation = readWriteLocation(cwd, false);
	const created: string[] = [];
	const existing: string[] = [];
	const writeConfigPath = getWriteLocationConfigPath(cwd);
	if (!fs.existsSync(writeConfigPath)) {
		writeWriteLocation(cwd, writeLocation.value, writeLocation.varsFileName);
		created.push(writeConfigPath);
	} else {
		existing.push(writeConfigPath);
	}

	const globalBeforeBootstrap = readScopeConfig(cwd, "global", writeLocation.varsFileName);
	const projectVarsPath = getProjectVarsConfigPath(cwd, writeLocation.varsFileName);
	if (!fs.existsSync(projectVarsPath)) {
		const initialConfig = defaultProjectBootstrapVarsConfig(globalBeforeBootstrap.config);
		fs.mkdirSync(path.dirname(projectVarsPath), { recursive: true });
		fs.writeFileSync(projectVarsPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
		created.push(projectVarsPath);
	} else {
		existing.push(projectVarsPath);
	}

	// Also ensure the global vars file exists so bootstrap is complete regardless
	// of which location writes go to. This avoids surprises when the user later
	// switches write-location to "global" or uses global-scoped vars.
	const globalVarsPath = getGlobalVarsConfigPath(writeLocation.varsFileName);
	if (!fs.existsSync(globalVarsPath)) {
		const initialConfig = defaultBootstrapVarsConfig();
		fs.mkdirSync(path.dirname(globalVarsPath), { recursive: true });
		fs.writeFileSync(globalVarsPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
		created.push(globalVarsPath);
	} else {
		existing.push(globalVarsPath);
	}

	return {
		state: buildPromptVars(cwd, modeId),
		created,
		existing,
	};
}

export function formatBootstrapResult(result: VarsBootstrapResult): string {
	const lines: string[] = [
		`${WRITE_LOCATION_KEY}=${JSON.stringify(result.state.writeLocation)}`,
		`${WRITE_FILE_NAME_KEY}=${JSON.stringify(result.state.varsFileName)}`,
	];
	if (result.created.length > 0) {
		lines.push(`created=${JSON.stringify(result.created)}`);
	}
	if (result.existing.length > 0) {
		lines.push(`existing=${JSON.stringify(result.existing)}`);
	}
	return lines.join("\n");
}

export function formatWriteLocation(state: VarsState): string {
	return [
		`${WRITE_LOCATION_KEY}=${JSON.stringify(state.writeLocation)}`,
		`${WRITE_FILE_NAME_KEY}=${JSON.stringify(state.varsFileName)}`,
		`write-config-path=${JSON.stringify(state.writeConfigPath)}`,
		`project-config-path=${JSON.stringify(state.projectConfigPath)}`,
		`global-config-path=${JSON.stringify(state.globalConfigPath)}`,
	].join("\n");
}

export function setWriteLocation(cwd: string, location: PiLocation, modeId?: string): VarsState {
	const current = readWriteLocation(cwd);
	writeWriteLocation(cwd, normalizeWriteLocation(location), current.varsFileName);
	return buildPromptVars(cwd, modeId);
}

function setVarInternal(cwd: string, key: string, value: unknown, modeId: string | undefined, options?: { allowAutomodeEnable?: boolean; writeLocationOverride?: PiLocation }): VarsState {
	const normalizedKey = validateMutableVarKey(key);
	if ((normalizedKey === "paths.plan" || normalizedKey === "paths.design") && typeof value !== "string") {
		throw new Error(`${normalizedKey} must be a string path.`);
	}
	if ((normalizedKey === "paths.plan" || normalizedKey === "paths.design") && !value.trim()) {
		throw new Error(`value is required for key ${normalizedKey}.`);
	}
	if (normalizedKey === "automode.enabled" && typeof value !== "boolean") {
		throw new Error("automode.enabled must be a boolean.");
	}
	if (normalizedKey === "automode.enabled" && value === true && options?.allowAutomodeEnable !== true) {
		throw new Error('Cannot set automode.enabled=true directly. Start automode with /automode from Designer mode.');
	}

	const currentWriteLocation = ensureWriteLocationConfig(cwd);
	const writeLocation = {
		value: normalizedKey === "automode.enabled" ? "project" : options?.writeLocationOverride ?? currentWriteLocation.value,
		varsFileName: currentWriteLocation.varsFileName,
	};
	const { config } = readScopeConfig(cwd, writeLocation.value, writeLocation.varsFileName, true);
	const nextConfig = setNestedValue(config, normalizedKey, value);
	writeVarsConfig(cwd, nextConfig, writeLocation.value, writeLocation.varsFileName);
	return buildPromptVars(cwd, modeId);
}

export function setVar(cwd: string, key: string, value: unknown, modeId?: string): VarsState {
	return setVarInternal(cwd, key, value, modeId);
}

export function setAutomodeEnabled(cwd: string, enabled: boolean, modeId?: string): VarsState {
	return setVarInternal(cwd, "automode.enabled", enabled, modeId, { allowAutomodeEnable: enabled, writeLocationOverride: "project" });
}

export function unsetVar(cwd: string, key: string, modeId?: string): VarsState {
	const normalizedKey = validateMutableVarKey(key);
	const currentWriteLocation = ensureWriteLocationConfig(cwd);
	const writeLocation = {
		value: normalizedKey === "automode.enabled" ? "project" : currentWriteLocation.value,
		varsFileName: currentWriteLocation.varsFileName,
	};
	const { config } = readScopeConfig(cwd, writeLocation.value, writeLocation.varsFileName, true);
	const nextConfig = unsetNestedValue(config, normalizedKey);
	writeVarsConfig(cwd, nextConfig, writeLocation.value, writeLocation.varsFileName);
	return buildPromptVars(cwd, modeId);
}

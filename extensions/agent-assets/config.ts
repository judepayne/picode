import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentAssetDiagnostic } from "./contract.ts";

const SETTINGS_FILE_NAME = "settings.json";
const CONFIG_SECTION_KEY = "picode";
const ENV_AGENT_DIR = "PICODE_AGENT_DIR";
const ENV_SUBAGENT_DIR = "PICODE_SUBAGENT_DIR";

interface PicodeSettingsShape {
	agentsDir?: unknown;
	subagentsDir?: unknown;
}

export interface ResolvedAgentAssetsConfig {
	agentsDir?: string;
	subagentsDir?: string;
	projectConfigPath: string;
	globalConfigPath: string;
	diagnostics: AgentAssetDiagnostic[];
}

interface ReadConfigFileResult {
	config: PicodeSettingsShape;
	configPath: string;
	exists: boolean;
}

function pushDiagnostic(
	diagnostics: AgentAssetDiagnostic[],
	message: string,
	filePath?: string,
	severity: AgentAssetDiagnostic["severity"] = "warning",
): void {
	diagnostics.push({ severity, message, ...(filePath ? { filePath } : {}) });
}

function resolveHomeDir(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", SETTINGS_FILE_NAME);
}

export function getGlobalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const homeDir = env.HOME ?? env.USERPROFILE ?? resolveHomeDir();
	return path.join(homeDir, ".pi", "agent", SETTINGS_FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfigFile(configPath: string, diagnostics: AgentAssetDiagnostic[]): ReadConfigFileResult {
	if (!fs.existsSync(configPath)) {
		return { config: {}, configPath, exists: false };
	}

	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed)) {
			pushDiagnostic(diagnostics, `${configPath} must contain a JSON object.`, configPath, "error");
			return { config: {}, configPath, exists: true };
		}
		const section = parsed[CONFIG_SECTION_KEY];
		if (section === undefined) return { config: {}, configPath, exists: true };
		if (!isPlainObject(section)) {
			pushDiagnostic(diagnostics, `${configPath} must set ${CONFIG_SECTION_KEY} to a JSON object.`, configPath, "error");
			return { config: {}, configPath, exists: true };
		}
		return { config: section as PicodeSettingsShape, configPath, exists: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushDiagnostic(diagnostics, `Failed to read ${configPath}: ${message}`, configPath, "error");
		return { config: {}, configPath, exists: true };
	}
}

function resolveConfigPathValue(value: unknown, baseDir: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(baseDir, trimmed);
}

function applyConfigShape(
	resolved: ResolvedAgentAssetsConfig,
	shape: PicodeSettingsShape,
	configPath: string,
	diagnostics: AgentAssetDiagnostic[],
): void {
	const baseDir = path.dirname(configPath);
	const agentsDir = resolveConfigPathValue(shape.agentsDir, baseDir);
	if (shape.agentsDir !== undefined && agentsDir === undefined) {
		pushDiagnostic(diagnostics, `${configPath} contains an invalid ${CONFIG_SECTION_KEY}.agentsDir value.`, configPath, "error");
	}
	const subagentsDir = resolveConfigPathValue(shape.subagentsDir, baseDir);
	if (shape.subagentsDir !== undefined && subagentsDir === undefined) {
		pushDiagnostic(diagnostics, `${configPath} contains an invalid ${CONFIG_SECTION_KEY}.subagentsDir value.`, configPath, "error");
	}
	if (agentsDir) resolved.agentsDir = agentsDir;
	if (subagentsDir) resolved.subagentsDir = subagentsDir;
}

function resolveEnvPath(value: string | undefined, cwd: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

function applyEnvOverrides(
	resolved: ResolvedAgentAssetsConfig,
	cwd: string,
	env: NodeJS.ProcessEnv,
	diagnostics: AgentAssetDiagnostic[],
): void {
	const agentsDir = resolveEnvPath(env[ENV_AGENT_DIR], cwd);
	if (env[ENV_AGENT_DIR] !== undefined && agentsDir === undefined) {
		pushDiagnostic(diagnostics, `${ENV_AGENT_DIR} is set but empty or invalid.`, undefined, "error");
	}
	const subagentsDir = resolveEnvPath(env[ENV_SUBAGENT_DIR], cwd);
	if (env[ENV_SUBAGENT_DIR] !== undefined && subagentsDir === undefined) {
		pushDiagnostic(diagnostics, `${ENV_SUBAGENT_DIR} is set but empty or invalid.`, undefined, "error");
	}
	if (agentsDir) resolved.agentsDir = agentsDir;
	if (subagentsDir) resolved.subagentsDir = subagentsDir;
}

export function loadAgentAssetsConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedAgentAssetsConfig {
	const diagnostics: AgentAssetDiagnostic[] = [];
	const globalConfigPath = getGlobalSettingsPath(env);
	const projectConfigPath = getProjectSettingsPath(cwd);
	const resolved: ResolvedAgentAssetsConfig = {
		globalConfigPath,
		projectConfigPath,
		diagnostics,
	};

	const globalConfig = readConfigFile(globalConfigPath, diagnostics);
	applyConfigShape(resolved, globalConfig.config, globalConfig.configPath, diagnostics);

	const projectConfig = readConfigFile(projectConfigPath, diagnostics);
	applyConfigShape(resolved, projectConfig.config, projectConfig.configPath, diagnostics);

	applyEnvOverrides(resolved, cwd, env, diagnostics);
	return resolved;
}

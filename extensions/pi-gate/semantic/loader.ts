import * as fs from "node:fs";
import * as path from "node:path";

import { isGateSemanticSubject } from "./types.ts";
import type { GateSemanticConfig, GateSemanticRuleMap, LoadedGateSemanticConfig } from "./types.ts";

const AUTO_CONFIG_FILE = "auto.json";
const AUTO_SCHEMA_FILE = "auto.schema.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRuleMap(value: unknown, scope: string): string | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return `${scope} must be an object`;
	for (const [subject, patterns] of Object.entries(value)) {
		if (!isGateSemanticSubject(subject)) return `${scope}.${subject} is not a supported auto subject`;
		if (!Array.isArray(patterns)) return `${scope}.${subject} must be an array of strings`;
		for (const [index, pattern] of patterns.entries()) {
			if (typeof pattern !== "string" || !pattern.trim()) return `${scope}.${subject}[${index}] must be a non-empty string`;
		}
	}
	return undefined;
}

function validateRoleMap(value: unknown, scope: string): string | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return `${scope} must be an object`;
	for (const [roleName, role] of Object.entries(value)) {
		if (!roleName.trim()) return `${scope} role names must not be empty`;
		if (!isPlainObject(role)) return `${scope}.${roleName} must be an object`;
		if (typeof role.guidance !== "string" || !role.guidance.trim()) return `${scope}.${roleName}.guidance must be a non-empty string`;
		const hardDenyError = validateRuleMap(role.hardDeny, `${scope}.${roleName}.hardDeny`);
		if (hardDenyError) return hardDenyError;
		const alwaysAllowError = validateRuleMap(role.alwaysAllow, `${scope}.${roleName}.alwaysAllow`);
		if (alwaysAllowError) return alwaysAllowError;
	}
	return undefined;
}

export function validateAutoConfigSemantics(config: unknown): string | undefined {
	if (!isPlainObject(config)) return "auto config must be an object";
	for (const key of Object.keys(config)) {
		if (!["$schema", "hardDeny", "alwaysAllow", "agents", "subagents"].includes(key)) return `auto config key ${JSON.stringify(key)} is not allowed`;
	}
	if (config.$schema !== undefined && typeof config.$schema !== "string") return "$schema must be a string";
	const hardDenyError = validateRuleMap(config.hardDeny, "hardDeny");
	if (hardDenyError) return hardDenyError;
	const alwaysAllowError = validateRuleMap(config.alwaysAllow, "alwaysAllow");
	if (alwaysAllowError) return alwaysAllowError;
	const agentError = validateRoleMap(config.agents, "agents");
	if (agentError) return agentError;
	const subagentError = validateRoleMap(config.subagents, "subagents");
	if (subagentError) return subagentError;
	return undefined;
}

export function getGateSemanticConfigPath(extensionDir: string, cwd: string): string {
	const projectPath = path.join(cwd, ".pi", AUTO_CONFIG_FILE);
	return fs.existsSync(projectPath) ? projectPath : path.join(extensionDir, AUTO_CONFIG_FILE);
}

export function loadGateSemanticConfig(extensionDir: string, cwd: string): LoadedGateSemanticConfig {
	const configPath = getGateSemanticConfigPath(extensionDir, cwd);
	const schemaPath = path.join(extensionDir, AUTO_SCHEMA_FILE);
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
		const error = validateAutoConfigSemantics(parsed);
		if (error) return { configPath, schemaPath, error: `auto config validation failed! ${error}. Tool calls are blocked until auto config is fixed.` };
		return { config: parsed as GateSemanticConfig, configPath, schemaPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { configPath, schemaPath, error: `failed to load gate auto config: ${message}. Tool calls are blocked until auto config is fixed.` };
	}
}

export function cloneRuleMap(map: GateSemanticRuleMap | undefined): GateSemanticRuleMap {
	const out: GateSemanticRuleMap = {};
	for (const [subject, patterns] of Object.entries(map ?? {})) out[subject as keyof GateSemanticRuleMap] = [...patterns];
	return out;
}

import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentAssetDiagnostic, AgentAssetFile, AgentAssetKind } from "./contract.ts";
import { loadAgentAssetsConfig, type AgentAssetConflictPolicy, type ResolvedAgentAssetsConfig } from "./config.ts";

export interface ResolvedAgentAssetManifest {
	agents: AgentAssetFile[];
	subagents: AgentAssetFile[];
	diagnostics: AgentAssetDiagnostic[];
	config: ResolvedAgentAssetsConfig;
}

export interface ResolveAgentAssetManifestOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	nativeAgentsDir: string;
	nativeSubagentsDir: string;
}

function pushDiagnostic(
	diagnostics: AgentAssetDiagnostic[],
	message: string,
	filePath?: string,
	severity: AgentAssetDiagnostic["severity"] = "warning",
): void {
	diagnostics.push({ severity, message, ...(filePath ? { filePath } : {}) });
}

function listMarkdownFiles(dirPath: string, diagnostics: AgentAssetDiagnostic[]): string[] {
	try {
		return fs
			.readdirSync(dirPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushDiagnostic(diagnostics, `Failed to read asset directory ${dirPath}: ${message}`, dirPath, "error");
		return [];
	}
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "mode";
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function readFrontmatterName(filePath: string): string | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+?)\s*$/m);
		const name = nameMatch?.[1] ? unquote(nameMatch[1]) : undefined;
		return typeof name === "string" && name.trim() ? name.trim() : undefined;
	} catch {
		return undefined;
	}
}

function logicalIdentityForFile(file: AgentAssetFile): string {
	const frontmatterName = readFrontmatterName(file.filePath);
	if (file.kind === "agent") {
		return slugify(frontmatterName ?? path.basename(file.fileName, ".md"));
	}
	return (frontmatterName ?? path.basename(file.fileName, ".md")).trim().toLowerCase();
}

function validateLogicalIdentities(kind: AgentAssetKind, files: AgentAssetFile[], diagnostics: AgentAssetDiagnostic[]): void {
	const seen = new Map<string, AgentAssetFile>();
	for (const file of files) {
		const logicalId = logicalIdentityForFile(file);
		const previous = seen.get(logicalId);
		if (previous) {
			pushDiagnostic(
				diagnostics,
				`Duplicate ${kind} logical identity "${logicalId}" resolved from ${previous.fileName} and ${file.fileName}.`,
				file.filePath,
				"warning",
			);
			continue;
		}
		seen.set(logicalId, file);
	}
}

function buildNativeFiles(kind: AgentAssetKind, dirPath: string, diagnostics: AgentAssetDiagnostic[]): AgentAssetFile[] {
	if (!fs.existsSync(dirPath)) {
		pushDiagnostic(diagnostics, `Native ${kind} asset directory not found: ${dirPath}`, dirPath, "error");
		return [];
	}
	return listMarkdownFiles(dirPath, diagnostics).map((fileName) => ({
		kind,
		fileName,
		filePath: path.join(dirPath, fileName),
		origin: "native" as const,
	}));
}

function buildUserFiles(kind: AgentAssetKind, dirPath: string | undefined, diagnostics: AgentAssetDiagnostic[]): AgentAssetFile[] {
	if (!dirPath) return [];
	if (!fs.existsSync(dirPath)) {
		pushDiagnostic(diagnostics, `Configured ${kind} overlay directory does not exist: ${dirPath}`, dirPath, "warning");
		return [];
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dirPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushDiagnostic(diagnostics, `Failed to stat configured ${kind} overlay directory ${dirPath}: ${message}`, dirPath, "error");
		return [];
	}
	if (!stat.isDirectory()) {
		pushDiagnostic(diagnostics, `Configured ${kind} overlay path is not a directory: ${dirPath}`, dirPath, "error");
		return [];
	}
	return listMarkdownFiles(dirPath, diagnostics).map((fileName) => ({
		kind,
		fileName,
		filePath: path.join(dirPath, fileName),
		origin: "user" as const,
	}));
}

function mergeFiles(
	kind: AgentAssetKind,
	nativeFiles: AgentAssetFile[],
	userFiles: AgentAssetFile[],
	policy: AgentAssetConflictPolicy,
	diagnostics: AgentAssetDiagnostic[],
): AgentAssetFile[] {
	const effective = new Map<string, AgentAssetFile>();
	for (const file of nativeFiles) effective.set(file.fileName.toLowerCase(), file);
	for (const userFile of userFiles) {
		const key = userFile.fileName.toLowerCase();
		const existing = effective.get(key);
		if (!existing) {
			effective.set(key, userFile);
			continue;
		}
		if (policy === "prefer-user") {
			effective.set(key, { ...userFile, shadowedFilePath: existing.filePath });
			continue;
		}
		pushDiagnostic(
			diagnostics,
			`Ignoring user ${kind} override ${userFile.fileName} because conflict policy is prefer-native.`,
			userFile.filePath,
			"warning",
		);
	}
	return [...effective.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export function resolveAgentAssetManifest(options: ResolveAgentAssetManifestOptions): ResolvedAgentAssetManifest {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const config = loadAgentAssetsConfig(cwd, env);
	const diagnostics = [...config.diagnostics];

	const nativeAgents = buildNativeFiles("agent", options.nativeAgentsDir, diagnostics);
	const nativeSubagents = buildNativeFiles("subagent", options.nativeSubagentsDir, diagnostics);
	const userAgents = buildUserFiles("agent", config.agentsDir, diagnostics);
	const userSubagents = buildUserFiles("subagent", config.subagentsDir, diagnostics);

	const agents = mergeFiles("agent", nativeAgents, userAgents, config.agentsOnConflict, diagnostics);
	const subagents = mergeFiles("subagent", nativeSubagents, userSubagents, config.subagentsOnConflict, diagnostics);

	validateLogicalIdentities("agent", agents, diagnostics);
	validateLogicalIdentities("subagent", subagents, diagnostics);

	return {
		agents,
		subagents,
		diagnostics,
		config: { ...config, diagnostics },
	};
}

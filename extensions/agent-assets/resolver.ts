import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentAssetCard, AgentAssetDiagnostic, AgentAssetKind } from "./contract.ts";
import { loadAgentAssetsConfig, type ResolvedAgentAssetsConfig } from "./config.ts";

export interface ResolvedAgentAssetManifest {
	agents: AgentAssetCard[];
	subagents: AgentAssetCard[];
	diagnostics: AgentAssetDiagnostic[];
	config: ResolvedAgentAssetsConfig;
}

export interface ResolveAgentAssetManifestOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	nativeAgentsDir: string;
	nativeSubagentsDir: string;
}

interface InternalCardEntry {
	fileName: string;
	filePath: string;
	orderKey: string;
	card: AgentAssetCard;
	valueSourceDirs: Record<string, string>;
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

function parseStringList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const unquoted = unquote(trimmed);
	const list = unquoted.startsWith("[") && unquoted.endsWith("]") ? unquoted.slice(1, -1) : unquoted;
	const out: string[] = [];
	for (const entry of list.split(",")) {
		const item = unquote(entry).trim();
		if (item) out.push(item);
	}
	return out;
}

function resolveExtensionPath(rawPath: string, sourceDir: string): string {
	const expanded = rawPath === "~"
		? os.homedir()
		: rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")
			? path.join(os.homedir(), rawPath.slice(2))
			: rawPath;
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(sourceDir, expanded);
}

function resolveExtensionsValue(value: string, sourceDir: string): string | undefined {
	const entries = parseStringList(value);
	// Support the `-` sentinel convention (same as model/thinking):
	// writing `extensions: -` in an overlay clears inherited extensions.
	if (entries.length === 1 && entries[0] === "-") return undefined;
	const resolved = entries.map((entry) => resolveExtensionPath(entry, sourceDir));
	return resolved.length > 0 ? resolved.join(", ") : undefined;
}

function parseFrontmatterToCard(raw: string, sourceDir: string): { card: AgentAssetCard; valueSourceDirs: Record<string, string> } {
	const card: AgentAssetCard = {};
	const valueSourceDirs: Record<string, string> = {};
	const lines = raw.split(/\r?\n/);
	let bodyStartIndex = 0;

	if (lines[0]?.trim() === "---") {
		let endIndex = -1;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (line.trim() === "---") {
				endIndex = i;
				break;
			}
			const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
			if (!match) continue;
			const key = match[1];
			const value = (match[2] ?? "").trim();
			if (!value) continue;
			card[key] = value;
			valueSourceDirs[key] = sourceDir;
		}
		if (endIndex >= 0) {
			bodyStartIndex = endIndex + 1;
		} else {
			bodyStartIndex = 0;
		}
	}

	const prompt = lines.slice(bodyStartIndex).join("\n").trim();
	if (prompt) {
		card.prompt = prompt;
		valueSourceDirs.prompt = sourceDir;
	}

	return { card, valueSourceDirs };
}

function parseCardFile(
	kind: AgentAssetKind,
	filePath: string,
	fileName: string,
	diagnostics: AgentAssetDiagnostic[],
): InternalCardEntry | undefined {
	try {
		const sourceDir = path.dirname(filePath);
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = parseFrontmatterToCard(raw, sourceDir);
		return {
			fileName,
			filePath,
			orderKey: fileName.toLowerCase(),
			card: parsed.card,
			valueSourceDirs: parsed.valueSourceDirs,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pushDiagnostic(diagnostics, `Failed to read ${kind} card ${filePath}: ${message}`, filePath, "error");
		return undefined;
	}
}

function buildNativeEntries(kind: AgentAssetKind, dirPath: string, diagnostics: AgentAssetDiagnostic[]): InternalCardEntry[] {
	if (!fs.existsSync(dirPath)) {
		pushDiagnostic(diagnostics, `Native ${kind} asset directory not found: ${dirPath}`, dirPath, "error");
		return [];
	}
	return listMarkdownFiles(dirPath, diagnostics)
		.map((fileName) => parseCardFile(kind, path.join(dirPath, fileName), fileName, diagnostics))
		.filter((entry): entry is InternalCardEntry => Boolean(entry));
}

function buildUserEntries(kind: AgentAssetKind, dirPath: string | undefined, diagnostics: AgentAssetDiagnostic[]): InternalCardEntry[] {
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
	return listMarkdownFiles(dirPath, diagnostics)
		.map((fileName) => parseCardFile(kind, path.join(dirPath, fileName), fileName, diagnostics))
		.filter((entry): entry is InternalCardEntry => Boolean(entry));
}

function mergeCardMaps(base: AgentAssetCard, overlay: AgentAssetCard): AgentAssetCard {
	return { ...base, ...overlay };
}

function mergeCardEntries(nativeEntry: InternalCardEntry, userEntry: InternalCardEntry): InternalCardEntry {
	return {
		...nativeEntry,
		card: mergeCardMaps(nativeEntry.card, userEntry.card),
		valueSourceDirs: { ...nativeEntry.valueSourceDirs, ...userEntry.valueSourceDirs },
	};
}

function normalizeCardName(_kind: AgentAssetKind, name: string): string {
	return slugify(name);
}

function finalizeCard(entry: InternalCardEntry): AgentAssetCard {
	const card = { ...entry.card };
	const extensionsSourceDir = entry.valueSourceDirs.extensions;
	if (card.extensions && extensionsSourceDir) {
		const extensions = resolveExtensionsValue(card.extensions, extensionsSourceDir);
		if (extensions) card.extensions = extensions;
		else delete card.extensions;
	}
	return card;
}

function validateAndFilterCards(
	kind: AgentAssetKind,
	entries: InternalCardEntry[],
	diagnostics: AgentAssetDiagnostic[],
): AgentAssetCard[] {
	const seen = new Map<string, InternalCardEntry>();
	const out: AgentAssetCard[] = [];
	for (const entry of entries) {
		const card = finalizeCard(entry);
		const name = card.name ? unquote(card.name).trim() : "";
		if (!name) {
			pushDiagnostic(diagnostics, `Skipping ${kind} card ${entry.fileName} because it does not define a name.`, entry.filePath, "error");
			continue;
		}
		const logicalId = normalizeCardName(kind, name);
		const previous = seen.get(logicalId);
		if (previous) {
			pushDiagnostic(
				diagnostics,
				`Duplicate ${kind} name "${name}" resolved from ${previous.fileName} and ${entry.fileName}; skipping ${entry.fileName}.`,
				entry.filePath,
				"warning",
			);
			continue;
		}
		seen.set(logicalId, entry);
		out.push(card);
	}
	return out;
}

function mergeEntries(
	kind: AgentAssetKind,
	nativeEntries: InternalCardEntry[],
	userEntries: InternalCardEntry[],
	diagnostics: AgentAssetDiagnostic[],
): AgentAssetCard[] {
	const effective = new Map<string, InternalCardEntry>();
	for (const entry of nativeEntries) effective.set(entry.fileName.toLowerCase(), entry);
	for (const userEntry of userEntries) {
		const key = userEntry.fileName.toLowerCase();
		const existing = effective.get(key);
		effective.set(key, existing ? mergeCardEntries(existing, userEntry) : userEntry);
	}
	const entries = [...effective.values()].sort((a, b) => a.orderKey.localeCompare(b.orderKey));
	return validateAndFilterCards(kind, entries, diagnostics);
}

export function resolveAgentAssetManifest(options: ResolveAgentAssetManifestOptions): ResolvedAgentAssetManifest {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const config = loadAgentAssetsConfig(cwd, env);
	const diagnostics = [...config.diagnostics];

	const nativeAgents = buildNativeEntries("agent", options.nativeAgentsDir, diagnostics);
	const nativeSubagents = buildNativeEntries("subagent", options.nativeSubagentsDir, diagnostics);
	const userAgents = buildUserEntries("agent", config.agentsDir, diagnostics);
	const userSubagents = buildUserEntries("subagent", config.subagentsDir, diagnostics);

	const agents = mergeEntries("agent", nativeAgents, userAgents, diagnostics);
	const subagents = mergeEntries("subagent", nativeSubagents, userSubagents, diagnostics);

	return {
		agents,
		subagents,
		diagnostics,
		config: { ...config, diagnostics },
	};
}

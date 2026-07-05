import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { collectAgentAssetDiagnostics, collectAgentCards, type AgentAssetCard } from "../agent-assets/contract.ts";
import { normalizeOptionalFrontmatterString, unquote } from "../agent-assets/frontmatter-values.ts";
import { parseToolSelection, resolveToolSelection, type ToolSelectionSpec } from "../agent-assets/tool-selection.ts";
import { buildPromptVars, getVarValue, setAutomodeEnabled } from "../z-prompt-vars/prompt-vars.ts";
import { isDelegatedSubagentChildProcess } from "./runtime.ts";
const SETTINGS_FILE_NAME = "settings.json";
const MODE_STATUS_KEY = "agent-mode";
const MODE_STATE_ENTRY_TYPE = "agent-mode-state";
const MODE_HANDOFF_MESSAGE_TYPE = "agent-mode-handoff";
const LEGACY_MODE_CONTEXT_MESSAGE_TYPE = "agent-mode-context";
const GATE_SWITCH_PROFILE_EVENT = "gate:switch-profile";

const NAMED_COLORS: Record<string, [number, number, number]> = {
	black: [0, 0, 0],
	white: [255, 255, 255],
	red: [255, 0, 0],
	green: [0, 170, 0],
	blue: [0, 102, 255],
	yellow: [255, 215, 0],
	orange: [255, 140, 0],
	purple: [128, 0, 128],
	magenta: [255, 0, 255],
	cyan: [0, 200, 255],
	gray: [128, 128, 128],
	grey: [128, 128, 128],
	pink: [255, 105, 180],
};

const READ_ONLY_BASH_BLOCKLIST = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b(?=.*\bof=)/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
	/\byarn\s+(add|remove|install|publish)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bapt(?:-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(?:vim?|nano|emacs|code|subl)\b/i,
];

const READ_ONLY_BASH_ALLOWLIST = [
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*grep\b/i,
	/^\s*find\b/i,
	/^\s*ls\b/i,
	/^\s*pwd\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*diff\b/i,
	/^\s*file\b/i,
	/^\s*stat\b/i,
	/^\s*du\b/i,
	/^\s*df\b/i,
	/^\s*tree\b/i,
	/^\s*which\b/i,
	/^\s*whereis\b/i,
	/^\s*type\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*cal\b/i,
	/^\s*uptime\b/i,
	/^\s*ps\b/i,
	/^\s*top\b/i,
	/^\s*htop\b/i,
	/^\s*free\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\s+--version\b/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*bat\b/i,
	/^\s*exa\b/i,
];

type BashPolicy = "full" | "read-only";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModeDefinition {
	id: string;
	name: string;
	description?: string;
	profile: string;
	color?: string;
	toolSelection: ToolSelectionSpec;
	bannedSubagents?: string[];
	bashPolicy: BashPolicy;
	thinkingLevel?: ThinkingLevel;
	model?: string;
	instructions: string;
}

interface ModeSettings {
	nextShortcut?: string;
	prevShortcut?: string;
}

interface CustomSessionEntry {
	id?: string;
	parentId?: string | null;
	type?: string;
	customType?: string;
	data?: {
		modeId?: string;
		subagents?: string[];
		bannedSubagents?: string[];
	};
}

interface LegacyCleanupResult {
	removedCount: number;
	error?: string;
}

function rewriteSessionFileRemovingLegacyModeContext(sessionFile: string | undefined): LegacyCleanupResult {
	if (!sessionFile) return { removedCount: 0 };
	try {
		if (!fs.existsSync(sessionFile)) return { removedCount: 0 };
		const raw = fs.readFileSync(sessionFile, "utf8");
		if (!raw.includes(LEGACY_MODE_CONTEXT_MESSAGE_TYPE)) return { removedCount: 0 };

		const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
		const removedParents = new Map<string, string | null>();
		const keptEntries: Record<string, unknown>[] = [];
		let removedCount = 0;

		for (const line of lines) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (
				entry.type === "custom_message" &&
				entry.customType === LEGACY_MODE_CONTEXT_MESSAGE_TYPE &&
				typeof entry.id === "string"
			) {
				removedParents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
				removedCount += 1;
				continue;
			}
			keptEntries.push(entry);
		}

		if (removedCount === 0) return { removedCount: 0 };

		for (const entry of keptEntries) {
			let parentId = typeof entry.parentId === "string" ? entry.parentId : null;
			const seen = new Set<string>();
			while (parentId && removedParents.has(parentId) && !seen.has(parentId)) {
				seen.add(parentId);
				parentId = removedParents.get(parentId) ?? null;
			}
			if (parentId === null) delete entry.parentId;
			else if (typeof entry.parentId === "string" && entry.parentId !== parentId) entry.parentId = parentId;
		}

		// Write to a temp file then rename for atomic replacement, reducing the
		// risk of interleaving with concurrent session appends during startup.
		const tmpFile = `${sessionFile}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		fs.writeFileSync(tmpFile, `${keptEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		fs.renameSync(tmpFile, sessionFile);
		return { removedCount };
	} catch (error) {
		return {
			removedCount: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseRgbColor(value: string): [number, number, number] | undefined {
	const trimmed = value.trim();
	const named = NAMED_COLORS[trimmed.toLowerCase()];
	if (named) return named;

	const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;

	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return [r, g, b];
}

function formatStatusText(text: string, color?: string): string {
	const rgb = color ? parseRgbColor(color) : undefined;
	if (!rgb) {
		return `\u001b[1m${text}\u001b[0m`;
	}
	const [r, g, b] = rgb;
	return `\u001b[1;38;2;${r};${g};${b}m${text}\u001b[0m`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "mode";
}

function parseCommaList(value: string | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	const list = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return list
		.split(",")
		.map((part) => unquote(part).trim().toLowerCase())
		.filter(Boolean);
}

function parseBannedSubagents(value: string | undefined): string[] {
	const parsed = parseCommaList(value);
	return parsed.length === 1 && parsed[0] === "-" ? [] : parsed;
}

function normalizeBashPolicy(value: string | undefined): BashPolicy {
	return value?.trim().toLowerCase() === "read-only" ? "read-only" : "full";
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
		return normalized as ThinkingLevel;
	}
	return undefined;
}

function loadSettings(settingsPath: string): { settings: ModeSettings; error?: string } {
	const defaults: ModeSettings = {
		nextShortcut: "ctrl+.",
		prevShortcut: "ctrl+,",
	};

	try {
		const raw = fs.readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw) as ModeSettings;
		return {
			settings: {
				nextShortcut:
					typeof parsed?.nextShortcut === "string" && parsed.nextShortcut.trim()
						? parsed.nextShortcut.trim()
						: defaults.nextShortcut,
				prevShortcut:
					typeof parsed?.prevShortcut === "string" && parsed.prevShortcut.trim()
						? parsed.prevShortcut.trim()
						: defaults.prevShortcut,
			},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { settings: defaults };
		}
		return {
			settings: defaults,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function modeFromAgentCard(card: AgentAssetCard): ModeDefinition {
	const name = unquote(card.name);
	const bannedSubagents = parseBannedSubagents(card.banned_subagents);

	return {
		id: slugify(name),
		name,
		description: card.description ? unquote(card.description) : undefined,
		profile: unquote(card.profile ?? "default"),
		color: card.color ? unquote(card.color) : undefined,
		toolSelection: parseToolSelection({ tools: card.tools, banTools: card.ban_tools }),
		...(bannedSubagents.length > 0 ? { bannedSubagents } : {}),
		bashPolicy: normalizeBashPolicy(card.bash),
		thinkingLevel: normalizeThinkingLevel(normalizeOptionalFrontmatterString(card.thinking)),
		model: normalizeOptionalFrontmatterString(card.model),
		instructions: card.prompt ?? "",
	};
}

export function buildAgentCommandCompletions(prefix: string, modes: ModeDefinition[]): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const options = [
		{ value: "next", label: "next — switch to the next configured agent" },
		{ value: "prev", label: "prev — switch to the previous configured agent" },
		...modes.map((mode) => ({
			value: mode.name,
			label: mode.description ? `${mode.name} — ${mode.description}` : mode.name,
		})),
	];
	const matches = options.filter((option) => option.value.toLowerCase().startsWith(normalizedPrefix));
	return matches.length > 0 ? matches : null;
}

function isReadOnlyDdCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!/^dd\b/i.test(trimmed)) return false;
	// Keep dd deliberately conservative: shell quoting/escaping can hide `of=`
	// from raw-string checks, so only simple key=value operands are allowed.
	if (/[\\'"`$;&|<>]/.test(trimmed)) return false;
	const tokens = trimmed.split(/\s+/);
	const allowedKeys = new Set(["if", "ibs", "obs", "bs", "cbs", "skip", "iseek", "count", "status", "iflag", "conv"]);
	for (const token of tokens.slice(1)) {
		const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
		if (!match) return false;
		const key = match[1]?.toLowerCase();
		if (!key || key === "of" || !allowedKeys.has(key)) return false;
	}
	return true;
}

export function isReadOnlyBashCommand(command: string): boolean {
	const blocked = READ_ONLY_BASH_BLOCKLIST.some((pattern) => pattern.test(command));
	if (blocked) return false;
	if (/^\s*dd\b/i.test(command)) return isReadOnlyDdCommand(command);
	return READ_ONLY_BASH_ALLOWLIST.some((pattern) => pattern.test(command));
}

export default function agentModeExtension(pi: ExtensionAPI) {
	if (isDelegatedSubagentChildProcess()) return;
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const settingsPath = path.join(extensionDir, SETTINGS_FILE_NAME);
	const { settings, error: settingsError } = loadSettings(settingsPath);

	let modes: ModeDefinition[] = [];
	let currentIndex = 0;
	let pendingModeIndex: number | undefined;
	let loadError: string | undefined;
	let loadWarnings: string[] = [];

	function getCurrentMode(): ModeDefinition | undefined {
		return modes[currentIndex];
	}

	function updateStatus(ctx: ExtensionContext): void {
		const current = getCurrentMode();
		if (current) {
			ctx.ui.setStatus(MODE_STATUS_KEY, formatStatusText(current.name, current.color));
			return;
		}
		ctx.ui.setStatus(MODE_STATUS_KEY, loadError ? formatStatusText("error", "red") : undefined);
	}

	function loadModes(): void {
		loadError = undefined;
		loadWarnings = [];
		pendingModeIndex = undefined;
		const cards = collectAgentCards(pi);
		const diagnostics = collectAgentAssetDiagnostics(pi);
		const discovered = new Map<string, ModeDefinition>();
		let lastError: string | undefined;

		for (const diagnostic of diagnostics) {
			const message = diagnostic.filePath ? `${diagnostic.message} (${diagnostic.filePath})` : diagnostic.message;
			loadWarnings.push(`${diagnostic.severity}: ${message}`);
		}

		for (const card of cards) {
			try {
				const mode = modeFromAgentCard(card);
				if (discovered.has(mode.id)) continue;
				discovered.set(mode.id, mode);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
		}

		modes = [...discovered.values()];

		if (modes.length === 0) {
			loadError = lastError ?? loadWarnings[0] ?? "No agent mode cards resolved from agent-assets.";
		}

		if (currentIndex >= modes.length) {
			currentIndex = 0;
		}
	}

	function findModeIndex(identifier?: string): number {
		if (!identifier) return -1;
		const normalized = identifier.trim().toLowerCase();
		if (!normalized) return -1;
		return modes.findIndex((mode) => mode.id === normalized || mode.name.toLowerCase() === normalized);
	}

	function restoreModeIndexFromSession(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as CustomSessionEntry;
			if (entry?.type !== "custom" || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
			const restoredIndex = findModeIndex(entry.data?.modeId);
			if (restoredIndex >= 0) {
				currentIndex = restoredIndex;
				return;
			}
		}
		currentIndex = 0;
	}

	let lastPersistedModeId: string | undefined;

	function persistCurrentMode(): void {
		const current = getCurrentMode();
		if (!current) return;
		if (current.id === lastPersistedModeId) return;
		lastPersistedModeId = current.id;
		pi.appendEntry(MODE_STATE_ENTRY_TYPE, {
			modeId: current.id,
			...(current.bannedSubagents && current.bannedSubagents.length > 0 ? { bannedSubagents: [...current.bannedSubagents] } : {}),
		});
	}

	function getAvailableToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function getEffectiveTools(mode: ModeDefinition): string[] {
		return resolveToolSelection(mode.toolSelection, {
			defaultMode: "all",
			availableTools: getAvailableToolNames(),
		}).tools;
	}

	function getActiveToolsForMode(mode: ModeDefinition, automodeEnabled: boolean): string[] {
		const tools = getEffectiveTools(mode).filter((tool) => tool !== "switch_agent_mode");
		return automodeEnabled ? [...new Set([...tools, "switch_agent_mode"])] : tools;
	}

	function notifyModeToolWarnings(ctx: ExtensionContext, mode: ModeDefinition): void {
		const resolved = resolveToolSelection(mode.toolSelection, {
			defaultMode: "all",
			availableTools: getAvailableToolNames(),
		});
		if (resolved.unknownRequestedTools.length > 0) {
			ctx.ui.notify(
				`Agent mode ${mode.name}: unknown tools ignored: ${resolved.unknownRequestedTools.join(", ")}`,
				"warning",
			);
		}
		if (resolved.unknownBannedTools.length > 0) {
			ctx.ui.notify(
				`Agent mode ${mode.name}: unknown ban_tools ignored: ${resolved.unknownBannedTools.join(", ")}`,
				"warning",
			);
		}
	}

	async function applyConfiguredModel(ctx: ExtensionContext, mode: ModeDefinition): Promise<void> {
		if (!mode.model) return;
		const currentModel = (ctx as ExtensionContext & { model?: { id?: string; modelID?: string } }).model;
		if (currentModel && [currentModel.id, currentModel.modelID].includes(mode.model)) return;
		if (!mode.model.includes("/")) return;

		const slash = mode.model.indexOf("/");
		const provider = mode.model.slice(0, slash);
		const id = mode.model.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) {
			ctx.ui.notify(`Agent mode: model not found for ${mode.model}`, "warning");
			return;
		}
		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`Agent mode: no API key for ${mode.model}`, "warning");
		}
	}

	async function applyCurrentMode(
		ctx: ExtensionContext,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<void> {
		const current = getCurrentMode();
		updateStatus(ctx);
		if (!current) {
			if (options?.notify ?? true) {
				ctx.ui.notify(loadError ? `Agent mode: ${loadError}` : "Agent mode: no mode selected", "warning");
			}
			return;
		}

		const automodeEnabled = readAutomodeEnabled(ctx, current.id) === "true";
		pi.setActiveTools(getActiveToolsForMode(current, automodeEnabled));
		if (ctx.hasUI) {
			notifyModeToolWarnings(ctx, current);
		}
		if (current.thinkingLevel) {
			pi.setThinkingLevel(current.thinkingLevel);
		}
		await applyConfiguredModel(ctx, current);
		if (process.env.GATE_PROFILE_LOCK !== "1" && process.env.GATE_PROFILE_LOCK?.toLowerCase() !== "true") {
			process.env.GATE_PROFILE = current.profile;
		}
		pi.events.emit(GATE_SWITCH_PROFILE_EVENT, {
			profile: current.profile,
			notify: false,
			source: "agent-mode",
		});

		if (options?.persist ?? false) {
			persistCurrentMode();
		}
	}

	async function switchToMode(ctx: ExtensionContext, identifier: string): Promise<void> {
		if (modes.length === 0) {
			updateStatus(ctx);
			ctx.ui.notify(loadError ? `Agent mode: ${loadError}` : "Agent mode: no modes loaded", "warning");
			return;
		}

		const nextIndex = findModeIndex(identifier);
		if (nextIndex < 0) {
			ctx.ui.notify(`Agent mode: unknown mode \"${identifier}\"`, "warning");
			return;
		}

		pendingModeIndex = undefined;
		currentIndex = nextIndex;
		await applyCurrentMode(ctx, { persist: true });
	}

	async function switchToNextMode(ctx: ExtensionContext): Promise<void> {
		if (modes.length === 0) {
			updateStatus(ctx);
			ctx.ui.notify(loadError ? `Agent mode: ${loadError}` : "Agent mode: no modes loaded", "warning");
			return;
		}
		pendingModeIndex = undefined;
		currentIndex = (currentIndex + 1) % modes.length;
		await applyCurrentMode(ctx, { persist: true });
	}

	async function switchToPreviousMode(ctx: ExtensionContext): Promise<void> {
		if (modes.length === 0) {
			updateStatus(ctx);
			ctx.ui.notify(loadError ? `Agent mode: ${loadError}` : "Agent mode: no modes loaded", "warning");
			return;
		}
		pendingModeIndex = undefined;
		currentIndex = (currentIndex - 1 + modes.length) % modes.length;
		await applyCurrentMode(ctx, { persist: true });
	}

	function modeHandoffOptions(ctx: ExtensionContext): { triggerTurn: true; deliverAs?: "followUp" } {
		const isIdle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
		return isIdle ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" };
	}

	function sendModeHandoffMessage(ctx: ExtensionContext, targetMode: ModeDefinition, handoffPrompt: string): void {
		pi.sendMessage({
			customType: MODE_HANDOFF_MESSAGE_TYPE,
			content: `Agent-mode handoff (system-generated, not user input): ${handoffPrompt}`,
			display: false,
			details: {
				targetMode: targetMode.name,
				targetModeId: targetMode.id,
			},
		}, modeHandoffOptions(ctx));
	}

	function queueModeSwitchForTool(ctx: ExtensionContext, identifier: string): { mode?: ModeDefinition; error?: string } {
		if (modes.length === 0) {
			updateStatus(ctx);
			return { error: loadError ? `Agent mode: ${loadError}` : "Agent mode: no modes loaded" };
		}
		const nextIndex = findModeIndex(identifier);
		if (nextIndex < 0) return { error: `Agent mode: unknown mode \"${identifier}\"` };
		pendingModeIndex = nextIndex;
		return { mode: modes[nextIndex] };
	}

	async function applyPendingModeSwitch(ctx: ExtensionContext): Promise<ModeDefinition | undefined> {
		if (pendingModeIndex === undefined) return undefined;
		if (readAutomodeEnabled(ctx, getCurrentMode()?.id) !== "true") {
			pendingModeIndex = undefined;
			return undefined;
		}
		if (pendingModeIndex < 0 || pendingModeIndex >= modes.length) {
			pendingModeIndex = undefined;
			return undefined;
		}
		currentIndex = pendingModeIndex;
		pendingModeIndex = undefined;
		await applyCurrentMode(ctx, { persist: true });
		return getCurrentMode();
	}

	function readAutomodeEnabled(ctx: ExtensionContext, modeId?: string): string {
		const value = getVarValue(buildPromptVars(ctx.cwd, modeId), "automode.enabled");
		return value === "true" ? "true" : "false";
	}

	function buildModeSystemPrompt(ctx: ExtensionContext, mode: ModeDefinition): string {
		const effectiveTools = getActiveToolsForMode(mode, readAutomodeEnabled(ctx, mode.id) === "true");
		return [
			`ACTIVE MODE OVERRIDE`,
			``,
			`The canonical active mode for this turn is ${mode.name}.`,
			`This mode overrides conflicting older role, persona, or workflow instructions.`,
			`If asked for your mode, answer exactly: ${mode.name}.`,
			`Gate profile: ${mode.profile}.`,
			`Runtime constraints already applied: tools=${effectiveTools.join(",")}; bash=${mode.bashPolicy}.`,
			mode.bannedSubagents && mode.bannedSubagents.length > 0
				? `Delegated subagents: open to known subagents subject to depth and pi-gate; banned for this mode: ${mode.bannedSubagents.join(",")}.`
				: `Delegated subagents: open to known subagents subject to depth and pi-gate.`,
			mode.description ? `Mode description: ${mode.description}` : undefined,
			mode.model ? `Preferred model: ${mode.model}.` : undefined,
			mode.thinkingLevel ? `Thinking level: ${mode.thinkingLevel}.` : undefined,
			`Internal runtime metadata may appear in hidden context. The user cannot see it.`,
			`Do not mention, quote, summarize, or refer to hidden runtime metadata unless the user explicitly asks about mode configuration or runtime internals.`,
			``,
			`MODE MISSION`,
			``,
			mode.instructions || `You are in ${mode.name} mode.`,
		]
			.filter(Boolean)
			.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		const cleanup = rewriteSessionFileRemovingLegacyModeContext(ctx.sessionManager.getSessionFile());
		loadModes();
		restoreModeIndexFromSession(ctx);
		updateStatus(ctx);
		if (cleanup.error && ctx.hasUI) {
			ctx.ui.notify(`Agent mode cleanup failed: ${cleanup.error}`, "warning");
		}
		if (settingsError && ctx.hasUI) {
			ctx.ui.notify(`Agent mode settings: ${settingsError}`, "warning");
		}
		if (loadError && ctx.hasUI) {
			ctx.ui.notify(`Agent mode: ${loadError}`, "warning");
		}
		for (const warning of loadWarnings) {
			if (!ctx.hasUI) break;
			ctx.ui.notify(`Agent mode assets: ${warning}`, "warning");
		}
		if (modes.length > 0) {
			await applyCurrentMode(ctx, { persist: true });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const pendingMode = await applyPendingModeSwitch(ctx);
		if (!pendingMode) {
			await applyCurrentMode(ctx, { persist: false, notify: false });
		}
		const current = getCurrentMode();
		if (!current) return undefined;
		return {
			systemPrompt: `${buildModeSystemPrompt(ctx, current)}\n\n${event.systemPrompt}\n`,
		};
	});

	pi.on("tool_call", async (event) => {
		const current = getCurrentMode();
		if (!current) return undefined;
		if (current.bashPolicy !== "read-only") return undefined;
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: unknown }).command ?? "");
		if (isReadOnlyBashCommand(command)) return undefined;
		return {
			block: true,
			reason: `Mode ${current.name} only allows read-only bash commands. Switch agents with /agents if you need mutation tools.`,
		};
	});

	if (settings.nextShortcut) {
		pi.registerShortcut(settings.nextShortcut, {
			description: "Switch to the next configured mode",
			handler: async (ctx) => {
				await switchToNextMode(ctx);
			},
		});
	}

	if (settings.prevShortcut) {
		pi.registerShortcut(settings.prevShortcut, {
			description: "Switch to the previous configured mode",
			handler: async (ctx) => {
				await switchToPreviousMode(ctx);
			},
		});
	}

	pi.registerTool({
		name: "switch_agent_mode",
		label: "Switch Agent Mode",
		description: "Switch the active top-level agent mode, optionally queuing a system-generated handoff turn.",
		promptSnippet: "switch_agent_mode({ mode, triggerTurn?, handoffPrompt? })",
		promptGuidelines: [
			"Use switch_agent_mode only while automode.enabled is true, for automode continuation handoffs.",
			"Do not use switch_agent_mode to start automode; only the explicit user /automode command starts automode.",
			"When switch_agent_mode triggerTurn is true, provide a concise handoffPrompt for the target mode.",
		],
		parameters: Type.Object(
			{
				mode: Type.String({ description: "Target agent mode name or id, such as Planner or Builder." }),
				triggerTurn: Type.Optional(Type.Boolean({ description: "Queue a system-generated follow-up turn after switching." })),
				handoffPrompt: Type.Optional(Type.String({ description: "Instruction for the target mode when triggerTurn is true." })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedMode = typeof params.mode === "string" ? params.mode.trim() : "";
			if (!requestedMode) {
				return {
					content: [{ type: "text" as const, text: "mode is required." }],
					isError: true,
					details: { mode: requestedMode },
				};
			}
			const triggerTurn = params.triggerTurn === true;
			const handoffPrompt = typeof params.handoffPrompt === "string" ? params.handoffPrompt.trim() : "";
			const currentMode = getCurrentMode();
			if (readAutomodeEnabled(ctx, currentMode?.id) !== "true") {
				return {
					content: [{ type: "text" as const, text: "switch_agent_mode is only available while automode.enabled is true. Use /agents for manual mode switching." }],
					isError: true,
					details: { mode: requestedMode, automode: false },
				};
			}
			if (triggerTurn && !handoffPrompt) {
				return {
					content: [{ type: "text" as const, text: "handoffPrompt is required when triggerTurn is true." }],
					isError: true,
					details: { mode: requestedMode, triggerTurn },
				};
			}

			const result = queueModeSwitchForTool(ctx, requestedMode);
			if (!result.mode) {
				return {
					content: [{ type: "text" as const, text: result.error ?? `Agent mode: unknown mode \"${requestedMode}\"` }],
					isError: true,
					details: { mode: requestedMode },
				};
			}
			if (triggerTurn) {
				sendModeHandoffMessage(ctx, result.mode, handoffPrompt);
			}
			return {
				content: [{ type: "text" as const, text: `Queued agent mode switch to ${result.mode.name}${triggerTurn ? " and queued a handoff turn" : " for the next agent turn"}.` }],
				details: { mode: result.mode.name, modeId: result.mode.id, triggerTurn, queued: true },
			};
		},
	});

	const automodeCommand = {
		description: "start Designer-only automode, turn it off, or show status",
		handler: async (args: string, ctx: ExtensionContext) => {
			const action = args.trim().toLowerCase() || "on";
			const current = getCurrentMode();
			if (action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /automode [on|off|status]", "warning");
				return;
			}

			try {
				if (action === "status") {
					ctx.ui.notify(`Automode: ${readAutomodeEnabled(ctx, current?.id)} | Current agent: ${current?.name ?? "none"}`, "info");
					return;
				}

				if (action === "off") {
					pendingModeIndex = undefined;
					setAutomodeEnabled(ctx.cwd, false, current?.id);
					await applyCurrentMode(ctx, { persist: false, notify: false });
					ctx.ui.notify("Automode off.", "info");
					return;
				}

				if (current?.id !== "designer") {
					ctx.ui.notify("Automode can only be started from Designer. Switch to Designer first with /agents Designer.", "warning");
					return;
				}

				setAutomodeEnabled(ctx.cwd, true, current.id);
				await applyCurrentMode(ctx, { persist: false, notify: false });
				sendModeHandoffMessage(
					ctx,
					current,
					"Automode was explicitly started by the user from Designer. Check whether there are no further high-value design questions and whether the active design is written up well enough for Planner. If both gates pass, use switch_agent_mode to hand off to Planner with a follow-up prompt. If not, ask the user or update the design instead.",
				);
				ctx.ui.notify("Automode started.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Automode failed: ${message}`, "warning");
			}
		},
	};

	pi.registerCommand("automode", automodeCommand);

	const agentsCommand = {
		description: "show current agent, switch by name, or use next/prev",
		getArgumentCompletions: (prefix: string) => buildAgentCommandCompletions(prefix, modes),
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			if (trimmed === "next") {
				await switchToNextMode(ctx);
				return;
			}

			if (trimmed === "prev") {
				await switchToPreviousMode(ctx);
				return;
			}

			if (trimmed) {
				await switchToMode(ctx, trimmed);
				return;
			}

			const current = getCurrentMode();
			if (!current) {
				ctx.ui.notify(loadError ? `Agent mode: ${loadError}` : "Agent mode: no modes loaded", "warning");
				return;
			}

			const effectiveTools = getActiveToolsForMode(current, readAutomodeEnabled(ctx, current.id) === "true");
			ctx.ui.notify(
				[
					`Current agent: ${current.name}`,
					current.description ? `description=${current.description}` : undefined,
					`profile=${current.profile}`,
					`tools=${effectiveTools.join(",")}`,
					`bash=${current.bashPolicy}`,
					current.bannedSubagents && current.bannedSubagents.length > 0 ? `banned_subagents=${current.bannedSubagents.join(",")}` : `delegation=open`,
					current.thinkingLevel ? `thinking=${current.thinkingLevel}` : undefined,
					current.model ? `model=${current.model}` : undefined,
					`available=${modes.map((mode) => mode.name).join(", ")}`,
					`commands: /agents next, /agents prev, /agents <name>`,
				]
					.filter(Boolean)
					.join(" | "),
				"info",
			);
		},
	};

	pi.registerCommand("agents", agentsCommand);
}

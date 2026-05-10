/**
 * Child `pi` CLI argv + env builder and spawn command resolver.
 *
 * Split of responsibilities:
 *   - resolvePiSpawnCommand(): resolves the binary to invoke (handles Windows
 *     script dispatch when argv[1] points to a bundled pi script).
 *   - buildChildPiArgs(): builds the `pi --mode json -p ...` argv for a child
 *     execution request, including session, model, tools, skills, extensions,
 *     and (optionally) a system-prompt tmpfile.
 *   - buildChildEnv(): merges gate-profile, depth, and identity env vars for
 *     the child process. Callers spread the result into spawn options.env.
 *
 * Adapted from pi-subagents/pi-spawn.ts and pi-subagents/pi-args.ts. Simplified:
 * no worktree hook, explicit skills parameter (no auto-discovery), no MCP
 * direct-tool env override beyond pass-through.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { buildChildDepthEnv, type ChildDepthEnvInput } from "./depth.ts";

const require = createRequire(import.meta.url);

// ============================================================================
// Binary resolution
// ============================================================================

export interface PiSpawnCommand {
	command: string;
	args: string[];
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	piPackageRoot?: string;
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = path.dirname(fs.realpathSync(entry));
		while (dir !== path.dirname(dir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: string };
				if (pkg.name === "@mariozechner/pi-coding-agent" || pkg.name === "@earendil-works/pi-coding-agent") return dir;
			} catch {
				// Walk up; missing/unreadable package.json is expected.
			}
			dir = path.dirname(dir);
		}
	} catch {
		// fs.realpathSync can fail on packaged or virtualized entry paths.
	}
	return undefined;
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			return argvPath;
		}
	}

	try {
		const resolvePackageJson = deps.resolvePackageJson ?? (() => {
			const root = deps.piPackageRoot ?? resolvePiPackageRoot();
			if (root) return path.join(root, "package.json");
			try {
				return require.resolve("@mariozechner/pi-coding-agent/package.json");
			} catch {
				return require.resolve("@earendil-works/pi-coding-agent/package.json");
			}
		});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string"
			? binField
			: binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) return undefined;
		const candidate = normalizePath(path.resolve(path.dirname(packageJsonPath), binPath));
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function resolvePiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
	const piCliPath = resolveWindowsPiCliScript(deps);
	if (piCliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [piCliPath, ...args],
		};
	}
	return { command: "pi", args };
}

// ============================================================================
// Child argv
// ============================================================================

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_INLINE_LIMIT_BYTES = 8000;

export interface BuildChildPiArgsInput {
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	/**
	 * Tool names and/or extension paths. Paths are routed to --extension, names
	 * to --tools.
	 */
	tools?: string[];
	/**
	 * Extension paths. When provided (even empty), the runner passes
	 * --no-extensions and only those listed. When undefined, pi's default
	 * extension discovery applies.
	 */
	extensions?: string[];
	/** When true, pass --no-skills to suppress skill discovery. */
	disableSkills?: boolean;
	/** Inline system prompt text; written to a tmp file and passed via --append-system-prompt. */
	systemPrompt?: string;
	promptFileStem?: string;
}

export interface BuildChildPiArgsResult {
	/** argv after the binary (e.g. ["--mode", "json", "-p", ...]). */
	args: string[];
	/** Transient directory for task/prompt files; caller owns cleanup. */
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

export function buildChildPiArgs(input: BuildChildPiArgsInput): BuildChildPiArgsResult {
	const args: string[] = ["--mode", "json", "-p"];

	if (input.sessionFile) {
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	const toolExtensionPaths: string[] = [];
	if (input.tools !== undefined) {
		const toolNames: string[] = [];
		for (const tool of input.tools) {
			// Only treat as extension path if it's an unambiguous filesystem path.
			// This avoids silently promoting tool names like "build.ts" or "deploy/dev"
			// (accidental name collisions with `.ts`/`.js` suffixes or `/` in names).
			const looksLikePath = tool.startsWith("/") || tool.startsWith("~") ||
				(tool.startsWith(".") && (tool.endsWith(".ts") || tool.endsWith(".js")));
			if (looksLikePath) {
				toolExtensionPaths.push(tool);
			} else {
				toolNames.push(tool);
			}
		}
		if (toolNames.length > 0) {
			args.push("--tools", toolNames.join(","));
		} else if (toolExtensionPaths.length === 0) {
			args.push("--no-tools");
		}
	}

	const allExtensionPaths = [...new Set([
		...(input.extensions ?? []),
		...toolExtensionPaths,
	])];

	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of allExtensionPaths) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of allExtensionPaths) {
			args.push("--extension", extPath);
		}
	}

	if (input.disableSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-mode-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}

	if (Buffer.byteLength(input.task, "utf-8") > TASK_INLINE_LIMIT_BYTES) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-mode-"));
		}
		const taskPath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskPath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	return { args, tempDir };
}

export function cleanupChildTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}

// ============================================================================
// Child env
// ============================================================================

export interface BuildChildEnvInput extends ChildDepthEnvInput {
	agent: string;
	/** Additional env to layer on top (request-specific). */
	extra?: Record<string, string | undefined>;
}

/**
 * Build the child env contract required by pi-gate and the depth guard.
 *
 *   GATE_PROFILE          — agent type (pi-gate selects the matching profile)
 *   GATE_PROFILE_LOCK=1   — prevents the child from switching its own profile
 *   PI_SUBAGENT_DEPTH     — depth ceiling enforcement
 *   PI_SUBAGENT_MAX_DEPTH
 *   PI_SUBAGENT_TOP_RUN_ID
 *   PI_SUBAGENT_PARENT_CHILD_ID
 *
 * MCP_DIRECT_TOOLS is passed through unchanged if the caller supplies it.
 */
export function buildChildEnv(input: BuildChildEnvInput): Record<string, string> {
	const merged: Record<string, string> = {
		GATE_PROFILE: input.agent,
		GATE_PROFILE_LOCK: "1",
		...buildChildDepthEnv(input),
	};
	if (input.extra) {
		for (const [k, v] of Object.entries(input.extra)) {
			if (v !== undefined) merged[k] = v;
		}
	}
	return merged;
}

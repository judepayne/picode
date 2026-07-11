import fs from "node:fs";
import path from "node:path";
import { shellHasSubstitution, tokenizeShellCommand } from "../shared/shell-analysis.ts";
import { isWithinRoot } from "./matching.ts";

export type RuntimeFamily = "python" | "node" | "javascript-typescript" | "shell";
export type RuntimeSyntaxKind = "script" | "module" | "inline" | "stdin" | "heredoc" | "runner";

export interface RuntimeTrustCandidate {
	family: RuntimeFamily;
	displayName: string;
	launcher: string;
	syntax: RuntimeSyntaxKind;
	explicitScriptPath?: string;
	runtimeOwnedComplexity: boolean;
	/** Launcher-only command used for policy analysis when an opaque heredoc body is present. */
	policyCommand?: string;
}

const displays: Record<RuntimeFamily, string> = {
	python: "Python",
	node: "Node.js",
	"javascript-typescript": "JavaScript/TypeScript",
	shell: "Shell",
};
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);
const js = new Set(["bun", "deno", "tsx", "tsx-esm", "ts-node", "ts-node-esm"]);
const forbiddenEnv = new Set([
	"PATH", "PATHEXT", "CDPATH", "ENV", "BASH_ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "IFS", "FPATH",
	"NODE_OPTIONS", "NODE_PATH", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP",
	"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
]);
const forbiddenEnvPrefixes = ["LD_", "DYLD_", "NODE_", "PYTHON", "BASH_", "ZSH_", "FISH_"];

function isForbiddenEnvName(value: string): boolean {
	const upper = value.toUpperCase();
	return forbiddenEnv.has(upper) || forbiddenEnvPrefixes.some((prefix) => upper.startsWith(prefix));
}
const controls = new Set([";", "&&", "||", "|", "|&", "&", "<", ">", ">>", "<<", "<<-"]);

function familyFor(name: string): RuntimeFamily | undefined {
	if (name === "python" || name === "python3" || /^python3\.\d+$/.test(name) || name === "py") return "python";
	if (name === "node" || name === "nodejs") return "node";
	if (js.has(name)) return "javascript-typescript";
	if (shells.has(name)) return "shell";
}

function unwrapEnv(tokens: string[]): string[] | undefined {
	if (tokens[0] !== "env") return tokens;
	let i = 1;
	for (; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") { i++; break; }
		if (token.startsWith("-")) return undefined;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
		if (!match) break;
		if (isForbiddenEnvName(match[1]!)) return undefined;
	}
	return tokens.slice(i);
}

function looksLikeScriptPath(value: string, cwd: string): boolean {
	return value.startsWith(".")
		|| value.startsWith("/")
		|| value.startsWith("~")
		|| value.includes("\\")
		|| /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|fish|ps1)$/i.test(value)
		|| fs.existsSync(path.resolve(cwd, value));
}

function containedScript(value: string, cwd: string, projectRoot: string): string | undefined {
	try {
		const root = fs.realpathSync(projectRoot);
		const script = fs.realpathSync(path.resolve(cwd, value));
		return isWithinRoot(root, script) ? script : undefined;
	} catch { return undefined; }
}

function validateVisiblePathArgs(values: string[], cwd: string, projectRoot: string): { valid: boolean; first?: string } {
	let first: string | undefined;
	for (const rawValue of values) {
		const value = rawValue.includes("=") ? rawValue.slice(rawValue.indexOf("=") + 1) : rawValue;
		if (!looksLikeScriptPath(value, cwd)) continue;
		const resolved = containedScript(value, cwd, projectRoot);
		if (!resolved) return { valid: false };
		first ??= resolved;
	}
	return { valid: true, ...(first ? { first } : {}) };
}

function removeValidatedLoaderOptions(args: string[], flags: string[], cwd: string, projectRoot: string): string[] | undefined {
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const flag = flags.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
		if (!flag) {
			remaining.push(arg);
			continue;
		}
		const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
		if (!value) return undefined;
		if (looksLikeScriptPath(value, cwd) && !containedScript(value, cwd, projectRoot)) return undefined;
	}
	return remaining;
}

function parseShellInvocation(launcher: string, args: string[]): { syntax: RuntimeSyntaxKind; script?: string } | undefined {
	if (launcher === "fish") {
		const safeFlags = new Set(["-n", "--no-execute", "-N", "--no-config"]);
		for (let index = 0; index < args.length; index++) {
			const value = args[index]!;
			if (value === "-c" || value === "--command") return args[index + 1] ? { syntax: "inline" } : undefined;
			if (value === "-C" || value === "--init-command" || value.startsWith("--init-command=")) return undefined;
			if (value === "--") return args[index + 1] ? { syntax: "script", script: args[index + 1] } : { syntax: "stdin" };
			if (safeFlags.has(value)) continue;
			if (value.startsWith("-")) return undefined;
			return { syntax: "script", script: value };
		}
		return { syntax: "stdin" };
	}
	if (launcher === "pwsh" || launcher === "powershell") {
		const safeFlags = new Set(["-nologo", "-noexit", "-noprofile", "-noninteractive", "-noprofileloadtime"]);
		for (let index = 0; index < args.length; index++) {
			const value = args[index]!;
			const lower = value.toLowerCase();
			if (["-c", "-command", "-commandwithargs", "-encodedcommand"].includes(lower)) return args[index + 1] ? { syntax: "inline" } : undefined;
			if (lower === "-file") return args[index + 1] ? { syntax: "script", script: args[index + 1] } : undefined;
			if (lower === "-executionpolicy") { if (!args[++index]) return undefined; continue; }
			if (safeFlags.has(lower)) continue;
			if (value.startsWith("-")) return undefined;
			return { syntax: "script", script: value };
		}
		return { syntax: "stdin" };
	}
	const safeFlags = new Set(["--noprofile", "--norc", "--posix", "--restricted"]);
	for (let index = 0; index < args.length; index++) {
		const value = args[index]!;
		if (value === "-c" || value === "--command") return args[index + 1] ? { syntax: "inline" } : undefined;
		if (value === "-s" || value === "--stdin") continue;
		if (value === "--") return args[index + 1] ? { syntax: "script", script: args[index + 1] } : { syntax: "stdin" };
		if (safeFlags.has(value) || /^-[euxvfn]+$/.test(value)) continue;
		if (value.startsWith("-")) return undefined;
		return { syntax: "script", script: value };
	}
	return { syntax: "stdin" };
}

function candidate(family: RuntimeFamily, launcher: string, syntax: RuntimeSyntaxKind, runtimeOwnedComplexity = false, explicitScriptPath?: string, policyCommand?: string): RuntimeTrustCandidate {
	return {
		family,
		displayName: displays[family],
		launcher,
		syntax,
		...(explicitScriptPath ? { explicitScriptPath } : {}),
		runtimeOwnedComplexity,
		...(policyCommand ? { policyCommand } : {}),
	};
}

function strictHeredoc(command: string, cwd: string, projectRoot: string): RuntimeTrustCandidate | undefined {
	const lines = command.replace(/\r\n/g, "\n").split("\n");
	if (lines.length < 3) return undefined;
	const match = /^(.*?)\s+(<<-?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3\s*$/.exec(lines[0]!);
	if (!match) return undefined;
	if (!match[3]) return undefined; // Unquoted heredocs perform shell expansion before the runtime starts.
	const delimiter = match[4]!;
	const terminal = match[2] === "<<-" ? lines.at(-1)?.replace(/^\t+/, "") : lines.at(-1);
	if (terminal !== delimiter || lines.slice(1, -1).some((line) => line === delimiter)) return undefined;
	const head = classifyRuntimeCommand(match[1]!, cwd, projectRoot);
	if (!head || head.syntax !== "stdin") return undefined;
	return candidate(head.family, head.launcher, "heredoc", true, undefined, match[1]!.trim());
}

/** Classify one standalone runtime command. Explicit files are checked at classification time. */
export function classifyRuntimeCommand(command: string, cwd: string, projectRoot = cwd): RuntimeTrustCandidate | undefined {
	if (command.includes("\n")) return strictHeredoc(command, cwd, projectRoot);
	if (shellHasSubstitution(command)) return undefined;
	let tokens = tokenizeShellCommand(command);
	if (!tokens || tokens.some((token) => controls.has(token))) return undefined;
	tokens = unwrapEnv(tokens);
	if (!tokens?.length) return undefined;
	const launcher = tokens[0]!;
	if (launcher.includes("/") || launcher.includes("\\")) return undefined;
	const family = familyFor(launcher);
	if (!family) return undefined;
	let args = tokens.slice(1);
	if (launcher === "py") {
		if (args[0]?.startsWith("-") && !/^-[23](?:\.\d+)?$/.test(args[0])) return undefined;
		if (/^-[23](?:\.\d+)?$/.test(args[0] ?? "")) args = args.slice(1);
	}
	let syntax: RuntimeSyntaxKind = "stdin";
	let script: string | undefined;
	if (family === "python") {
		const valueFlags = new Set(["-W", "-X", "--check-hash-based-pycs"]);
		for (let i = 0; i < args.length; i++) {
			const a = args[i]!;
			if (a === "-c") { if (!args[i + 1]) return undefined; syntax = "inline"; break; }
			if (a === "-m") {
				if (!args[i + 1]) return undefined;
				const visiblePaths = validateVisiblePathArgs(args.slice(i + 2), cwd, projectRoot);
				if (!visiblePaths.valid) return undefined;
				if (visiblePaths.first) script = visiblePaths.first;
				syntax = "module";
				break;
			}
			if (a === "-") { syntax = "stdin"; break; }
			if (valueFlags.has(a)) { if (!args[++i]) return undefined; continue; }
			if (a.startsWith("-")) continue;
			script = a; syntax = "script"; break;
		}
	} else if (family === "node") {
		for (let i = 0; i < args.length; i++) {
			const a = args[i]!;
			if (["-e", "--eval", "-p", "--print"].includes(a)) { if (!args[i + 1]) return undefined; syntax = "inline"; break; }
			if (a === "--test" || a.startsWith("--test=")) {
				syntax = "runner";
				const runnerArgs = a.includes("=") ? [a.slice(a.indexOf("=") + 1), ...args.slice(i + 1)] : args.slice(i + 1);
				const visiblePaths = validateVisiblePathArgs(runnerArgs, cwd, projectRoot);
				if (!visiblePaths.valid) return undefined;
				if (visiblePaths.first) script = visiblePaths.first;
				break;
			}
			if (a === "-") break;
			const loaderFlag = ["--require", "--loader", "--experimental-loader", "--import", "-r"]
				.find((flag) => a === flag || a.startsWith(`${flag}=`));
			if (loaderFlag) {
				const loader = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
				if (!loader) return undefined;
				if (looksLikeScriptPath(loader, cwd)) {
					const resolved = containedScript(loader, cwd, projectRoot);
					if (!resolved) return undefined;
					script ??= resolved;
				}
				continue;
			}
			if (a.startsWith("-")) continue;
			script = a; syntax = "script"; break;
		}
	} else if (family === "shell") {
		const shellInvocation = parseShellInvocation(launcher, args);
		if (!shellInvocation) return undefined;
		syntax = shellInvocation.syntax;
		script = shellInvocation.script;
	} else {
		const loaderFlags = launcher === "bun"
			? ["--preload", "--require", "-r"]
			: launcher === "deno"
				? ["--import-map", "--config"]
				: ["--require", "--loader", "--import", "-r"];
		const remainingArgs = removeValidatedLoaderOptions(args, loaderFlags, cwd, projectRoot);
		if (!remainingArgs) return undefined;
		args = remainingArgs;
		if (launcher === "deno") {
			const sub = args.shift();
			if (["eval"].includes(sub ?? "")) syntax = "inline";
			else if (["test", "task"].includes(sub ?? "")) {
				const visiblePaths = validateVisiblePathArgs(args, cwd, projectRoot);
				if (!visiblePaths.valid) return undefined;
				if (visiblePaths.first) script = visiblePaths.first;
				syntax = "runner";
			}
			else if (sub === "run") { const first = args.find((a) => !a.startsWith("-")); if (!first) return undefined; script = first; syntax = "script"; }
			else return undefined;
		} else if (launcher === "bun" && ["install", "add", "remove", "publish", "x", "create"].includes(args[0] ?? "")) return undefined;
		else if (args[0] === "run" || args[0] === "test") {
			const visiblePaths = validateVisiblePathArgs(args.slice(1), cwd, projectRoot);
			if (!visiblePaths.valid) return undefined;
			if (visiblePaths.first) script = visiblePaths.first;
			syntax = "runner";
		}
		else if (["-e", "--eval"].includes(args[0] ?? "")) { if (!args[1]) return undefined; syntax = "inline"; }
		else { const first = args.find((a) => !a.startsWith("-")); if (first) { script = first; syntax = "script"; } }
	}
	if (script) {
		const resolved = containedScript(script, cwd, projectRoot);
		if (!resolved) return undefined;
		return candidate(family, launcher, syntax, false, resolved);
	}
	return candidate(family, launcher, syntax, syntax === "inline" || syntax === "stdin");
}

export const classifyRuntimeTrust = classifyRuntimeCommand;
export function buildRuntimeFamilyApprovalKey(family: RuntimeFamily, projectRoot: string): string {
	return `runtime-family:${family}:project:${fs.realpathSync(projectRoot)}`;
}
export const buildRuntimeTrustApprovalKey = buildRuntimeFamilyApprovalKey;
export function extractRuntimeTrustFamilyNames(keys: Iterable<string>): string[] {
	const names = new Set<string>();
	for (const key of keys) {
		const match = /(?:^|:)runtime-family:(python|node|javascript-typescript|shell):project:/.exec(key);
		if (match) names.add(displays[match[1] as RuntimeFamily]);
	}
	return [...names].sort();
}
export function runtimeCandidateOwnsComplexity(candidate: RuntimeTrustCandidate): boolean {
	return candidate.runtimeOwnedComplexity && ["inline", "stdin", "heredoc"].includes(candidate.syntax);
}

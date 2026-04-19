/**
 * Temp-directory path resolution for subagent-mode.
 *
 * IMPORTANT: the path basenames (`pi-subagents-<scope>`, `async-subagent-runs`,
 * `async-subagent-results`, `chain-runs`, `artifacts`) are load-bearing for
 * `pi-gate/policy.json` which hardcodes globs matching this exact structure.
 * Any rename here requires a coordinated update to that policy file.
 *
 * Ported from agent/extensions/pi-subagents/types.ts:314-395 to avoid an
 * extension-to-extension import dependency during the side-by-side dev phase.
 */

import * as os from "node:os";
import * as path from "node:path";

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export interface ResolveTempScopeOptions {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}

/**
 * Stable per-user scope id so concurrent `pi` processes on a shared machine do
 * not collide in /tmp. Matches the algorithm in pi-subagents so that async
 * state is discoverable across the cutover.
 */
export function resolveTempScopeId(options?: ResolveTempScopeOptions): string {
	const env = options?.env ?? process.env;

	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedirEnv = env.USERPROFILE ?? env.HOME;
	if (homedirEnv) return `home-${sanitizeTempScopeSegment(homedirEnv)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const ASYNC_RUNS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const ASYNC_RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");

export function asyncRunDir(runId: string): string {
	return path.join(ASYNC_RUNS_DIR, runId);
}

export function asyncRunManifestPath(runId: string): string {
	return path.join(asyncRunDir(runId), "run.json");
}

export function asyncRunEventsPath(runId: string): string {
	return path.join(asyncRunDir(runId), "events.jsonl");
}

export function asyncRunResultPath(runId: string): string {
	return path.join(asyncRunDir(runId), "result.json");
}

export function asyncRunResultTempPath(runId: string): string {
	return path.join(asyncRunDir(runId), "result.json.tmp");
}

export function chainRunDir(runId: string): string {
	return path.join(CHAIN_RUNS_DIR, runId);
}

export function asyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

/**
 * subagent-mode extension
 *
 * Thin programmatic runner substrate for delegated subagent execution.
 * Spawns child `pi --mode json -p` processes, normalizes their event streams
 * into a stable contract, persists minimal async state, and reports structured
 * results to the subagent-orchestrator.
 *
 * This extension has no user-facing UX. All product surfaces (status, rendering,
 * handback continuation, slash commands) live in the orchestrator.
 *
 * See PI_SUBAGENTS_REWRITE.md for the authoritative design.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { type ForkableSessionManager } from "./fork-context.ts";
import { createOrchestratorBridge, type OrchestratorBridge } from "./orchestrator-bridge.ts";

interface RuntimeState {
	lastContext: ExtensionContext | undefined;
	bridge: OrchestratorBridge | undefined;
}

export default function registerSubagentModeExtension(pi: ExtensionAPI): void {
	const state: RuntimeState = {
		lastContext: undefined,
		bridge: undefined,
	};

	const getSessionManager = (): ForkableSessionManager | undefined => {
		const ctx = state.lastContext;
		const sessionManager = ctx?.sessionManager as ForkableSessionManager | undefined;
		if (!sessionManager) return undefined;
		// Duck-type check: we only need the three forkable methods.
		if (typeof sessionManager.getSessionFile !== "function") return undefined;
		return sessionManager;
	};

	const getCwd = (): string | undefined => state.lastContext?.cwd;

	state.bridge = createOrchestratorBridge({
		events: pi.events,
		getSessionManager,
		getCwd,
	});

	// Track the most recent extension context so the bridge can reach the
	// session manager for fork-mode children.
	const updateContext = (_event: unknown, ctx: ExtensionContext): void => {
		state.lastContext = ctx;
	};

	pi.on("session_start", updateContext);
	pi.on("tool_result", updateContext);

	pi.on("session_shutdown", () => {
		state.bridge?.dispose();
		state.bridge = undefined;
		state.lastContext = undefined;
	});
}

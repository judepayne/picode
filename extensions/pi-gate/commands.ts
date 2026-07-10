import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadGateAutoConfig } from "./auto-approver/config.ts";
import { GateAutoApproverManager } from "./auto-approver/manager.ts";
import { listConfiguredPiModels, managedLlamaBackendConfig, runGateAutoSetupScript, setGateAutoBackendFromSetup } from "./auto-approver/setup.ts";
import { setGateAutoEnabled } from "../z-prompt-vars/prompt-vars.ts";
import { BASE_PROFILE_NAME, type CompiledPolicy, type EffectiveGatePolicy, type LoadedPolicy } from "./policy-types.ts";
import { resetAutoBlockState, type GateAutoBlockState } from "./semantic/decision-flow.ts";
import { displayStatusPath, formatGateAutoStatusMessage, updateStatus } from "./status-ui.ts";

const GATE_PROFILE_LOCK_ENV = "GATE_PROFILE_LOCK";

export interface GateCommandRuntimeState {
 autoRuntimeEnabled: boolean;
 selectedProfileOverride?: string;
 activeAutoSetup?: ChildProcessWithoutNullStreams;
}

export interface GateCommandOptions {
 extensionDir: string;
 loaded: LoadedPolicy;
 autoManager: GateAutoApproverManager;
 autoBlockState: GateAutoBlockState;
 sessionAllows: Set<string>;
 profileLocked: boolean;
 runtimeState: GateCommandRuntimeState;
 isCurrent(): boolean;
 ready: Promise<unknown>;
 getEffectivePolicy(cwd: string): { compiled?: EffectiveGatePolicy; error?: string };
 switchProfile(ctx: ExtensionContext, profile: string): { ok: true; compiled: CompiledPolicy } | { ok: false; error: string };
}

export function createGateCommandHandler(options: GateCommandOptions) {
 const { extensionDir, loaded, autoManager, autoBlockState, sessionAllows, profileLocked, runtimeState, isCurrent, getEffectivePolicy, switchProfile } = options;
	const commandHandler = async (args: string, ctx: ExtensionContext) => {
		await options.ready;
		if (!isCurrent()) return;
		const trimmed = args.trim();
		const autoArgs = trimmed.split(/\s+/);
		if (autoArgs[0] === "auto") {
			const action = autoArgs[1] ?? "status";
			if (action === "setup") {
				if (runtimeState.activeAutoSetup) {
					ctx.ui.notify("Gate auto setup is already running", "warning");
					return;
				}
				const backendChoice = ctx.hasUI
					? await ctx.ui.select("Choose Gate auto approver backend", ["Local managed llama.cpp", "Pi configured model"])
					: "Local managed llama.cpp";
				if (!isCurrent()) return;
				if (backendChoice === "Pi configured model") {
					const models = listConfiguredPiModels();
					if (models.length === 0) {
						ctx.ui.notify("No models found in ~/.pi/agent/models.json for Gate auto setup", "warning");
						return;
					}
					const choice = await ctx.ui.select("Select Pi model for Gate auto. Full semantic approval context may be sent to this provider.", models.map((model) => model.display));
					if (!isCurrent()) return;
					const selected = models.find((model) => model.display === choice);
					if (!selected) return;
					const confirm = await ctx.ui.select(`Use ${selected.provider}/${selected.model} for Gate auto? Full semantic approval context may be sent to this provider.`, ["Use this model", "Cancel"]);
					if (!isCurrent() || confirm !== "Use this model") return;
					const writeResult = setGateAutoBackendFromSetup(ctx, { type: "pi-model", provider: selected.provider, model: selected.model, thinking: "off", cacheRetention: "short", temperature: 0, maxTokens: 128 });
					ctx.ui.notify(`Gate auto setup complete. backend=pi-model model=${selected.provider}/${selected.model} | config=${writeResult.scope}:${displayStatusPath(ctx.cwd, writeResult.configPath)} | run /gate auto on when ready`, "info");
					return;
				}
				ctx.ui.notify("Gate auto setup started. This may download the default model the first time; leave Pi running until it completes.", "info");
				try {
					const setup = await runGateAutoSetupScript(extensionDir, (child) => {
						runtimeState.activeAutoSetup = child;
					});
					if (!isCurrent()) return;
					const writeResult = setGateAutoBackendFromSetup(ctx, managedLlamaBackendConfig(setup));
					ctx.ui.notify(`Gate auto setup complete. server=${setup.serverPath} | model=${setup.modelPath} | config=${writeResult.scope}:${displayStatusPath(ctx.cwd, writeResult.configPath)} | run /gate auto on when ready`, "info");
				} catch (error) {
					if (!isCurrent()) return;
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Gate auto setup failed: ${message}`, "warning");
				} finally {
					runtimeState.activeAutoSetup = undefined;
				}
				return;
			}
			if (action === "on") {
				setGateAutoEnabled(ctx.cwd, true);
				runtimeState.autoRuntimeEnabled = true;
				resetAutoBlockState(autoBlockState);
				const status = await autoManager.enable(ctx);
				if (!isCurrent()) return;
				const resolved = getEffectivePolicy(ctx.cwd);
				updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
				ctx.ui.notify(
					status.mode === "managed" || status.mode === "external" || status.mode === "inherited" || status.mode === "pi-model"
						? `Gate auto enabled (${status.mode}${status.endpoint ? ` ${status.endpoint}` : status.provider && status.model ? ` ${status.provider}/${status.model}` : ""})`
						: `Gate auto enabled but not ready: ${status.lastError ?? status.mode}`,
					status.mode === "managed" || status.mode === "external" || status.mode === "inherited" || status.mode === "pi-model" ? "info" : "warning",
				);
				return;
			}
			if (action === "off") {
				setGateAutoEnabled(ctx.cwd, false);
				runtimeState.autoRuntimeEnabled = false;
				await autoManager.disable(ctx);
				if (!isCurrent()) return;
				resetAutoBlockState(autoBlockState);
				const resolved = getEffectivePolicy(ctx.cwd);
				updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, false);
				ctx.ui.notify("Gate auto disabled", "info");
				return;
			}
			if (action === "status") {
				if (runtimeState.autoRuntimeEnabled) await autoManager.refresh(ctx);
				else await autoManager.disable(ctx);
				if (!isCurrent()) return;
				const status = autoManager.status(ctx);
				const autoConfig = loadGateAutoConfig(ctx.cwd);
				ctx.ui.notify(
					formatGateAutoStatusMessage(ctx, status, autoConfig.startOnSession, runtimeState.autoRuntimeEnabled && autoManager.isEnabled()),
					status.lastError ? "warning" : "info",
				);
				return;
			}
			ctx.ui.notify("Gate: unknown auto subcommand. Use /gate auto setup, /gate auto on, /gate auto off, or /gate auto status", "warning");
			return;
		}
		if (trimmed === "switch") {
			if (profileLocked) {
				ctx.ui.notify(`Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}`, "warning");
				return;
			}
			if (loaded.error) {
				ctx.ui.notify(loaded.error, "warning");
				return;
			}
			const profileNames = [BASE_PROFILE_NAME, ...Object.keys(loaded.policy?.profiles ?? {}).sort()];
			if (profileNames.length === 0) {
				ctx.ui.notify("Gate: no profiles defined", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Gate: profile switching requires a UI", "warning");
				return;
			}
			const current = getEffectivePolicy(ctx.cwd).compiled?.profileName ?? "error";
			const choice = await ctx.ui.select(`Select gate profile (current: ${current})`, profileNames);
			if (!isCurrent() || !choice) return;
			if (choice === current) {
				// Selecting the current profile clears the override, falling back
				// to GATE_PROFILE env var, policy.activeProfile, or $base. Session
				// approvals are scoped to the effective profile and must not survive
				// a reset to a different fallback profile.
				const previousProfile = current;
				runtimeState.selectedProfileOverride = undefined;
				const fresh = getEffectivePolicy(ctx.cwd);
				if (fresh.compiled?.profileName !== previousProfile) sessionAllows.clear();
				updateStatus(ctx, fresh.compiled?.profileName, sessionAllows, !fresh.compiled, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
				ctx.ui.notify(`Gate profile reset to ${fresh.compiled?.profileName ?? "error"}`, "info");
				return;
			}
			const result = switchProfile(ctx, choice);
			if (!result.ok) {
				ctx.ui.notify(result.error, "warning");
			}
			return;
		}

		const resolved = getEffectivePolicy(ctx.cwd);
		if (trimmed === "clear") {
			sessionAllows.clear();
			updateStatus(ctx, resolved.compiled?.profileName, sessionAllows, !resolved.compiled, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
			ctx.ui.notify("Gate session approvals cleared", "info");
			return;
		}

		if (trimmed !== "" && trimmed !== "status") {
			ctx.ui.notify(
				"Gate: unknown subcommand. Use /gate status, /gate switch, /gate clear, or /gate auto setup|status|on|off",
				"warning",
			);
			return;
		}

		if (runtimeState.autoRuntimeEnabled) await autoManager.refresh(ctx);
		else await autoManager.disable(ctx);
		if (!isCurrent()) return;
		const autoStatus = autoManager.status(ctx);
		const autoConfig = loadGateAutoConfig(ctx.cwd);
		const summary = [
			resolved.compiled ? `Gate profile=${resolved.compiled.profileName}` : "Gate profile=error",
			resolved.compiled && resolved.compiled.lineageNames.length > 1 ? `lineage=${resolved.compiled.lineageNames.join(">")}` : undefined,
			resolved.compiled?.unattended ? "unattended=true" : undefined,
			profileLocked ? `profile locked by=${GATE_PROFILE_LOCK_ENV}` : undefined,
			runtimeState.selectedProfileOverride ? `profile override=${runtimeState.selectedProfileOverride === BASE_PROFILE_NAME ? "base" : runtimeState.selectedProfileOverride}` : undefined,
			`session approvals=${sessionAllows.size}`,
			`auto enabled=${autoStatus.enabled}`,
			`auto runtime=${runtimeState.autoRuntimeEnabled && autoManager.isEnabled()}`,
			`auto startOnSession=${autoConfig.startOnSession}`,
			`auto backend=${autoStatus.mode}`,
			autoStatus.lastError ? `auto lastError=${autoStatus.lastError}` : undefined,
			`policy file=${loaded.policyPath}`,
			`schema file=${loaded.schemaPath}`,
			resolved.error ? `status=${resolved.error}` : undefined,
		]
			.filter(Boolean)
			.join(" | ");
		ctx.ui.notify(summary, resolved.error ? "warning" : "info");
	};

 return commandHandler;
}

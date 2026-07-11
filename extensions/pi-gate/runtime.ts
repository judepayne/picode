import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGateAutoConfig } from "./auto-approver/config.ts";
import { GateAutoApproverManager } from "./auto-approver/manager.ts";
import { loadPolicy } from "./policy-loader.ts";
import { updateStatus } from "./status-ui.ts";
import { createGateCommandHandler } from "./commands.ts";
import { createGateProfileController, type ProfileSwitchRequest } from "./profile-controller.ts";
import { createGateToolHandler } from "./enforcement/tool-handler.ts";
import type { GateAutoBlockState } from "./semantic/decision-flow.ts";

const GATE_PROFILE_LOCK_ENV = "GATE_PROFILE_LOCK";
const GATE_SWITCH_PROFILE_EVENT = "gate:switch-profile";
const POLICY_SCHEMA_FILE = "policy.schema.json";
const REGISTRATION_STATE_KEY = Symbol.for("picode.pi-gate.registration");
interface RegistrationState { token: symbol; dispose: () => Promise<void> | void }
type OwnedEventBus = ExtensionAPI["events"] & Record<symbol, unknown> & { off?: (event: string, handler: (data: unknown) => void) => void };


function isEnvEnabled(value: string | undefined): boolean {
	if (!value) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

export default function piGate(pi: ExtensionAPI) {
	const eventBus = pi.events as OwnedEventBus;
	const previous = eventBus[REGISTRATION_STATE_KEY] as RegistrationState | undefined;
	const previousDisposal = Promise.resolve(previous?.dispose());
	const registrationToken = Symbol("pi-gate-registration");
	let disposed = false;
	const isCurrent = () => !disposed && (eventBus[REGISTRATION_STATE_KEY] as RegistrationState | undefined)?.token === registrationToken;
	let disposeProfileEvent = () => {};
	let disposeRuntime = async (): Promise<void> => {};
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		disposeProfileEvent();
		if ((eventBus[REGISTRATION_STATE_KEY] as RegistrationState | undefined)?.token === registrationToken) delete eventBus[REGISTRATION_STATE_KEY];
		await previousDisposal;
		await disposeRuntime();
	};
	eventBus[REGISTRATION_STATE_KEY] = { token: registrationToken, dispose } satisfies RegistrationState;

	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const policyPath = path.join(extensionDir, "policy.json");
	const schemaPath = path.join(extensionDir, POLICY_SCHEMA_FILE);
	const loaded = loadPolicy(policyPath, schemaPath);
	const autoManager = new GateAutoApproverManager(pi);
	const autoBlockState: GateAutoBlockState = { consecutive: 0, total: 0, paused: false };
	const runtimeState = {
		autoRuntimeEnabled: false,
		selectedProfileOverride: undefined as string | undefined,
		activeAutoSetup: undefined as ChildProcess | undefined,
	};
	const sessionAllows = new Set<string>();
	const profileLocked = isEnvEnabled(process.env[GATE_PROFILE_LOCK_ENV]);
	let policyErrorShown = false;
	let currentCtx: ExtensionContext | undefined;
	const profileController = createGateProfileController({ loaded, runtimeState, sessionAllows, profileLocked, autoManager });
	const { getEffectivePolicy, scopeSessionKey, switchProfile, processProfileSwitchRequest, flushPendingProfileSwitch } = profileController;
	disposeRuntime = async () => {
		if (runtimeState.activeAutoSetup && !runtimeState.activeAutoSetup.killed) {
			try {
				runtimeState.activeAutoSetup.kill("SIGTERM");
			} catch {
				// Best effort cleanup for an in-progress setup helper.
			}
		}
		runtimeState.activeAutoSetup = undefined;
		await autoManager.shutdown();
		currentCtx = undefined;
		profileController.clearPendingProfileSwitch();
	};

	pi.on("session_start", async (_event, ctx) => {
		await previousDisposal;
		if (!isCurrent()) return;
		currentCtx = ctx;
		const autoConfig = loadGateAutoConfig(ctx.cwd);
		runtimeState.autoRuntimeEnabled = autoConfig.enabled && (autoConfig.startOnSession || (autoConfig.processKind === "subagent" && (Boolean(autoConfig.inheritedEndpoint) || autoConfig.backend.type === "pi-model")));
		if (runtimeState.autoRuntimeEnabled) await autoManager.refresh(ctx);
		else await autoManager.disable(ctx);
		if (!isCurrent()) return;
		const result = getEffectivePolicy(ctx.cwd);
		if (result.compiled) updateStatus(ctx, result.compiled.profileName, sessionAllows, false, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
		else updateStatus(ctx, undefined, sessionAllows, true, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
		if (result.error && ctx.hasUI && !policyErrorShown) {
			policyErrorShown = true;
			ctx.ui.notify(result.error, "warning");
		}
		flushPendingProfileSwitch(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isCurrent()) return;
		currentCtx = ctx;
		flushPendingProfileSwitch(ctx);
		const result = getEffectivePolicy(ctx.cwd);
		if (result.compiled) updateStatus(ctx, result.compiled.profileName, sessionAllows, false, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
	});

	pi.on("session_shutdown", async () => {
		if (!isCurrent()) return;
		await dispose();
	});

	const handleProfileSwitchEvent = (data: unknown) => {
		if (!isCurrent() || profileLocked) return;
		const request = data as Partial<ProfileSwitchRequest> | undefined;
		const profile = typeof request?.profile === "string" ? request.profile.trim() : "";
		if (!profile) return;

		const normalizedRequest: ProfileSwitchRequest = {
			profile,
			notify: request?.notify,
			source: typeof request?.source === "string" ? request.source : undefined,
		};

		if (!currentCtx) {
			profileController.queueProfileSwitch(normalizedRequest);
			return;
		}

		const result = processProfileSwitchRequest(currentCtx, normalizedRequest);
		if (result.ok === false) {
			currentCtx.ui.notify(result.error, "warning");
		}
	};

	const registeredProfileEvent = pi.events.on(GATE_SWITCH_PROFILE_EVENT, handleProfileSwitchEvent) as unknown;
	disposeProfileEvent = () => {
		if (typeof registeredProfileEvent === "function") registeredProfileEvent();
		else eventBus.off?.(GATE_SWITCH_PROFILE_EVENT, handleProfileSwitchEvent);
	};

	const commandHandler = createGateCommandHandler({
		extensionDir,
		loaded,
		autoManager,
		autoBlockState,
		sessionAllows,
		profileLocked,
		runtimeState,
		isCurrent,
		ready: previousDisposal,
		getEffectivePolicy,
		switchProfile,
	});
	pi.registerCommand("gate", {
		description: "status, switch (switch profiles), clear (clear cached approvals), auto setup|on|off|status",
		handler: commandHandler,
	});

	pi.on("tool_call", createGateToolHandler({
		extensionDir,
		sessionAllows,
		profileLocked,
		autoManager,
		autoBlockState,
		isCurrent,
		ready: previousDisposal,
		autoRuntimeEnabled: () => runtimeState.autoRuntimeEnabled,
		getEffectivePolicy,
		scopeSessionKey,
	}));
}

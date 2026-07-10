import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GateAutoApproverManager } from "./auto-approver/manager.ts";
import type { GateCommandRuntimeState } from "./commands.ts";
import { compilePolicy } from "./policy-compiler.ts";
import { normalizeProfileName } from "./policy-loader.ts";
import { BASE_PROFILE_NAME, type CompiledPolicy, type EffectiveGatePolicy, type LoadedPolicy } from "./policy-types.ts";
import { updateStatus } from "./status-ui.ts";

const GATE_PROFILE_ENV = "GATE_PROFILE";
const GATE_PROFILE_LOCK_ENV = "GATE_PROFILE_LOCK";
const PI_GATE_PROFILE_LINEAGE_ENV = "PI_GATE_PROFILE_LINEAGE";

export interface ProfileSwitchRequest {
	profile: string;
	notify?: boolean;
	source?: string;
}

export interface GateProfileControllerOptions {
	loaded: LoadedPolicy;
	runtimeState: GateCommandRuntimeState;
	sessionAllows: Set<string>;
	profileLocked: boolean;
	autoManager: GateAutoApproverManager;
}

export function createGateProfileController(options: GateProfileControllerOptions) {
	const { loaded, runtimeState, sessionAllows, profileLocked, autoManager } = options;
	let pendingProfileSwitch: ProfileSwitchRequest | undefined;

	function resolveRequestedProfile(): string {
		return normalizeProfileName(runtimeState.selectedProfileOverride)
			?? normalizeProfileName(process.env[GATE_PROFILE_ENV])
			?? normalizeProfileName(loaded.policy?.activeProfile)
			?? BASE_PROFILE_NAME;
	}

	function resolveLineageProfileNames(activeProfile: string): string[] {
		const raw = process.env[PI_GATE_PROFILE_LINEAGE_ENV];
		const names = raw
			? raw.split(",").map(normalizeProfileName).filter((entry): entry is string => Boolean(entry))
			: [];
		if (names.length === 0) names.push(activeProfile);
		if (!names.includes(activeProfile)) names.push(activeProfile);
		return names;
	}

	function getEffectivePolicy(cwd: string): { compiled?: EffectiveGatePolicy; error?: string } {
		if (loaded.error) return { error: loaded.error };
		if (!loaded.policy) return { error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		try {
			const activeProfile = resolveRequestedProfile();
			const lineageNames = resolveLineageProfileNames(activeProfile);
			const lineage = lineageNames.map((profileName) => compilePolicy(loaded.policy!, cwd, profileName));
			const active = lineage.find((policy) => policy.requestedProfileName === activeProfile)
				?? compilePolicy(loaded.policy, cwd, activeProfile);
			return { compiled: { active, lineage, lineageNames, profileName: active.profileName, unattended: active.unattended } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `policy resolution failed! ${message}. Tool calls are blocked until the gate policy is fixed.` };
		}
	}

	function scopeSessionKey(effective: EffectiveGatePolicy, sessionKey: string): string {
		return `profiles:${effective.lineageNames.join(">")}:${sessionKey}`;
	}

	function switchProfile(
		ctx: ExtensionContext,
		profileName: string,
		switchOptions?: { notify?: boolean },
	): { ok: true; compiled: CompiledPolicy } | { ok: false; error: string } {
		if (profileLocked) return { ok: false, error: `Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}` };
		if (loaded.error) return { ok: false, error: loaded.error };
		if (!loaded.policy) return { ok: false, error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		const normalizedProfile = normalizeProfileName(profileName) ?? BASE_PROFILE_NAME;
		if (normalizedProfile !== BASE_PROFILE_NAME && !loaded.policy.profiles?.[normalizedProfile]) {
			return { ok: false, error: `Gate: unknown profile ${profileName}` };
		}
		runtimeState.selectedProfileOverride = normalizedProfile;
		sessionAllows.clear();
		try {
			const compiled = compilePolicy(loaded.policy, ctx.cwd, normalizedProfile);
			updateStatus(ctx, compiled.profileName, sessionAllows, false, profileLocked, runtimeState.autoRuntimeEnabled && autoManager.isEnabled());
			if (switchOptions?.notify ?? true) ctx.ui.notify(`Gate profile switched to ${compiled.profileName}`, "info");
			return { ok: true, compiled };
		} catch (error) {
			runtimeState.selectedProfileOverride = undefined;
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Gate: ${message}` };
		}
	}

	function processProfileSwitchRequest(ctx: ExtensionContext, request: ProfileSwitchRequest): { ok: true; queued: boolean } | { ok: false; error: string } {
		if (profileLocked) return { ok: false, error: `Gate profile is locked by ${GATE_PROFILE_LOCK_ENV}` };
		if (loaded.error) return { ok: false, error: loaded.error };
		if (!loaded.policy) return { ok: false, error: "Gate policy unavailable. Tool calls are blocked until the gate policy is fixed." };
		const normalizedProfile = normalizeProfileName(request.profile) ?? BASE_PROFILE_NAME;
		if (normalizedProfile !== BASE_PROFILE_NAME && !loaded.policy.profiles?.[normalizedProfile]) {
			return { ok: false, error: `Gate: unknown profile ${request.profile}` };
		}
		if (ctx.isIdle()) {
			const result = switchProfile(ctx, normalizedProfile, { notify: request.notify });
			return result.ok ? { ok: true, queued: false } : result;
		}
		pendingProfileSwitch = { ...request, profile: normalizedProfile };
		if (request.notify ?? true) {
			const from = request.source ? ` from ${request.source}` : "";
			ctx.ui.notify(`Gate will switch to ${normalizedProfile === BASE_PROFILE_NAME ? "base" : normalizedProfile}${from} when the current turn finishes`, "info");
		}
		return { ok: true, queued: true };
	}

	function flushPendingProfileSwitch(ctx: ExtensionContext): void {
		if (!pendingProfileSwitch) return;
		const request = pendingProfileSwitch;
		pendingProfileSwitch = undefined;
		const result = switchProfile(ctx, request.profile, { notify: request.notify });
		if (!result.ok) ctx.ui.notify(result.error, "warning");
	}

	return {
		getEffectivePolicy,
		scopeSessionKey,
		switchProfile,
		processProfileSwitchRequest,
		flushPendingProfileSwitch,
		queueProfileSwitch: (request: ProfileSwitchRequest) => { pendingProfileSwitch = request; },
		clearPendingProfileSwitch: () => { pendingProfileSwitch = undefined; },
	};
}

export type GateProfileController = ReturnType<typeof createGateProfileController>;

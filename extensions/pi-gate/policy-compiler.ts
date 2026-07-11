import {
	expandPatternValue,
	isPathSubject,
	normalizeCommand,
	normalizeSlashes,
	wildcardToRegex,
} from "./matching.ts";
import { normalizeProfileName } from "./policy-loader.ts";
import {
	BASE_PROFILE_NAME,
	type CompiledPatternRule,
	type CompiledPolicy,
	type MergedPermissionConfig,
	type PermissionAction,
	type PermissionConfig,
	type RawPolicy,
	type RawProfile,
	type ResolvedProfileOptions,
} from "./policy-types.ts";

const BUILTIN_PERMISSION: PermissionConfig = {
	"*": "allow",
	"external_directory": { "*": "ask" },
	"read": {
		"*": "allow",
		"*.env": "deny",
		"*.env.*": "deny",
		"*.env.example": "allow",
	},
};

function appendPermissionConfig(
	accumulator: { globalActions: PermissionAction[]; subjects: Record<string, Array<{ action: PermissionAction; rawPattern: string }>> },
	config: PermissionConfig | undefined,
): void {
	if (!config) return;
	if (typeof config === "string") {
		accumulator.globalActions.push(config);
		return;
	}

	for (const [subject, rule] of Object.entries(config)) {
		if (subject === "*") {
			if (typeof rule === "string") accumulator.globalActions.push(rule);
			continue;
		}
		const target = accumulator.subjects[subject] ?? (accumulator.subjects[subject] = []);
		if (typeof rule === "string") {
			target.push({ action: rule, rawPattern: "*" });
			continue;
		}
		for (const [pattern, action] of Object.entries(rule)) {
			target.push({ action, rawPattern: pattern });
		}
	}
}

function compilePattern(subject: string, rawPattern: string, cwd: string): CompiledPatternRule {
	let expandedPattern = normalizeSlashes(rawPattern);
	if (subject === "bash") {
		expandedPattern = normalizeCommand(expandedPattern);
	} else if (isPathSubject(subject)) {
		expandedPattern = expandPatternValue(expandedPattern, cwd);
	}
	return {
		action: "allow",
		expandedPattern,
		rawPattern,
		regex: wildcardToRegex(expandedPattern),
	};
}

function getProfileLineage(policy: RawPolicy, requestedProfileName: string): RawProfile[] {
	if (requestedProfileName === BASE_PROFILE_NAME) return [];
	const profiles = policy.profiles ?? {};
	const lineage: RawProfile[] = [];
	const seen = new Set<string>();
	const collect = (profileName: string) => {
		if (seen.has(profileName)) throw new Error(`circular profile inheritance detected at ${JSON.stringify(profileName)}`);
		const profile = profiles[profileName];
		if (!profile) throw new Error(`unknown profile ${JSON.stringify(profileName)}`);
		seen.add(profileName);
		const parent = normalizeProfileName(profile["inherits-from"]) ?? BASE_PROFILE_NAME;
		if (parent !== BASE_PROFILE_NAME) collect(parent);
		lineage.push(profile);
		seen.delete(profileName);
	};
	collect(requestedProfileName);
	return lineage;
}

function getProfileLayers(policy: RawPolicy, requestedProfileName: string): Array<PermissionConfig | undefined> {
	return [BUILTIN_PERMISSION, policy.permission, ...getProfileLineage(policy, requestedProfileName).map((profile) => profile.permission)];
}

function resolveProfileOptions(policy: RawPolicy, requestedProfileName: string): ResolvedProfileOptions {
	let unattended = false;
	for (const profile of getProfileLineage(policy, requestedProfileName)) {
		if (typeof profile.unattended === "boolean") unattended = profile.unattended;
	}
	return { unattended };
}

function mergePermissionLayers(layers: Array<PermissionConfig | undefined>): MergedPermissionConfig {
	const merged: MergedPermissionConfig = {
		globalActions: [],
		subjects: {},
	};
	for (const layer of layers) appendPermissionConfig(merged, layer);
	return merged;
}

export function validateUnattendedProfile(policy: RawPolicy, requestedProfileName: string): string | undefined {
	if (!resolveProfileOptions(policy, requestedProfileName).unattended) return undefined;
	const merged = mergePermissionLayers(getProfileLayers(policy, requestedProfileName));
	if (merged.globalActions.at(-1) === "ask") {
		return `profiles.${requestedProfileName}.permission.* uses "ask", but unattended profiles only allow "allow" and "deny"`;
	}
	for (const [subject, rules] of Object.entries(merged.subjects)) {
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (!rule || rule.action !== "ask") continue;
			const shadowed = rules.slice(i + 1).some((later) =>
				later.action !== "ask" && (later.rawPattern === "*" || later.rawPattern === rule.rawPattern)
			);
			if (!shadowed) {
				return `profiles.${requestedProfileName}.permission.${subject}.${JSON.stringify(rule.rawPattern)} uses "ask", but unattended profiles only allow "allow" and "deny"`;
			}
		}
	}
	return undefined;
}

export function compilePolicy(policy: RawPolicy, cwd: string, requestedProfileName: string): CompiledPolicy {
	const options = resolveProfileOptions(policy, requestedProfileName);
	const merged = mergePermissionLayers(getProfileLayers(policy, requestedProfileName));

	const subjects: Record<string, CompiledPatternRule[]> = {};
	for (const [subject, rawRules] of Object.entries(merged.subjects)) {
		subjects[subject] = rawRules.map((rule) => {
			const compiled = compilePattern(subject, rule.rawPattern, cwd);
			return {
				...compiled,
				action: rule.action,
			};
		});
	}

	return {
		profileName: requestedProfileName === BASE_PROFILE_NAME ? "base" : requestedProfileName,
		requestedProfileName,
		globalActions: merged.globalActions,
		subjects,
		unattended: options.unattended,
	};
}


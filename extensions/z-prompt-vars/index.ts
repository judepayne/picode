import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	bootstrapVarsFiles,
	buildPromptVars,
	formatBootstrapResult,
	formatMutationResult,
	formatVars,
	formatWriteLocation,
	getRawStoredVarValue,
	getVarValue,
	getVisibleVars,
	interpolatePrompt,
	setVar,
	setWriteLocation,
	unsetVar,
	type PiLocation,
} from "./prompt-vars.ts";

const MODE_STATE_ENTRY_TYPE = "agent-mode-state";

interface ModeStateSessionEntry {
	type?: string;
	customType?: string;
	data?: {
		modeId?: string;
	};
}

const VarsParams = Type.Object(
	{
		action: Type.Optional(Type.String({ description: 'One of "list", "get", "set", "unset", "location", or "bootstrap".' })),
		key: Type.Optional(Type.String({ description: "Variable key for action: get, set, or unset." })),
		value: Type.Optional(Type.Any({ description: 'Variable value for action: set, or "project" | "global" for action: location.' })),
	},
	{ additionalProperties: false },
);

function findCurrentModeId(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as ModeStateSessionEntry;
		if (entry?.type !== "custom" || entry.customType !== MODE_STATE_ENTRY_TYPE) continue;
		const modeId = entry.data?.modeId?.trim().toLowerCase();
		if (modeId) return modeId;
	}
	return undefined;
}

type VarsCommandRequest =
	| { action: "list" }
	| { action: "get"; key: string }
	| { action: "set"; key: string; value: unknown }
	| { action: "unset"; key: string }
	| { action: "location"; value?: PiLocation }
	| { action: "bootstrap" };

function parseLooseValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return raw;
	}
}

function parseVarsCommand(args: string): VarsCommandRequest | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { action: "list" };

	const locationMatch = /^location(?:\s+(project|global))?\s*$/u.exec(trimmed);
	if (locationMatch) {
		return {
			action: "location",
			value: locationMatch[1] as PiLocation | undefined,
		};
	}

	if (/^bootstrap\s*$/u.test(trimmed)) {
		return { action: "bootstrap" };
	}

	const setMatch = /^set\s+(\S+)\s+([\s\S]+)$/u.exec(trimmed);
	if (setMatch) {
		return {
			action: "set",
			key: setMatch[1],
			value: parseLooseValue(setMatch[2]),
		};
	}

	const unsetMatch = /^unset\s+(\S+)\s*$/u.exec(trimmed);
	if (unsetMatch) {
		return {
			action: "unset",
			key: unsetMatch[1],
		};
	}

	if (/^location\b/u.test(trimmed)) {
		return { error: "Usage: /vars location [project|global]" };
	}
	if (/^bootstrap\b/u.test(trimmed)) {
		return { error: "Usage: /vars bootstrap" };
	}
	if (/^set\b/u.test(trimmed)) {
		return { error: "Usage: /vars set <key> <value>. Values may be JSON or bare strings." };
	}
	if (/^unset\b/u.test(trimmed)) {
		return { error: "Usage: /vars unset <key>" };
	}

	return { action: "get", key: trimmed };
}

export default function promptVarsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			bootstrapVarsFiles(ctx.cwd, findCurrentModeId(ctx));
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Prompt vars bootstrap failed: ${message}`, "warning");
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = buildPromptVars(ctx.cwd, findCurrentModeId(ctx));
		const systemPrompt = interpolatePrompt(event.systemPrompt, state.promptVars);
		return { systemPrompt };
	});

	pi.registerCommand("vars", {
		description:
			"Show vars, inspect one key, mutate stored vars, bootstrap missing files, or control write location with /vars location [project|global]",
		handler: async (args, ctx) => {
			const request = parseVarsCommand(args);
			if ("error" in request) {
				ctx.ui.notify(request.error, "warning");
				return;
			}

			const modeId = findCurrentModeId(ctx);
			try {
				if (request.action === "bootstrap") {
					const result = bootstrapVarsFiles(ctx.cwd, modeId);
					ctx.ui.notify(formatBootstrapResult(result), "info");
					return;
				}

				if (request.action === "location") {
					const state = request.value ? setWriteLocation(ctx.cwd, request.value, modeId) : buildPromptVars(ctx.cwd, modeId);
					ctx.ui.notify(formatWriteLocation(state), "info");
					return;
				}

				if (request.action === "set") {
					const state = setVar(ctx.cwd, request.key, request.value, modeId);
					ctx.ui.notify(formatMutationResult(request.key, state), "info");
					return;
				}

				if (request.action === "unset") {
					const state = unsetVar(ctx.cwd, request.key, modeId);
					ctx.ui.notify(formatMutationResult(request.key, state), "info");
					return;
				}

				const state = buildPromptVars(ctx.cwd, modeId);
				if (state.configError) {
					ctx.ui.notify(state.configError, "warning");
				}
				if (request.action === "list") {
					ctx.ui.notify(formatVars(getVisibleVars(state)), "info");
					return;
				}
				const value = getVarValue(state, request.key);
				if (value === undefined) {
					ctx.ui.notify(`Unknown var: ${request.key}`, "warning");
					return;
				}
				const rawValue = getRawStoredVarValue(state, request.key);
				ctx.ui.notify(`${request.key}=${JSON.stringify(rawValue === undefined ? value : rawValue)}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "warning");
			}
		},
	});

	pi.registerTool({
		name: "vars",
		label: "Vars",
		description: "Inspect derived prompt vars, manage agent-mode vars, bootstrap missing files, and control whether writes go to the project or global config.",
		promptSnippet:
			"Inspect prompt vars for the active plan and design files, bootstrap missing agent-mode vars files, update stored vars, or switch the write location between project and global",
		promptGuidelines: [
			"Use this tool when you need the live value of a var instead of guessing it.",
			"Use action: bootstrap when the workspace is missing the expected agent-mode vars files.",
			"Prefer action: bootstrap over manually writing the initial vars files from scratch.",
			"Use action: set or unset to manage stored vars.",
			"Use action: location with value project or global to change where future writes go.",
			"Project vars override global vars when both are present.",
			"Do not try to set the derived built-in keys plan, plan.path, plan.exists, plan.active, design, design.path, design.exists, or design.active.",
		],
		parameters: VarsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = typeof params.action === "string" && params.action.trim() ? params.action.trim() : "list";
			const key = typeof params.key === "string" ? params.key.trim() : "";
			const modeId = findCurrentModeId(ctx);

			if (action !== "list" && action !== "get" && action !== "set" && action !== "unset" && action !== "location" && action !== "bootstrap") {
				return {
					content: [{ type: "text", text: 'action must be one of "list", "get", "set", "unset", "location", or "bootstrap".' }],
					isError: true,
					details: { action },
				};
			}

			try {
				if (action === "bootstrap") {
					const result = bootstrapVarsFiles(ctx.cwd, modeId);
					return {
						content: [{ type: "text", text: formatBootstrapResult(result) }],
						details: {
							action,
							created: result.created,
							existing: result.existing,
							configPath: result.state.configPath,
							writeLocation: result.state.writeLocation,
							varsFileName: result.state.varsFileName,
							writeConfigPath: result.state.writeConfigPath,
							projectConfigPath: result.state.projectConfigPath,
							globalConfigPath: result.state.globalConfigPath,
						},
					};
				}

				if (action === "location") {
					if (params.value !== undefined && params.value !== "project" && params.value !== "global") {
						return {
							content: [{ type: "text", text: 'value for action: location must be "project" or "global".' }],
							isError: true,
							details: { action, value: params.value },
						};
					}
					const state = params.value === undefined
						? buildPromptVars(ctx.cwd, modeId)
						: setWriteLocation(ctx.cwd, params.value as PiLocation, modeId);
					return {
						content: [{ type: "text", text: formatWriteLocation(state) }],
						details: {
							action,
							value: state.writeLocation,
							varsFileName: state.varsFileName,
							writeConfigPath: state.writeConfigPath,
							projectConfigPath: state.projectConfigPath,
							globalConfigPath: state.globalConfigPath,
						},
					};
				}

				if (action === "set") {
					if (!key) {
						return {
							content: [{ type: "text", text: "key is required for action: set." }],
							isError: true,
							details: { action },
						};
					}
					if (!("value" in params)) {
						return {
							content: [{ type: "text", text: "value is required for action: set." }],
							isError: true,
							details: { action, key },
						};
					}
					const state = setVar(ctx.cwd, key, params.value, modeId);
					return {
						content: [{ type: "text", text: formatMutationResult(key, state) }],
						details: {
							action,
							key,
							value: getRawStoredVarValue(state, key),
							configPath: state.configPath,
							writeLocation: state.writeLocation,
							writeConfigPath: state.writeConfigPath,
							promptVars: state.promptVars,
						},
					};
				}

				if (action === "unset") {
					if (!key) {
						return {
							content: [{ type: "text", text: "key is required for action: unset." }],
							isError: true,
							details: { action },
						};
					}
					const state = unsetVar(ctx.cwd, key, modeId);
					return {
						content: [{ type: "text", text: formatMutationResult(key, state) }],
						details: {
							action,
							key,
							value: getRawStoredVarValue(state, key),
							configPath: state.configPath,
							writeLocation: state.writeLocation,
							writeConfigPath: state.writeConfigPath,
							promptVars: state.promptVars,
						},
					};
				}

				const state = buildPromptVars(ctx.cwd, modeId);
				const vars = getVisibleVars(state);
				if (action === "get") {
					if (!key) {
						return {
							content: [{ type: "text", text: "key is required for action: get." }],
							isError: true,
							details: { action },
						};
					}
					const resolvedValue = getVarValue(state, key);
					if (resolvedValue === undefined) {
						return {
							content: [{ type: "text", text: `Unknown var: ${key}` }],
							isError: true,
							details: {
								action,
								key,
								configPath: state.configPath,
								writeLocation: state.writeLocation,
								writeConfigPath: state.writeConfigPath,
								configError: state.configError,
							},
						};
					}
					const rawValue = getRawStoredVarValue(state, key);
					return {
						content: [{ type: "text", text: rawValue === undefined ? resolvedValue : JSON.stringify(rawValue) }],
						details: {
							action,
							key,
							value: rawValue === undefined ? resolvedValue : rawValue,
							configPath: state.configPath,
							writeLocation: state.writeLocation,
							writeConfigPath: state.writeConfigPath,
							configError: state.configError,
						},
					};
				}

				return {
					content: [{ type: "text", text: formatVars(vars) }],
					details: {
						action,
						vars,
						storedVars: state.storedVars,
						promptVars: state.promptVars,
						configPath: state.configPath,
						writeLocation: state.writeLocation,
						writeConfigPath: state.writeConfigPath,
						configError: state.configError,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: { action, key },
				};
			}
		},
	});
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import agentModeExtension from "../index.ts";
import { COLLECT_AGENT_ASSET_CARDS_EVENT, type CollectAgentAssetCardsRequest } from "../../agent-assets/contract.ts";
import { buildPromptVars, getVarValue, setAutomodeEnabled } from "../../z-prompt-vars/prompt-vars.ts";
import { ENV_TOP_RUN_ID } from "../../subagent-mode/depth.ts";

type LifecycleHandler = (event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: FakeContext) => Promise<void> | void;
type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: FakeContext) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;
type ToolRegistration = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: unknown,
		ctx: FakeContext,
	) => Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean; details?: Record<string, unknown> }>;
};

class FakeEventBus {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	assetCollectionCount = 0;
	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		if (event === COLLECT_AGENT_ASSET_CARDS_EVENT) {
			this.assetCollectionCount += 1;
			const request = data as CollectAgentAssetCardsRequest;
			request.entries.push({
				source: "test",
				agents: [
					{
						name: "Builder",
						description: "Build things",
						profile: "builder",
						tools: "read, bash",
						subagents: "scout, reviewer",
						bash: "full",
						thinking: "low",
						prompt: "Build prompt",
					},
					{
						name: "Planner",
						profile: "planner",
						tools: "read",
						bash: "read-only",
						prompt: "Plan prompt",
					},
					{
						name: "Designer",
						profile: "designer",
						tools: "read, edit",
						bash: "full",
						prompt: "Design prompt",
					},
				],
			});
		}
	}
}

class FakePi {
	readonly events = new FakeEventBus();
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly commands = new Map<string, { handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown[] }>();
	readonly tools = new Map<string, ToolRegistration>();
	readonly sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	readonly sentUserMessages: string[] = [];
	readonly sessionEntries: unknown[] = [];
	toolCallHandler?: ToolCallHandler;
	activeTools: string[] = [];
	thinkingLevel: string | undefined;
	appendedEntries: Array<{ type: string; data: unknown }> = [];

	on(event: string, handler: LifecycleHandler | ToolCallHandler): void {
		if (event === "tool_call") {
			this.toolCallHandler = handler as ToolCallHandler;
			return;
		}
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler as LifecycleHandler);
		this.lifecycle.set(event, handlers);
	}

	registerCommand(name: string, config: { handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown[] }): void {
		this.commands.set(name, config);
	}

	registerTool(tool: ToolRegistration): void {
		this.tools.set(tool.name, tool);
	}

	registerShortcut(): void {}

	getAllTools(): Array<{ name: string }> {
		return [{ name: "read" }, { name: "bash" }, { name: "edit" }];
	}

	setActiveTools(tools: string[]): void {
		this.activeTools = tools;
	}

	setThinkingLevel(level: string): void {
		this.thinkingLevel = level;
	}

	async setModel(): Promise<boolean> {
		return true;
	}

	appendEntry(type: string, data: unknown): void {
		this.appendedEntries.push({ type, data });
		this.sessionEntries.push({ type: "custom", customType: type, data });
	}

	sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
		this.sentMessages.push({ message, options });
		this.sessionEntries.push({ type: "custom_message", customType: message.customType, details: message.details, content: message.content });
	}

	sendUserMessage(content: string): void {
		this.sentUserMessages.push(content);
	}

	async emitLifecycle(event: string, payload: Record<string, unknown>, ctx: FakeContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.lifecycle.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}

	async tool(toolName: string, input: Record<string, unknown>, ctx: FakeContext): Promise<{ block?: boolean; reason?: string } | undefined> {
		assert.ok(this.toolCallHandler, "tool_call handler registered");
		return await this.toolCallHandler({ toolName, input }, ctx);
	}
}

class FakeContext {
	readonly hasUI = true;
	readonly notifications: Array<{ message: string; level?: string }> = [];
	readonly statuses: Record<string, string | undefined> = {};
	readonly cwd: string;
	readonly branch: unknown[];
	idle = true;
	readonly modelRegistry = { find: () => undefined };
	readonly sessionManager = {
		getBranch: (): unknown[] => this.branch,
		getSessionFile: (): undefined => undefined,
	};

	constructor(cwd = process.cwd(), branch: unknown[] = []) {
		this.cwd = cwd;
		this.branch = branch;
	}

	ui = {
		notify: (message: string, level?: string): void => {
			this.notifications.push({ message, level });
		},
		setStatus: (key: string, value: string | undefined): void => {
			this.statuses[key] = value;
		},
	};

	isIdle(): boolean {
		return this.idle;
	}
}

const tempDirs: string[] = [];
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedTopRunId: string | undefined;
let savedGateProfile: string | undefined;
let savedGateProfileLock: string | undefined;

function makeTempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "picode-agent-mode-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	const home = makeTempCwd();
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	savedTopRunId = process.env[ENV_TOP_RUN_ID];
	savedGateProfile = process.env.GATE_PROFILE;
	savedGateProfileLock = process.env.GATE_PROFILE_LOCK;
	delete process.env[ENV_TOP_RUN_ID];
	delete process.env.GATE_PROFILE;
	delete process.env.GATE_PROFILE_LOCK;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	if (savedTopRunId === undefined) delete process.env[ENV_TOP_RUN_ID];
	else process.env[ENV_TOP_RUN_ID] = savedTopRunId;
	if (savedGateProfile === undefined) delete process.env.GATE_PROFILE;
	else process.env.GATE_PROFILE = savedGateProfile;
	if (savedGateProfileLock === undefined) delete process.env.GATE_PROFILE_LOCK;
	else process.env.GATE_PROFILE_LOCK = savedGateProfileLock;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-mode extension entrypoint", () => {
	test("registers /agents and applies the initial mode on session_start", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext();

		assert.ok(pi.commands.has("agents"));
		await pi.emitLifecycle("session_start", {}, ctx);

		assert.equal(pi.events.assetCollectionCount, 1);
		assert.deepEqual(pi.activeTools, ["read", "bash"]);
		assert.equal(pi.thinkingLevel, "low");
		assert.equal(pi.appendedEntries[0]?.type, "agent-mode-state");
		assert.deepEqual(pi.events.emitted.find((entry) => entry.event === "gate:switch-profile")?.data, {
			profile: "builder",
			notify: false,
			source: "agent-mode",
		});
		assert.equal(process.env.GATE_PROFILE, "builder");
	});

	test("before_agent_start prepends the active mode prompt", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext();
		await pi.emitLifecycle("session_start", {}, ctx);

		const result = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
		assert.match(result.systemPrompt ?? "", /The canonical active mode for this turn is Builder/);
		assert.match(result.systemPrompt ?? "", /Build prompt/);
		assert.match(result.systemPrompt ?? "", /base prompt/);
	});

	test("does not overwrite a locked gate profile env", async () => {
		process.env.GATE_PROFILE = "planner";
		process.env.GATE_PROFILE_LOCK = "1";
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext();

		await pi.emitLifecycle("session_start", {}, ctx);

		assert.equal(process.env.GATE_PROFILE, "planner");
	});

	test("/agents can switch modes and read-only bash policy blocks mutating bash", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext();
		await pi.emitLifecycle("session_start", {}, ctx);

		const agentsCommand = pi.commands.get("agents");
		assert.ok(agentsCommand);
		await agentsCommand.handler("Planner", ctx);

		assert.deepEqual(pi.activeTools, ["read"]);
		assert.equal(process.env.GATE_PROFILE, "planner");
		const allowed = await pi.tool("bash", { command: "ls -la" }, ctx);
		assert.equal(allowed, undefined);
		const blocked = await pi.tool("bash", { command: "rm -rf dist" }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /read-only bash/);
	});

	test("switch_agent_mode queues mode changes until the next agent turn", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);

		const agentsCommand = pi.commands.get("agents");
		assert.ok(agentsCommand);
		await agentsCommand.handler("Planner", ctx);
		setAutomodeEnabled(ctx.cwd, true, "planner");
		await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx);
		assert.deepEqual(pi.activeTools, ["read", "switch_agent_mode"]);
		assert.equal(process.env.GATE_PROFILE, "planner");

		ctx.idle = false;
		const tool = pi.tools.get("switch_agent_mode");
		assert.ok(tool);
		const result = await tool.execute("tool", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.match(result.content?.[0]?.text ?? "", /Queued agent mode switch to Builder/);
		assert.deepEqual(pi.activeTools, ["read", "switch_agent_mode"]);
		assert.equal(process.env.GATE_PROFILE, "planner");
		assert.deepEqual(pi.events.emitted.at(-1)?.data, {
			profile: "planner",
			notify: false,
			source: "agent-mode",
		});
		const blocked = await pi.tool("bash", { command: "rm -rf dist" }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /Mode Planner only allows read-only bash/);
		assert.equal(pi.sentMessages.length, 0);
		assert.equal(pi.sentUserMessages.length, 0);
		ctx.idle = true;
		await pi.emitLifecycle("agent_settled", {}, ctx);
		assert.equal(pi.sentUserMessages.length, 1);
		assert.match(pi.sentUserMessages[0] ?? "", /system-generated, not user input/);

		const promptResult = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
		assert.match(promptResult.systemPrompt ?? "", /The canonical active mode for this turn is Builder/);
		assert.deepEqual(pi.activeTools, ["read", "bash", "switch_agent_mode"]);
		assert.equal(process.env.GATE_PROFILE, "builder");
		assert.equal(pi.appendedEntries.at(-1)?.type, "agent-mode-state");
		assert.deepEqual(pi.events.emitted.at(-1)?.data, {
			profile: "builder",
			notify: false,
			source: "agent-mode",
		});
		const allowedAfterHandoff = await pi.tool("bash", { command: "rm -rf dist" }, ctx);
		assert.equal(allowedAfterHandoff, undefined);
	});

	test("switch_agent_mode handoff survives a fresh extension instance", async () => {
		const cwd = makeTempCwd();
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(cwd);
		await pi.emitLifecycle("session_start", {}, ctx);
		const agentsCommand = pi.commands.get("agents");
		const tool = pi.tools.get("switch_agent_mode");
		assert.ok(agentsCommand);
		assert.ok(tool);

		await agentsCommand.handler("Planner", ctx);
		setAutomodeEnabled(cwd, true, "planner");
		await tool.execute("tool", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);

		const freshPi = new FakePi();
		agentModeExtension(freshPi as never);
		const freshCtx = new FakeContext(cwd, [...pi.sessionEntries]);
		await freshPi.emitLifecycle("session_start", {}, freshCtx);
		assert.equal(process.env.GATE_PROFILE, "planner");
		await freshPi.emitLifecycle("resources_discover", {}, freshCtx);
		assert.equal(freshPi.sentUserMessages.length, 1);
		assert.match(freshPi.sentUserMessages[0] ?? "", /Implement the plan/);

		const promptResult = await freshPi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, freshCtx) as { systemPrompt?: string };
		assert.match(promptResult.systemPrompt ?? "", /The canonical active mode for this turn is Builder/);
		assert.deepEqual(freshPi.activeTools, ["read", "bash", "switch_agent_mode"]);
		assert.equal(process.env.GATE_PROFILE, "builder");
		assert.equal(freshPi.appendedEntries.at(-1)?.type, "agent-mode-state");
	});

	test("invalid durable mode handoffs are warned and cleared", async () => {
		const cwd = makeTempCwd();
		setAutomodeEnabled(cwd, true, "planner");
		const branch = [
			{ type: "custom", customType: "agent-mode-state", data: { modeId: "planner" } },
			{ type: "custom", customType: "agent-mode-handoff", data: { targetModeId: "missing" } },
		];
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(cwd, branch);
		await pi.emitLifecycle("session_start", {}, ctx);

		const promptResult = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
		assert.match(promptResult.systemPrompt ?? "", /The canonical active mode for this turn is Planner/);
		assert.equal(process.env.GATE_PROFILE, "planner");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /invalid queued handoff target/);
		assert.equal(pi.appendedEntries.at(-1)?.type, "agent-mode-state");
	});

	test("/automode off clears queued mode handoffs", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);

		const agentsCommand = pi.commands.get("agents");
		const automodeCommand = pi.commands.get("automode");
		const tool = pi.tools.get("switch_agent_mode");
		assert.ok(agentsCommand);
		assert.ok(automodeCommand);
		assert.ok(tool);
		await agentsCommand.handler("Planner", ctx);
		setAutomodeEnabled(ctx.cwd, true, "planner");
		await tool.execute("tool", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);

		await automodeCommand.handler("off", ctx);
		assert.equal(getVarValue(buildPromptVars(ctx.cwd, "planner"), "automode.enabled"), "false");
		assert.deepEqual(pi.activeTools, ["read"]);

		const promptResult = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
		assert.match(promptResult.systemPrompt ?? "", /The canonical active mode for this turn is Planner/);
		assert.equal(process.env.GATE_PROFILE, "planner");
	});

	test("switch_agent_mode tool requires automode to be enabled", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);

		const tool = pi.tools.get("switch_agent_mode");
		assert.ok(tool);
		const result = await tool.execute("tool", { mode: "Planner" }, new AbortController().signal, undefined, ctx);

		assert.equal(result.isError, true);
		assert.match(result.content?.[0]?.text ?? "", /only available while automode\.enabled is true/);
		assert.equal(process.env.GATE_PROFILE, "builder");
	});

	test("switch_agent_mode tool reports unknown modes", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);
		setAutomodeEnabled(ctx.cwd, true, "builder");

		const tool = pi.tools.get("switch_agent_mode");
		assert.ok(tool);
		const result = await tool.execute("tool", { mode: "Nope" }, new AbortController().signal, undefined, ctx);

		assert.equal(result.isError, true);
		assert.match(result.content?.[0]?.text ?? "", /unknown mode/);
	});

	test("/automode only starts from Designer", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);

		const automodeCommand = pi.commands.get("automode");
		assert.ok(automodeCommand);
		await automodeCommand.handler("", ctx);

		assert.equal(getVarValue(buildPromptVars(ctx.cwd, "builder"), "automode.enabled"), "false");
		assert.equal(pi.sentMessages.length, 0);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /only be started from Designer/);
	});

	test("/automode starts in Designer and /automode off clears it", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		await pi.emitLifecycle("session_start", {}, ctx);

		const agentsCommand = pi.commands.get("agents");
		const automodeCommand = pi.commands.get("automode");
		assert.ok(agentsCommand);
		assert.ok(automodeCommand);
		await agentsCommand.handler("Designer", ctx);
		await automodeCommand.handler("on", ctx);

		assert.equal(getVarValue(buildPromptVars(ctx.cwd, "designer"), "automode.enabled"), "true");
		assert.deepEqual(pi.activeTools, ["read", "edit", "switch_agent_mode"]);
		assert.equal(pi.sentMessages.length, 1);
		assert.equal(pi.sentMessages[0]?.message.customType, "agent-mode-handoff");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /started/);

		await automodeCommand.handler("status", ctx);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Automode: true/);

		await automodeCommand.handler("off", ctx);
		assert.equal(getVarValue(buildPromptVars(ctx.cwd, "designer"), "automode.enabled"), "false");
		assert.deepEqual(pi.activeTools, ["read", "edit"]);
	});
});

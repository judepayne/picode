import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import agentModeExtension from "../index.ts";
import { COLLECT_AGENT_ASSET_CARDS_EVENT, type CollectAgentAssetCardsRequest } from "../../agent-assets/contract.ts";
import { ENV_TOP_RUN_ID } from "../../subagent-mode/depth.ts";

type LifecycleHandler = (event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: FakeContext) => Promise<void> | void;
type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: FakeContext) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;

class FakeEventBus {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		if (event === COLLECT_AGENT_ASSET_CARDS_EVENT) {
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
				],
			});
		}
	}
}

class FakePi {
	readonly events = new FakeEventBus();
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly commands = new Map<string, { handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown[] }>();
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
	readonly cwd = process.cwd();
	readonly modelRegistry = { find: () => undefined };
	readonly sessionManager = {
		getBranch: (): unknown[] => [],
		getSessionFile: (): undefined => undefined,
	};

	ui = {
		notify: (message: string, level?: string): void => {
			this.notifications.push({ message, level });
		},
		setStatus: (key: string, value: string | undefined): void => {
			this.statuses[key] = value;
		},
	};
}

let savedTopRunId: string | undefined;
let savedGateProfile: string | undefined;
let savedGateProfileLock: string | undefined;

beforeEach(() => {
	savedTopRunId = process.env[ENV_TOP_RUN_ID];
	savedGateProfile = process.env.GATE_PROFILE;
	savedGateProfileLock = process.env.GATE_PROFILE_LOCK;
	delete process.env[ENV_TOP_RUN_ID];
	delete process.env.GATE_PROFILE;
	delete process.env.GATE_PROFILE_LOCK;
});

afterEach(() => {
	if (savedTopRunId === undefined) delete process.env[ENV_TOP_RUN_ID];
	else process.env[ENV_TOP_RUN_ID] = savedTopRunId;
	if (savedGateProfile === undefined) delete process.env.GATE_PROFILE;
	else process.env.GATE_PROFILE = savedGateProfile;
	if (savedGateProfileLock === undefined) delete process.env.GATE_PROFILE_LOCK;
	else process.env.GATE_PROFILE_LOCK = savedGateProfileLock;
});

describe("agent-mode extension entrypoint", () => {
	test("registers /agents and applies the initial mode on session_start", async () => {
		const pi = new FakePi();
		agentModeExtension(pi as never);
		const ctx = new FakeContext();

		assert.ok(pi.commands.has("agents"));
		await pi.emitLifecycle("session_start", {}, ctx);

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
});

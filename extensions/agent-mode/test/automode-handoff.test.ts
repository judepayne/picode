import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { COLLECT_AGENT_ASSET_CARDS_EVENT, type CollectAgentAssetCardsRequest } from "../../agent-assets/contract.ts";
import piGate from "../../pi-gate/index.ts";
import { setAutomodeEnabled } from "../../z-prompt-vars/prompt-vars.ts";
import agentModeExtension from "../index.ts";

type LifecycleHandler = (event: Record<string, unknown>, ctx: DiagnosticContext) => Promise<unknown> | unknown;
type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: DiagnosticContext) => Promise<{ block?: boolean; reason?: string } | undefined> | { block?: boolean; reason?: string } | undefined;
type ToolRegistration = {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: DiagnosticContext) => Promise<unknown>;
};

class DiagnosticEventBus {
	readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.off(event, handler);
	}

	off(event: string, handler: (data: unknown) => void): void {
		this.handlers.set(event, (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
	}

	emit(event: string, data: unknown): void {
		if (event === COLLECT_AGENT_ASSET_CARDS_EVENT) {
			const request = data as CollectAgentAssetCardsRequest;
			request.entries.push({
				source: "automode-diagnostic",
				agents: [
					{ name: "Builder", profile: "builder", tools: "read, edit", bash: "full", prompt: "Build prompt" },
					{ name: "Planner", profile: "planner", tools: "read", bash: "read-only", prompt: "Plan prompt" },
					{ name: "Designer", profile: "designer", tools: "read, edit", bash: "full", prompt: "Design prompt" },
				],
			});
		}
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

class DiagnosticPi {
	readonly events = new DiagnosticEventBus();
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly toolCallHandlers: ToolCallHandler[] = [];
	readonly commands = new Map<string, { handler: (args: string, ctx: DiagnosticContext) => Promise<void> | void }>();
	readonly tools = new Map<string, ToolRegistration>();
	readonly sessionEntries: unknown[] = [];
	readonly sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	readonly sentUserMessages: string[] = [];
	activeTools: string[] = [];
	beforeAgentStartCount = 0;
	private currentContext: DiagnosticContext | undefined;
	private pendingUserTurn: Promise<unknown> | undefined;

	on(event: string, handler: LifecycleHandler | ToolCallHandler): void {
		if (event === "tool_call") {
			this.toolCallHandlers.push(handler as ToolCallHandler);
			return;
		}
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler as LifecycleHandler);
		this.lifecycle.set(event, handlers);
	}

	registerCommand(name: string, command: { handler: (args: string, ctx: DiagnosticContext) => Promise<void> | void }): void {
		this.commands.set(name, command);
	}

	registerTool(tool: ToolRegistration): void {
		this.tools.set(tool.name, tool);
	}

	registerShortcut(): void {}

	getAllTools(): Array<{ name: string }> {
		return ["read", "edit", ...this.tools.keys()].map((name) => ({ name }));
	}

	setActiveTools(tools: string[]): void {
		this.activeTools = tools;
	}

	setThinkingLevel(): void {}
	async setModel(): Promise<boolean> { return true; }

	appendEntry(type: string, data: unknown): void {
		this.sessionEntries.push({ type: "custom", customType: type, data });
	}

	sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
		this.sentMessages.push({ message, options });
	}

	sendUserMessage(content: string): void {
		this.sentUserMessages.push(content);
		const ctx = this.currentContext;
		assert.ok(ctx, "lifecycle context available");
		this.pendingUserTurn = this.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx);
	}

	async flushUserTurn(): Promise<void> {
		await this.pendingUserTurn;
		this.pendingUserTurn = undefined;
	}

	async emitLifecycle(event: string, payload: Record<string, unknown>, ctx: DiagnosticContext): Promise<unknown> {
		this.currentContext = ctx;
		if (event === "before_agent_start") this.beforeAgentStartCount += 1;
		let currentPayload = payload;
		let lastResult: unknown;
		for (const handler of this.lifecycle.get(event) ?? []) {
			lastResult = await handler(currentPayload, ctx);
			if (event === "before_agent_start" && lastResult && typeof lastResult === "object") {
				const systemPrompt = (lastResult as { systemPrompt?: unknown }).systemPrompt;
				if (typeof systemPrompt === "string") currentPayload = { ...currentPayload, systemPrompt };
			}
		}
		return lastResult;
	}

	async callTool(toolName: string, input: Record<string, unknown>, ctx: DiagnosticContext): Promise<{ block?: boolean; reason?: string } | undefined> {
		for (const handler of this.toolCallHandlers) {
			const decision = await handler({ toolName, input }, ctx);
			if (decision?.block) return decision;
		}
		return undefined;
	}
}

class DiagnosticContext {
	readonly cwd: string;
	hasUI = true;
	private idle = true;
	readonly statuses: Record<string, string | undefined> = {};
	readonly notifications: string[] = [];
	readonly modelRegistry = { find: () => undefined };
	readonly sessionManager: { getBranch: () => unknown[]; getSessionFile: () => undefined; buildContextEntries: () => unknown[] };

	constructor(cwd: string, pi: DiagnosticPi) {
		this.cwd = cwd;
		this.sessionManager = {
			getBranch: () => pi.sessionEntries,
			getSessionFile: () => undefined,
			buildContextEntries: () => [],
		};
	}

	isIdle(): boolean { return this.idle; }
	setIdle(idle: boolean): void { this.idle = idle; }

	ui = {
		notify: (message: string): void => { this.notifications.push(message); },
		setStatus: (key: string, value: string | undefined): void => { this.statuses[key] = value; },
		select: async (): Promise<string> => "Deny",
	};
}

let cwd: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedGateProfile: string | undefined;
let savedGateProfileLock: string | undefined;
let savedGateLineage: string | undefined;

beforeEach(() => {
	cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picode-automode-diagnostic-")));
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	savedGateProfile = process.env.GATE_PROFILE;
	savedGateProfileLock = process.env.GATE_PROFILE_LOCK;
	savedGateLineage = process.env.PI_GATE_PROFILE_LINEAGE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	delete process.env.GATE_PROFILE;
	delete process.env.GATE_PROFILE_LOCK;
	delete process.env.PI_GATE_PROFILE_LINEAGE;
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
	if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
	if (savedGateProfile === undefined) delete process.env.GATE_PROFILE; else process.env.GATE_PROFILE = savedGateProfile;
	if (savedGateProfileLock === undefined) delete process.env.GATE_PROFILE_LOCK; else process.env.GATE_PROFILE_LOCK = savedGateProfileLock;
	if (savedGateLineage === undefined) delete process.env.PI_GATE_PROFILE_LINEAGE; else process.env.PI_GATE_PROFILE_LINEAGE = savedGateLineage;
});

async function createPlannerRun(): Promise<{ pi: DiagnosticPi; ctx: DiagnosticContext }> {
	const pi = new DiagnosticPi();
	agentModeExtension(pi as never);
	piGate(pi as never);
	const ctx = new DiagnosticContext(cwd, pi);
	await pi.emitLifecycle("session_start", {}, ctx);
	await pi.commands.get("agents")!.handler("Planner", ctx);
	setAutomodeEnabled(cwd, true, "planner");
	ctx.setIdle(false);
	const prompt = await pi.emitLifecycle("before_agent_start", { systemPrompt: "base prompt" }, ctx) as { systemPrompt?: string };
	assert.match(prompt.systemPrompt ?? "", /canonical active mode for this turn is Planner/);
	return { pi, ctx };
}

describe("automode handoff lifecycle", () => {
	test("waits for settlement, then applies Builder before its generated continuation", async () => {
		const { pi, ctx } = await createPlannerRun();
		const switchTool = pi.tools.get("switch_agent_mode");
		assert.ok(switchTool);
		await switchTool.execute("switch", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);

		assert.equal(pi.beforeAgentStartCount, 1);
		assert.equal(pi.sentUserMessages.length, 0);
		assert.deepEqual(pi.activeTools, ["read", "switch_agent_mode"]);
		assert.equal(ctx.statuses.gate, "gate:planner");

		await pi.emitLifecycle("agent_end", {}, ctx);
		ctx.setIdle(true);
		await pi.emitLifecycle("agent_settled", {}, ctx);
		await pi.flushUserTurn();

		assert.equal(pi.beforeAgentStartCount, 2);
		assert.match(pi.sentUserMessages[0] ?? "", /system-generated, not user input/);
		assert.deepEqual(pi.activeTools, ["read", "edit", "switch_agent_mode"]);
		assert.equal(ctx.statuses.gate, "gate:builder");
		assert.equal(await pi.callTool("edit", { path: "src/example.ts" }, ctx), undefined);
	});

	test("retries at the next settled boundary when another handler already started work", async () => {
		const { pi, ctx } = await createPlannerRun();
		const switchTool = pi.tools.get("switch_agent_mode");
		assert.ok(switchTool);
		await switchTool.execute("switch", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);

		await pi.emitLifecycle("agent_settled", {}, ctx);
		assert.equal(pi.sentUserMessages.length, 0);
		ctx.setIdle(true);
		await pi.emitLifecycle("agent_settled", {}, ctx);
		await pi.flushUserTurn();

		assert.equal(pi.sentUserMessages.length, 1);
		assert.equal(ctx.statuses.gate, "gate:builder");
	});

	test("a newer non-triggering switch clears a stale generated handoff", async () => {
		const { pi, ctx } = await createPlannerRun();
		const switchTool = pi.tools.get("switch_agent_mode");
		assert.ok(switchTool);
		await switchTool.execute("first", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);
		await switchTool.execute("second", { mode: "Designer", triggerTurn: false }, new AbortController().signal, undefined, ctx);

		ctx.setIdle(true);
		await pi.emitLifecycle("agent_settled", {}, ctx);
		await pi.flushUserTurn();

		assert.equal(pi.sentUserMessages.length, 0);
		assert.equal(ctx.statuses.gate, "gate:planner");
	});

	test("does not launch a settled handoff after automode is disabled", async () => {
		const { pi, ctx } = await createPlannerRun();
		const switchTool = pi.tools.get("switch_agent_mode");
		assert.ok(switchTool);
		await switchTool.execute("switch", { mode: "Builder", triggerTurn: true, handoffPrompt: "Implement the plan." }, new AbortController().signal, undefined, ctx);
		setAutomodeEnabled(cwd, false, "planner");

		ctx.setIdle(true);
		await pi.emitLifecycle("agent_settled", {}, ctx);
		await pi.flushUserTurn();

		assert.equal(pi.sentUserMessages.length, 0);
		assert.deepEqual(pi.activeTools, ["read", "switch_agent_mode"]);
		assert.equal(ctx.statuses.gate, "gate:planner");
	});
});

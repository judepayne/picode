import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import piGate, { extractMutationTargets } from "../index.ts";

type ToolDecision = { block?: boolean; reason?: string } | undefined;
type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: FakeContext) => Promise<ToolDecision> | ToolDecision;
type LifecycleHandler = (event: unknown, ctx: FakeContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: FakeContext) => Promise<void> | void;

class FakeEventBus {
	readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

interface FakeContextOptions {
	cwd?: string;
	hasUI?: boolean;
	idle?: boolean;
	selectChoice?: string;
}

class FakeContext {
	cwd: string;
	hasUI: boolean;
	private idle: boolean;
	readonly notifications: Array<{ message: string; level?: string }> = [];
	readonly statuses: Record<string, string> = {};
	selectChoice: string;

	constructor(options: FakeContextOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.hasUI = options.hasUI ?? true;
		this.idle = options.idle ?? true;
		this.selectChoice = options.selectChoice ?? "Deny";
	}

	isIdle(): boolean {
		return this.idle;
	}

	setIdle(value: boolean): void {
		this.idle = value;
	}

	ui = {
		notify: (message: string, level?: string): void => {
			this.notifications.push({ message, level });
		},
		setStatus: (key: string, value: string): void => {
			this.statuses[key] = value;
		},
		select: async (): Promise<string> => this.selectChoice,
	};
}

class FakePi {
	readonly events = new FakeEventBus();
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly commands = new Map<string, CommandHandler>();
	toolCallHandler?: ToolCallHandler;

	on(event: string, handler: LifecycleHandler | ToolCallHandler): void {
		if (event === "tool_call") {
			this.toolCallHandler = handler as ToolCallHandler;
			return;
		}
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler as LifecycleHandler);
		this.lifecycle.set(event, handlers);
	}

	registerCommand(name: string, config: { handler: CommandHandler }): void {
		this.commands.set(name, config.handler);
	}

	async start(ctx: FakeContext): Promise<void> {
		for (const handler of this.lifecycle.get("session_start") ?? []) await handler({}, ctx);
	}

	async end(ctx: FakeContext): Promise<void> {
		for (const handler of this.lifecycle.get("agent_end") ?? []) await handler({}, ctx);
	}

	async tool(toolName: string, input: Record<string, unknown>, ctx: FakeContext): Promise<ToolDecision> {
		assert.ok(this.toolCallHandler, "tool_call handler registered");
		return await this.toolCallHandler({ toolName, input }, ctx);
	}
}

let savedGateProfile: string | undefined;
let savedGateProfileLock: string | undefined;
let savedGateProfileLineage: string | undefined;

beforeEach(() => {
	savedGateProfile = process.env.GATE_PROFILE;
	savedGateProfileLock = process.env.GATE_PROFILE_LOCK;
	savedGateProfileLineage = process.env.PI_GATE_PROFILE_LINEAGE;
	delete process.env.GATE_PROFILE;
	delete process.env.GATE_PROFILE_LOCK;
	delete process.env.PI_GATE_PROFILE_LINEAGE;
});

afterEach(() => {
	if (savedGateProfile === undefined) delete process.env.GATE_PROFILE;
	else process.env.GATE_PROFILE = savedGateProfile;
	if (savedGateProfileLock === undefined) delete process.env.GATE_PROFILE_LOCK;
	else process.env.GATE_PROFILE_LOCK = savedGateProfileLock;
	if (savedGateProfileLineage === undefined) delete process.env.PI_GATE_PROFILE_LINEAGE;
	else process.env.PI_GATE_PROFILE_LINEAGE = savedGateProfileLineage;
});

function createHarness(options: FakeContextOptions = {}): { pi: FakePi; ctx: FakeContext } {
	const pi = new FakePi();
	piGate(pi as never);
	const ctx = new FakeContext(options);
	return { pi, ctx };
}

async function switchProfile(pi: FakePi, profile: string, ctx: FakeContext): Promise<void> {
	pi.events.emit("gate:switch-profile", { profile, notify: false });
	await pi.end(ctx);
}

describe("pi-gate bash mutation analysis", () => {
	const cwd = process.cwd();

	it("treats plain find as read-only", () => {
		assert.deepEqual(
			extractMutationTargets("find . -name '*.ts'", cwd),
			{
				mutating: false,
				complex: false,
				paths: [],
				inferredCwdTarget: false,
				reason: "read-only command",
			},
		);
	});

	it("treats find -delete as mutating", () => {
		const analysis = extractMutationTargets("find . -name '*.tmp' -delete", cwd);
		assert.equal(analysis.mutating, true);
		assert.equal(analysis.reason, "find -delete targets");
		assert.ok(analysis.paths.length >= 1);
		assert.equal(extractMutationTargets("find . '-delete'", cwd).mutating, true);
		assert.equal(extractMutationTargets("find . \\-delete", cwd).mutating, true);
	});

	it("treats mutating awk patterns as mutating", () => {
		assert.equal(extractMutationTargets("awk 'BEGIN{system(\"touch /tmp/x\")}'", cwd).mutating, true);
		assert.equal(extractMutationTargets("awk 'BEGIN{print 1 > \"out.txt\"}'", cwd).mutating, true);
	});

	it("extracts fd-style redirect targets", () => {
		const analysis = extractMutationTargets("printf x 1>/tmp/pi-gate-test", cwd);
		assert.equal(analysis.mutating, true);
		assert.ok(analysis.paths.some((value) => value.endsWith("/tmp/pi-gate-test")));
	});
});

describe("pi-gate policy enforcement", () => {
	it("starts in the configured builder profile", async () => {
		const { pi, ctx } = createHarness();
		await pi.start(ctx);
		assert.equal(ctx.statuses.gate, "gate:builder");
	});

	it("allows ordinary builder local cleanup but denies hardened root/home rm patterns", async () => {
		const { pi, ctx } = createHarness();
		await pi.start(ctx);

		assert.equal(await pi.tool("bash", { command: "rm -rf node_modules" }, ctx), undefined);

		for (const command of [
			"rm -rf / --no-preserve-root",
			"rm --recursive --force /",
			"rm -r -f /etc",
			"rm -Rf ~/.ssh",
		]) {
			const decision = await pi.tool("bash", { command }, ctx);
			assert.equal(decision?.block, true, command);
			assert.match(decision?.reason ?? "", /deny|denied/i);
		}
	});

	it("applies read allow/deny precedence for env files", async () => {
		const { pi, ctx } = createHarness();
		await pi.start(ctx);

		assert.equal(await pi.tool("read", { path: ".env.example" }, ctx), undefined);
		const decision = await pi.tool("read", { path: ".env" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /read deny/);
	});

	it("uses profile-switch events for subsequent tool calls", async () => {
		const { pi, ctx } = createHarness({ hasUI: false });
		await pi.start(ctx);
		await switchProfile(pi, "planner", ctx);

		assert.equal(await pi.tool("bash", { command: "echo hello" }, ctx), undefined);
		const decision = await pi.tool("bash", { command: "npm install" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /bash ask/);
	});

	it("blocks base-profile external directory access when no UI can confirm ask", async () => {
		const { pi, ctx } = createHarness({ hasUI: false });
		await pi.start(ctx);
		await switchProfile(pi, "base", ctx);

		const decision = await pi.tool("read", { path: "/etc/passwd" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /external_directory ask|requires confirmation/i);
	});

	it("blocks ask-level decisions in unattended profiles", async () => {
		const { pi, ctx } = createHarness();
		await pi.start(ctx);
		await switchProfile(pi, "worker", ctx);

		const decision = await pi.tool("bash", { command: "sed -i 's/a/b/'" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /unattended/i);
	});

	it("applies inherited worker denials", async () => {
		const { pi, ctx } = createHarness();
		await pi.start(ctx);
		await switchProfile(pi, "worker", ctx);

		const decision = await pi.tool("bash", { command: "git push origin main" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /git push\*/);
	});

	it("queues non-idle profile switches until agent_end", async () => {
		const { pi, ctx } = createHarness({ idle: false, hasUI: false });
		await pi.start(ctx);
		pi.events.emit("gate:switch-profile", { profile: "planner", notify: false });

		assert.equal(await pi.tool("bash", { command: "true" }, ctx), undefined);
		await pi.end(ctx);
		const decision = await pi.tool("bash", { command: "true" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /bash ask/);
	});

	it("clears session approvals when reset changes the effective profile", async () => {
		process.env.GATE_PROFILE = "planner";
		const { pi, ctx } = createHarness({ selectChoice: "base" });
		await pi.start(ctx);

		const gateCommand = pi.commands.get("gate");
		assert.ok(gateCommand);
		await gateCommand("switch", ctx);
		assert.equal(ctx.statuses.gate, "gate:base");

		ctx.selectChoice = "Allow for session";
		assert.equal(await pi.tool("bash", { command: "sudo true" }, ctx), undefined);
		assert.equal(ctx.statuses.gate, "gate:base +1");

		ctx.selectChoice = "base";
		await gateCommand("switch", ctx);
		assert.equal(ctx.statuses.gate, "gate:planner");

		ctx.selectChoice = "Deny";
		const decision = await pi.tool("bash", { command: "sudo true" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /bash ask|denied/i);
	});
	it("applies lineage ceilings with strictest concrete decision", async () => {
		process.env.GATE_PROFILE = "worker";
		process.env.PI_GATE_PROFILE_LINEAGE = "planner,scout,worker";
		const { pi, ctx } = createHarness({ hasUI: false });
		await pi.start(ctx);

		const editDecision = await pi.tool("edit", { path: "src/generated.txt" }, ctx);
		assert.equal(editDecision?.block, true);
		assert.match(editDecision?.reason ?? "", /\[planner\].*edit deny/);

		const bashDecision = await pi.tool("bash", { command: "true" }, ctx);
		assert.equal(bashDecision?.block, true);
		assert.match(bashDecision?.reason ?? "", /\[scout\].*bash deny|unattended|\[planner\].*bash ask/);
	});

	it("fails closed for unknown profiles in gate lineage", async () => {
		process.env.GATE_PROFILE = "worker";
		process.env.PI_GATE_PROFILE_LINEAGE = "planner,missing-profile,worker";
		const { pi, ctx } = createHarness({ hasUI: false });
		await pi.start(ctx);

		const decision = await pi.tool("read", { path: "README.md" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /unknown profile/);
	});

	it("scopes session approvals by effective lineage", async () => {
		process.env.GATE_PROFILE = "base";
		const { pi, ctx } = createHarness({ selectChoice: "Allow for session" });
		await pi.start(ctx);

		assert.equal(await pi.tool("bash", { command: "sudo true" }, ctx), undefined);
		assert.equal(ctx.statuses.gate, "gate:base +1");

		process.env.PI_GATE_PROFILE_LINEAGE = "planner,base";
		ctx.selectChoice = "Deny";
		const decision = await pi.tool("bash", { command: "sudo true" }, ctx);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /bash ask|denied/i);
	});

});

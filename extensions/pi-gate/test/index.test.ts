import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { setGateAutoEnabled, setVar } from "../../z-prompt-vars/prompt-vars.ts";
import { assessGateAutoRisk } from "../auto-approver/risk.ts";
import piGate, { extractMutationTargets, validatePolicySchema } from "../index.ts";
import schema from "../policy.schema.json" with { type: "json" };

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
	selectCalls = 0;

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
		select: async (): Promise<string> => {
			this.selectCalls += 1;
			return this.selectChoice;
		},
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
let savedGateAutoEndpoint: string | undefined;
let savedGateAutoOwnerPid: string | undefined;
let savedGateAutoBackend: string | undefined;
let savedGateAutoContextHash: string | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
	savedGateProfile = process.env.GATE_PROFILE;
	savedGateProfileLock = process.env.GATE_PROFILE_LOCK;
	savedGateProfileLineage = process.env.PI_GATE_PROFILE_LINEAGE;
	savedGateAutoEndpoint = process.env.PI_GATE_AUTO_ENDPOINT;
	savedGateAutoOwnerPid = process.env.PI_GATE_AUTO_OWNER_PID;
	savedGateAutoBackend = process.env.PI_GATE_AUTO_BACKEND;
	savedGateAutoContextHash = process.env.PI_GATE_AUTO_CONTEXT_HASH;
	delete process.env.GATE_PROFILE;
	delete process.env.GATE_PROFILE_LOCK;
	delete process.env.PI_GATE_PROFILE_LINEAGE;
	delete process.env.PI_GATE_AUTO_ENDPOINT;
	delete process.env.PI_GATE_AUTO_OWNER_PID;
	delete process.env.PI_GATE_AUTO_BACKEND;
	delete process.env.PI_GATE_AUTO_CONTEXT_HASH;
});

afterEach(() => {
	if (savedGateProfile === undefined) delete process.env.GATE_PROFILE;
	else process.env.GATE_PROFILE = savedGateProfile;
	if (savedGateProfileLock === undefined) delete process.env.GATE_PROFILE_LOCK;
	else process.env.GATE_PROFILE_LOCK = savedGateProfileLock;
	if (savedGateProfileLineage === undefined) delete process.env.PI_GATE_PROFILE_LINEAGE;
	else process.env.PI_GATE_PROFILE_LINEAGE = savedGateProfileLineage;
	if (savedGateAutoEndpoint === undefined) delete process.env.PI_GATE_AUTO_ENDPOINT;
	else process.env.PI_GATE_AUTO_ENDPOINT = savedGateAutoEndpoint;
	if (savedGateAutoOwnerPid === undefined) delete process.env.PI_GATE_AUTO_OWNER_PID;
	else process.env.PI_GATE_AUTO_OWNER_PID = savedGateAutoOwnerPid;
	if (savedGateAutoBackend === undefined) delete process.env.PI_GATE_AUTO_BACKEND;
	else process.env.PI_GATE_AUTO_BACKEND = savedGateAutoBackend;
	if (savedGateAutoContextHash === undefined) delete process.env.PI_GATE_AUTO_CONTEXT_HASH;
	else process.env.PI_GATE_AUTO_CONTEXT_HASH = savedGateAutoContextHash;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function createHarness(options: FakeContextOptions = {}): { pi: FakePi; ctx: FakeContext } {
	const pi = new FakePi();
	piGate(pi as never);
	const ctx = new FakeContext(options);
	return { pi, ctx };
}

function makeWorkspace(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-"));
	tempDirs.push(cwd);
	return cwd;
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

	it("marks shell chains and pipes as complex even when not otherwise mutating", () => {
		assert.equal(extractMutationTargets("cat script.sh | sh", cwd).complex, true);
		assert.equal(extractMutationTargets("echo one\necho two", cwd).complex, true);
		assert.equal(extractMutationTargets("rg 'foo|bar'", cwd).complex, false);
		assert.equal(extractMutationTargets('grep -E "foo|bar" file', cwd).complex, false);
	});
});

describe("pi-gate auto risk assessment", () => {
	it("flags edits through workspace symlinks that escape the workspace", () => {
		const cwd = makeWorkspace();
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-risk-external-"));
		const linkPath = path.join(cwd, "out");
		try {
			fs.symlinkSync(external, linkPath, "dir");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return;
			throw error;
		}
		const result = assessGateAutoRisk({
			requestId: "risk-symlink",
			toolName: "edit",
			subject: "edit:out/file.txt",
			profileName: "base",
			lineageNames: ["base"],
			cwd,
			unattended: false,
			processKind: "top-level",
			inputSummary: { path: "out/file.txt" },
			pathCandidates: [path.join(linkPath, "file.txt")],
		});
		assert.ok(result.flags.includes("external_mutation"));
	});

	it("treats node --check as a low-risk allow candidate", () => {
		const cwd = makeWorkspace();
		const result = assessGateAutoRisk({
			requestId: "risk-node-check",
			toolName: "bash",
			subject: "bash:node --check smoketest/gate-auto/src/example.ts",
			profileName: "planner",
			lineageNames: ["planner"],
			cwd,
			unattended: false,
			processKind: "top-level",
			bash: { command: "node --check smoketest/gate-auto/src/example.ts", normalizedCommand: "node --check smoketest/gate-auto/src/example.ts", analysis: { readOnly: true, mutating: false } },
			pathCandidates: [cwd],
		});
		assert.equal(result.recommendedDecision, "allow_if_clearly_requested");
		assert.ok(!result.flags.includes("unclassified_bash"));
	});

	it("does not classify external read-only tools as external mutations", () => {
		const cwd = makeWorkspace();
		const result = assessGateAutoRisk({
			requestId: "risk-ls",
			toolName: "ls",
			subject: "list:/tmp",
			profileName: "base",
			lineageNames: ["base"],
			cwd,
			unattended: false,
			processKind: "top-level",
			inputSummary: { path: "/tmp" },
			pathCandidates: ["/tmp"],
		});
		assert.ok(!result.flags.includes("external_mutation"));
	});
});

describe("pi-gate policy schema validation", () => {
	it("rejects non-boolean unattended values", () => {
		const error = validatePolicySchema(schema as never, {
			activeProfile: "worker",
			permission: { "*": "allow" },
			profiles: {
				worker: { unattended: "true", permission: { "*": "allow" } },
			},
		});

		assert.match(error ?? "", /unattended must be a boolean/);
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

	it("does not start configured gate auto on session start unless opted in", async () => {
		const cwd = makeWorkspace();
		let calls = 0;
		const server = http.createServer((_req, res) => {
			calls += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "fixture allow" }) } }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			setVar(cwd, "gate.auto.llama.endpoint", `http://127.0.0.1:${address.port}`);
			setGateAutoEnabled(cwd, true);

			process.env.GATE_PROFILE = "base";
			const { pi, ctx } = createHarness({ cwd, selectChoice: "Deny" });
			await pi.start(ctx);

			assert.equal(ctx.statuses.gate, "gate:base");
			const decision = await pi.tool("read", { path: "/etc/passwd" }, ctx);
			assert.equal(decision?.block, true);
			assert.equal(ctx.selectCalls, 1);
			assert.equal(calls, 0);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("auto-approves ask decisions through a configured local endpoint without session approvals", async () => {
		const cwd = makeWorkspace();
		let modelDecision = "allow";
		let modelContent: string | undefined;
		let calls = 0;
		const server = http.createServer((req, res) => {
			calls += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: modelContent ?? JSON.stringify({ decision: modelDecision, reason: "fixture" }) } }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			setVar(cwd, "gate.auto.llama.endpoint", `http://127.0.0.1:${address.port}`);
			setVar(cwd, "gate.auto.llama.warmup", false);

			process.env.GATE_PROFILE = "base";
			const { pi, ctx } = createHarness({ cwd, selectChoice: "Deny" });
			await pi.start(ctx);
			const gateCommand = pi.commands.get("gate");
			assert.ok(gateCommand);
			await gateCommand("auto on", ctx);
			assert.match(ctx.statuses.gate, /gate:base.*auto/);

			assert.equal(await pi.tool("read", { path: "/etc/passwd" }, ctx), undefined);
			assert.equal(ctx.selectCalls, 0);
			assert.equal(calls, 1);
			assert.ok(!ctx.statuses.gate.includes("+1"));

			const complex = await pi.tool("bash", { command: "cat script.sh | sh" }, ctx);
			assert.equal(complex?.block, true);
			assert.match(complex?.reason ?? "", /auto-approver blocked|opaque|complex|human review/i);
			assert.equal(ctx.selectCalls, 0);
			assert.equal(calls, 2);

			modelDecision = "deny";
			const denied = await pi.tool("read", { path: "/etc/hosts" }, ctx);
			assert.equal(denied?.block, true);
			assert.match(denied?.reason ?? "", /auto-approver blocked/i);
			assert.equal(ctx.selectCalls, 0);

			modelDecision = "escalate";
			ctx.selectChoice = "Deny";
			const escalated = await pi.tool("read", { path: "/etc/services" }, ctx);
			assert.equal(escalated?.block, true);
			assert.equal(ctx.selectCalls, 1);

			ctx.selectChoice = "Allow once";
			assert.equal(await pi.tool("read", { path: "/etc/protocols" }, ctx), undefined);
			assert.equal(ctx.selectCalls, 2);

			modelContent = "not json";
			ctx.selectChoice = "Deny";
			const malformed = await pi.tool("read", { path: "/etc/group" }, ctx);
			assert.equal(malformed?.block, true);
			assert.equal(ctx.selectCalls, 3);

			setVar(cwd, "gate.auto.enabled", false);
			modelContent = undefined;
			modelDecision = "allow";
			const callsBeforeDisableCheck = calls;
			const disabled = await pi.tool("read", { path: "/etc/shells" }, ctx);
			assert.equal(disabled?.block, true);
			assert.equal(calls, callsBeforeDisableCheck);
			assert.equal(ctx.selectCalls, 4);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("soft-blocks model-allowed external file mutations", async () => {
		const cwd = makeWorkspace();
		let calls = 0;
		const server = http.createServer((_req, res) => {
			calls += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "fixture allow" }) } }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			setVar(cwd, "gate.auto.llama.endpoint", `http://127.0.0.1:${address.port}`);
			setVar(cwd, "gate.auto.llama.warmup", false);

			process.env.GATE_PROFILE = "base";
			const { pi, ctx } = createHarness({ cwd, selectChoice: "Deny" });
			await pi.start(ctx);
			const gateCommand = pi.commands.get("gate");
			assert.ok(gateCommand);
			await gateCommand("auto on", ctx);

			const externalPath = path.join(os.tmpdir(), `pi-gate-external-${Date.now()}`);
			const decision = await pi.tool("edit", { path: externalPath }, ctx);
			assert.equal(decision?.block, true);
			assert.match(decision?.reason ?? "", /auto-approver blocked|external file mutation|human review/i);
			assert.equal(calls, 1);
			assert.equal(ctx.selectCalls, 0);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("downgrades risky model allows to human review", async () => {
		const cwd = makeWorkspace();
		let calls = 0;
		const server = http.createServer((_req, res) => {
			calls += 1;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: "allow", reason: "fixture allow" }) } }] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			setVar(cwd, "gate.auto.llama.endpoint", `http://127.0.0.1:${address.port}`);
			setVar(cwd, "gate.auto.llama.warmup", false);

			process.env.GATE_PROFILE = "planner";
			const { pi, ctx } = createHarness({ cwd, selectChoice: "Deny" });
			await pi.start(ctx);
			const gateCommand = pi.commands.get("gate");
			assert.ok(gateCommand);
			await gateCommand("auto on", ctx);

			const guarded = await pi.tool("bash", { command: "brew install some-new-tool" }, ctx);
			assert.equal(guarded?.block, true);
			assert.match(guarded?.reason ?? "", /denied|package manager|human review|bash ask/i);

			const network = await pi.tool("bash", { command: "curl https://example.com/data" }, ctx);
			assert.equal(network?.block, true);
			assert.match(network?.reason ?? "", /denied|network|human review|bash ask/i);

			const opaque = await pi.tool("bash", { command: "python -c 'open(\"src/x\",\"w\").write(\"x\")'" }, ctx);
			assert.equal(opaque?.block, true);
			assert.match(opaque?.reason ?? "", /denied|opaque|unclassified|human review|bash ask/i);

			const unclassified = await pi.tool("bash", { command: "git commit -am x" }, ctx);
			assert.equal(unclassified?.block, true);
			assert.match(unclassified?.reason ?? "", /denied|opaque|unclassified|human review|bash ask/i);

			const complex = await pi.tool("bash", { command: "echo ok; git commit -am x" }, ctx);
			assert.equal(complex?.block, true);
			assert.match(complex?.reason ?? "", /denied|opaque|unclassified|human review|bash ask/i);
			assert.equal(calls, 3);
			assert.equal(ctx.selectCalls, 3);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import promptVarsExtension from "../index.ts";

type LifecycleHandler = (event: Record<string, unknown>, ctx: FakeContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: FakeContext) => Promise<void> | void;

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

class FakePi {
	readonly lifecycle = new Map<string, LifecycleHandler[]>();
	readonly commands = new Map<string, CommandHandler>();
	readonly tools = new Map<string, ToolRegistration>();

	on(event: string, handler: LifecycleHandler): void {
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler);
		this.lifecycle.set(event, handlers);
	}

	registerCommand(name: string, config: { handler: CommandHandler }): void {
		this.commands.set(name, config.handler);
	}

	registerTool(tool: ToolRegistration): void {
		this.tools.set(tool.name, tool);
	}

	async emitLifecycle(event: string, payload: Record<string, unknown>, ctx: FakeContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.lifecycle.get(event) ?? []) {
			result = await handler(payload, ctx);
		}
		return result;
	}
}

class FakeContext {
	readonly hasUI = true;
	readonly cwd: string;
	readonly notifications: Array<{ message: string; level?: string }> = [];
	readonly sessionManager = {
		getBranch: (): unknown[] => [],
	};

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	ui = {
		notify: (message: string, level?: string): void => {
			this.notifications.push({ message, level });
		},
	};
}

const tempDirs: string[] = [];
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	const tempHome = makeTempCwd();
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "picode-vars-index-"));
	tempDirs.push(dir);
	return dir;
}

describe("z-prompt-vars extension entrypoint", () => {
	test("registers /vars and vars tool", () => {
		const pi = new FakePi();
		promptVarsExtension(pi as never);
		assert.ok(pi.commands.has("vars"));
		assert.ok(pi.tools.has("vars"));
	});

	test("session_start bootstraps files and before_agent_start interpolates stored vars", async () => {
		const pi = new FakePi();
		promptVarsExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());

		await pi.emitLifecycle("session_start", {}, ctx);
		const varsTool = pi.tools.get("vars");
		assert.ok(varsTool, "vars tool registered");
		const setResult = await varsTool.execute("tool", { action: "set", key: "project.name", value: "Picode" }, new AbortController().signal, undefined, ctx);
		assert.equal(setResult.isError, undefined);

		const result = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Project: ${project.name}" }, ctx) as { systemPrompt?: string };
		assert.equal(result.systemPrompt, "Project: Picode");
	});

	test("command and tool adapters share operation behavior", async () => {
		const pi = new FakePi();
		promptVarsExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		const command = pi.commands.get("vars");
		const tool = pi.tools.get("vars");
		assert.ok(command);
		assert.ok(tool);
		const executeTool = (params: Record<string, unknown>) => tool.execute("tool", params, new AbortController().signal, undefined, ctx);

		await command("bootstrap", ctx);
		assert.equal(ctx.notifications.at(-1)?.level, "info");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pi-location/);
		assert.equal((await executeTool({ action: "bootstrap" })).isError, undefined);

		await command('set parity.value {"ok":true}', ctx);
		assert.equal((await executeTool({ action: "get", key: "parity.value" })).content?.[0]?.text, '{"ok":true}');
		await command("parity.value", ctx);
		assert.equal(ctx.notifications.at(-1)?.message, 'parity.value={"ok":true}');

		assert.equal((await executeTool({ action: "set", key: "parity.value", value: { ok: false } })).isError, undefined);
		await command("parity.value", ctx);
		assert.equal(ctx.notifications.at(-1)?.message, 'parity.value={"ok":false}');

		await command("", ctx);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /parity\.value=/);
		assert.match((await executeTool({ action: "list" })).content?.[0]?.text ?? "", /parity\.value=/);

		await command("location global", ctx);
		assert.equal((await executeTool({ action: "location" })).details?.value, "global");
		assert.equal((await executeTool({ action: "location", value: "project" })).details?.value, "project");
		await command("location", ctx);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pi-location="project"/);

		await command("unset parity.value", ctx);
		const missing = await executeTool({ action: "get", key: "parity.value" });
		assert.equal(missing.isError, true);
		assert.match(missing.content?.[0]?.text ?? "", /Unknown var/);
	});

	test("command and tool adapters preserve validation errors", async () => {
		const pi = new FakePi();
		promptVarsExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		const command = pi.commands.get("vars");
		const tool = pi.tools.get("vars");
		assert.ok(command);
		assert.ok(tool);

		for (const [args, expected] of [
			["set missing-value", /Usage: \/vars set/],
			["unset", /Usage: \/vars unset/],
			["location elsewhere", /Usage: \/vars location/],
			["bootstrap extra", /Usage: \/vars bootstrap/],
		] as const) {
			await command(args, ctx);
			assert.equal(ctx.notifications.at(-1)?.level, "warning");
			assert.match(ctx.notifications.at(-1)?.message ?? "", expected);
		}

		await command('set plan.path "elsewhere.md"', ctx);
		assert.equal(ctx.notifications.at(-1)?.level, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Cannot set.*derived var/);

		for (const [params, expected] of [
			[{ action: "invalid" }, /action must be one of/],
			[{ action: "location", value: "elsewhere" }, /project.*global/],
			[{ action: "get" }, /key is required/],
			[{ action: "set", value: true }, /key is required/],
			[{ action: "set", key: "missing.value" }, /value is required/],
			[{ action: "unset" }, /key is required/],
			[{ action: "set", key: "plan.path", value: "elsewhere.md" }, /Cannot set.*derived var/],
		] as const) {
			const result = await tool.execute("tool", params, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(result.content?.[0]?.text ?? "", expected);
		}
	});
});

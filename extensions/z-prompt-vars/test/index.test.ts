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

	test("/vars command reports syntax errors", async () => {
		const pi = new FakePi();
		promptVarsExtension(pi as never);
		const ctx = new FakeContext(makeTempCwd());
		const command = pi.commands.get("vars");
		assert.ok(command, "/vars command registered");

		await command("set missing-value", ctx);
		assert.equal(ctx.notifications.at(-1)?.level, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /Usage: \/vars set/);
	});
});

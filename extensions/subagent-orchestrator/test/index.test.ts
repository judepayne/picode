import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import subagentOrchestratorExtension from "../index.ts";

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
	readonly handlers = new Map<string, unknown[]>();
	readonly emitted: Array<{ event: string; data: unknown }> = [];

	on(event: string, handler: unknown): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
	}
}

class FakePi {
	readonly events = new FakeEventBus();
	readonly tools = new Map<string, ToolRegistration>();
	readonly commands = new Map<string, unknown>();
	readonly messageRenderers = new Map<string, unknown>();
	readonly lifecycle = new Map<string, unknown[]>();

	registerTool(tool: ToolRegistration): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, config: unknown): void {
		this.commands.set(name, config);
	}

	registerMessageRenderer(type: string, renderer: unknown): void {
		this.messageRenderers.set(type, renderer);
	}

	on(event: string, handler: unknown): void {
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler);
		this.lifecycle.set(event, handlers);
	}

	getThinkingLevel(): string | undefined {
		return undefined;
	}
}

class FakeContext {
	readonly hasUI = false;
	readonly cwd: string;
	readonly sessionManager = {
		getBranch: (): unknown[] => [{
			type: "custom",
			customType: "agent-mode-state",
			data: { modeId: "builder", subagents: ["scout"] },
		}],
		getSessionId: (): string => "parent-session",
		getSessionFile: (): string => join(this.cwd, "parent.jsonl"),
	};

	constructor(cwd: string) {
		this.cwd = cwd;
	}
}

const tempDirs: string[] = [];
let originalCwd: string;

function makeTempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "picode-orchestrator-index-"));
	tempDirs.push(dir);
	return dir;
}

async function withTempProcessCwd<T>(fn: () => T | Promise<T>): Promise<T> {
	const cwd = makeTempCwd();
	originalCwd = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(originalCwd);
	}
}

afterEach(() => {
	if (originalCwd) process.chdir(originalCwd);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagent-orchestrator extension entrypoint", () => {
	test("registers delegate tools and renderers", async () => {
		await withTempProcessCwd(() => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			assert.ok(pi.tools.has("delegate_subagent"));
			assert.ok(pi.tools.has("delegate_subagent_status"));
			assert.ok(pi.messageRenderers.has("subagent-orchestrator-run"));
			assert.ok(pi.messageRenderers.has("subagent-orchestrator-continuation-message"));
			assert.ok(pi.events.handlers.has("subagent:mode:request.response"));
			assert.ok(pi.events.handlers.has("subagent:mode:run.complete"));
			assert.ok(pi.events.handlers.has("subagent:mode:child.started"));
			assert.ok(pi.lifecycle.has("input"));
			assert.ok(pi.lifecycle.has("session_start"));
			assert.ok(pi.lifecycle.has("turn_end"));
			assert.ok(pi.lifecycle.has("session_shutdown"));
		});
	});

	test("delegate_subagent rejects invalid input before launching work", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const tool = pi.tools.get("delegate_subagent");
			assert.ok(tool);
			const ctx = new FakeContext(process.cwd());

			const result = await tool.execute("tool", {}, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(result.content?.[0]?.text ?? "", /Provide exactly one of task, tasks, or chain/);
		});
	});

	test("delegate_subagent_status list works with no runs", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const tool = pi.tools.get("delegate_subagent_status");
			assert.ok(tool);
			const ctx = new FakeContext(process.cwd());

			const result = await tool.execute("tool", { action: "list" }, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, undefined);
			assert.match(result.content?.[0]?.text ?? "", /No subagent orchestrator runs found/);
		});
	});
});

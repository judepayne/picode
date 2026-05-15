import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	dispatch(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			(handler as (payload: unknown) => void)(data);
		}
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

	appendEntry(): void {
		// no-op
	}

	sendMessage(): void {
		// no-op
	}

	on(event: string, handler: unknown): void {
		const handlers = this.lifecycle.get(event) ?? [];
		handlers.push(handler);
		this.lifecycle.set(event, handlers);
	}

	getThinkingLevel(): string | undefined {
		return undefined;
	}

	getAllTools(): Array<{ name: string }> {
		return [];
	}

	getActiveTools(): string[] {
		return [];
	}
}

class FakeContext {
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly statuses = new Map<string, string | undefined>();
	readonly notifications: string[] = [];
	readonly ui = {
		theme: {
			bold: (text: string) => `**${text}**`,
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		},
		setStatus: (key: string, text: string | undefined): void => {
			this.statuses.set(key, text);
		},
		notify: (message: string): void => {
			this.notifications.push(message);
		},
		onTerminalInput: (): (() => void) => () => undefined,
		setEditorComponent: (): void => undefined,
	};
	isIdle(): boolean {
		return true;
	}

	hasPendingMessages(): boolean {
		return false;
	}

	readonly sessionManager = {
		getBranch: (): unknown[] => [{
			type: "custom",
			customType: "agent-mode-state",
			data: { modeId: "builder", subagents: ["scout"] },
		}],
		getSessionId: (): string => "parent-session",
		getSessionFile: (): string => join(this.cwd, "parent.jsonl"),
	};

	constructor(cwd: string, options: { hasUI?: boolean } = {}) {
		this.cwd = cwd;
		this.hasUI = options.hasUI ?? false;
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agent-mode-vars.json"), `${JSON.stringify({
			footer: {
				colors: {
					subagentStatus: {
						queued: "#f0c986",
						running: "#71e37d",
						complete: "#bababa",
						cancelled: "#874a4a",
						failed: "#FF4D4D",
					},
				},
			},
		}, null, 2)}\n`, "utf8");
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

	test("delegate_subagent_status uses log action names", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const tool = pi.tools.get("delegate_subagent_status");
			assert.ok(tool);
			const ctx = new FakeContext(process.cwd());

			const accepted = await tool.execute("tool", { action: "log_cursor" }, new AbortController().signal, undefined, ctx);
			assert.equal(accepted.isError, true);
			assert.match(accepted.content?.[0]?.text ?? "", /childSessionId is required for log_cursor/);

			const rejected = await tool.execute("tool", { action: "stream" }, new AbortController().signal, undefined, ctx);
			assert.equal(rejected.isError, true);
			assert.match(rejected.content?.[0]?.text ?? "", /log_cursor.*log_next/);
		});
	});

	test("direct user async launch marks the visible child running before child events arrive", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const inputHandler = pi.lifecycle.get("input")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<{ action: string }>) | undefined;
			const shutdownHandler = pi.lifecycle.get("session_shutdown")?.[0] as (() => Promise<void>) | undefined;
			assert.ok(inputHandler);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });

			const pending = inputHandler({ source: "interactive", text: "~scout write a haiku" }, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			assert.ok(request);
			const requestId = (request.data as { requestId?: string }).requestId;
			assert.ok(requestId);

			const childDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "child-sessions");
			const childFile = readdirSync(childDir).find((name) => name.endsWith(".json"));
			assert.ok(childFile);
			const child = JSON.parse(readFileSync(join(childDir, childFile), "utf8")) as { status?: string };
			assert.equal(child.status, "running");

			const runDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs");
			const runFile = readdirSync(runDir).find((name) => name.endsWith(".json"));
			assert.ok(runFile);
			const runRecord = JSON.parse(readFileSync(join(runDir, runFile), "utf8")) as { origin?: string; status?: string };
			assert.equal(runRecord.origin, "user");
			assert.equal(runRecord.status, "running");
			assert.equal(ctx.statuses.get("subagent-orchestrator"), "● root > user > \u001b[38;2;113;227;125mscout 1\u001b[39m");

			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				async: true,
				asyncId: "async-1",
				asyncDir: join(process.cwd(), "async-1"),
				result: { mode: "single", status: "running", results: [] },
			});
			const result = await pending;
			assert.equal(result.action, "handled");
			await shutdownHandler?.();
		});
	});

	test("async response starts an event tailer that ingests child events", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const inputHandler = pi.lifecycle.get("input")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<{ action: string }>) | undefined;
			const shutdownHandler = pi.lifecycle.get("session_shutdown")?.[0] as (() => Promise<void>) | undefined;
			assert.ok(inputHandler);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });

			const pending = inputHandler({ source: "interactive", text: "~scout inspect events" }, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			const requestId = (request?.data as { requestId?: string } | undefined)?.requestId;
			assert.ok(requestId);
			const asyncDir = join(process.cwd(), "async-1");
			mkdirSync(asyncDir, { recursive: true });
			writeFileSync(join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent:mode:child.progress", timestamp: 11, currentTool: "read", recentOutput: "x".repeat(70_000) })}\n`);
			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				async: true,
				asyncId: "async-1",
				asyncDir,
				result: { mode: "single", status: "running", results: [] },
			});
			assert.equal((await pending).action, "handled");

			const childDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "child-sessions");
			const childFile = readdirSync(childDir).find((name) => name.endsWith(".json"));
			assert.ok(childFile);
			const child = JSON.parse(readFileSync(join(childDir, childFile), "utf8"));
			assert.equal(child.status, "running");
			assert.equal(child.currentTool, "read");
			await shutdownHandler?.();
		});
	});

	test("late async event ingestion does not regress terminal child status", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const inputHandler = pi.lifecycle.get("input")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<{ action: string }>) | undefined;
			const sessionStartHandler = pi.lifecycle.get("session_start")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<void>) | undefined;
			assert.ok(inputHandler);
			assert.ok(sessionStartHandler);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });

			const pending = inputHandler({ source: "interactive", text: "~scout summarize one file" }, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			const requestId = (request?.data as { requestId?: string } | undefined)?.requestId;
			assert.ok(requestId);
			const asyncDir = join(process.cwd(), "async-1");
			mkdirSync(asyncDir, { recursive: true });
			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				async: true,
				asyncId: "async-1",
				asyncDir,
				result: { mode: "single", status: "running", results: [] },
			});
			assert.equal((await pending).action, "handled");

			writeFileSync(join(asyncDir, "result.json"), JSON.stringify({
				endedAt: 10,
				result: { status: "complete", results: [{ agent: "scout", status: "complete", finalText: "done" }] },
			}, null, 2));
			await sessionStartHandler({}, ctx);

			const childDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "child-sessions");
			const childFile = readdirSync(childDir).find((name) => name.endsWith(".json"));
			assert.ok(childFile);
			assert.equal(JSON.parse(readFileSync(join(childDir, childFile), "utf8")).status, "complete");

			writeFileSync(join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent:mode:child.progress", timestamp: 11, currentTool: "read" })}\n`);
			await sessionStartHandler({}, ctx);
			assert.equal(JSON.parse(readFileSync(join(childDir, childFile), "utf8")).status, "complete");
		});
	});
});

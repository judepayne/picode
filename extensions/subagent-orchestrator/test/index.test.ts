import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import agentAssetsExtension from "../../agent-assets/index.ts";
import { COLLECT_AGENT_ASSET_CARDS_EVENT } from "../../agent-assets/contract.ts";
import { asyncRunManifestPath } from "../../subagent-mode/paths.ts";
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

	on(event: string, handler: unknown): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.off(event, handler);
	}

	off(event: string, handler: unknown): void {
		const handlers = this.handlers.get(event) ?? [];
		const nextHandlers = handlers.filter((entry) => entry !== handler);
		if (nextHandlers.length > 0) this.handlers.set(event, nextHandlers);
		else this.handlers.delete(event);
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of this.handlers.get(event) ?? []) {
			(handler as (payload: unknown) => void)(data);
		}
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
	readonly allTools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>;

	constructor(allTools: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> = []) {
		this.allTools = allTools;
	}

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

	getAllTools(): Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> {
		return this.allTools;
	}

	getActiveTools(): string[] {
		return [];
	}
}

interface FakeContextOptions {
	hasUI?: boolean;
	branch?: unknown[];
}

class FakeContext {
	readonly hasUI: boolean;
	readonly cwd: string;
	readonly branch: unknown[];
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
		getBranch: (): unknown[] => this.branch,
		getSessionId: (): string => "parent-session",
		getSessionFile: (): string => join(this.cwd, "parent.jsonl"),
	};

	constructor(cwd: string, options: FakeContextOptions = {}) {
		this.cwd = cwd;
		this.hasUI = options.hasUI ?? false;
		this.branch = options.branch ?? [{
			type: "custom",
			customType: "agent-mode-state",
			data: { modeId: "builder", subagents: ["scout"] },
		}];
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
let savedDevStreamToFile: string | undefined;

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

beforeEach(() => {
	savedDevStreamToFile = process.env.PICODE_ENABLE_DEV_STREAM_TO_FILE;
	delete process.env.PICODE_ENABLE_DEV_STREAM_TO_FILE;
});

afterEach(() => {
	if (originalCwd) process.chdir(originalCwd);
	if (savedDevStreamToFile === undefined) delete process.env.PICODE_ENABLE_DEV_STREAM_TO_FILE;
	else process.env.PICODE_ENABLE_DEV_STREAM_TO_FILE = savedDevStreamToFile;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagent-orchestrator extension entrypoint", () => {
	test("registers delegate tools and renderers", async () => {
		await withTempProcessCwd(() => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			assert.ok(pi.tools.has("delegate_subagent"));
			assert.ok(pi.tools.has("delegate_subagent_status"));
			assert.equal(pi.tools.has("dev_subagent_stream_to_file"), false);
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

	test("does not accumulate subagent event handlers across re-registration", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			subagentOrchestratorExtension(pi as never);
			assert.equal(pi.events.handlers.get("subagent:mode:child.started")?.length, 1);
			assert.equal(pi.events.handlers.get("subagent:mode:child.text.delta")?.length, 1);
			assert.equal(pi.events.handlers.get("subagent:mode:request.response")?.length, 1);

			for (const handler of pi.lifecycle.get("session_shutdown") ?? []) {
				await (handler as () => void | Promise<void>)();
			}
			assert.equal(pi.events.handlers.has("subagent:mode:child.started"), false);
			assert.equal(pi.events.handlers.has("subagent:mode:child.text.delta"), false);
			assert.equal(pi.events.handlers.has("subagent:mode:request.response"), false);
		});
	});

	test("settles in-flight delegated calls when a replacement runtime disposes the old registration", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			agentAssetsExtension(pi as never);
			subagentOrchestratorExtension(pi as never);
			const oldTool = pi.tools.get("delegate_subagent");
			assert.ok(oldTool);
			const ctx = new FakeContext(process.cwd());
			const pending = oldTool.execute("tool", { agent: "scout", task: "wait forever" }, new AbortController().signal, undefined, ctx);
			assert.ok(pi.events.emitted.some((entry) => entry.event === "subagent:mode:request"));
			subagentOrchestratorExtension(pi as never);
			const result = await pending;
			assert.equal(result.isError, true);
			assert.match(result.content?.[0]?.text ?? "", /runtime was replaced/i);
		});
	});

	test("registers the dev stream file tool only behind its explicit flag", async () => {
		await withTempProcessCwd(() => {
			process.env.PICODE_ENABLE_DEV_STREAM_TO_FILE = "1";
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			assert.ok(pi.tools.has("dev_subagent_stream_to_file"));
		});
	});

	test("delegate_subagent works in child subagent context without agent-mode state", async () => {
		await withTempProcessCwd(async () => {
			const previousEnv = {
				depth: process.env.PI_SUBAGENT_DEPTH,
				maxDepth: process.env.PI_SUBAGENT_MAX_DEPTH,
				topRunId: process.env.PI_SUBAGENT_TOP_RUN_ID,
				parentChildId: process.env.PI_SUBAGENT_PARENT_CHILD_ID,
				gateProfile: process.env.GATE_PROFILE,
			};
			try {
				process.env.PI_SUBAGENT_DEPTH = "1";
				process.env.PI_SUBAGENT_MAX_DEPTH = "2";
				process.env.PI_SUBAGENT_TOP_RUN_ID = "top-run";
				process.env.PI_SUBAGENT_PARENT_CHILD_ID = "parent-child";
				process.env.GATE_PROFILE = "scout";

				const pi = new FakePi();
				agentAssetsExtension(pi as never);
				subagentOrchestratorExtension(pi as never);
				const tool = pi.tools.get("delegate_subagent");
				assert.ok(tool);
				const ctx = new FakeContext(process.cwd(), { branch: [] });

				const pending = tool.execute("tool", { agent: "scout", task: "say nested-ok" }, new AbortController().signal, undefined, ctx);
				const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
				assert.ok(request);
				const requestId = (request.data as { requestId?: string }).requestId;
				assert.ok(requestId);
				pi.events.dispatch("subagent:mode:request.response", {
					requestId,
					ok: true,
					result: {
						mode: "single",
						status: "complete",
						results: [{ agent: "scout", status: "complete", finalText: "nested-ok" }],
					},
				});

				const result = await pending;
				assert.equal(result.isError, false);
				assert.match(result.content?.[0]?.text ?? "", /nested-ok/);

				const runDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs");
				const runFile = readdirSync(runDir).find((name) => name.endsWith(".json"));
				assert.ok(runFile);
				const runRecord = JSON.parse(readFileSync(join(runDir, runFile), "utf8")) as { ownerModeId?: string; depth?: number };
				assert.equal(runRecord.ownerModeId, "scout");
				assert.equal(runRecord.depth, 1);
			} finally {
				if (previousEnv.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
				else process.env.PI_SUBAGENT_DEPTH = previousEnv.depth;
				if (previousEnv.maxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
				else process.env.PI_SUBAGENT_MAX_DEPTH = previousEnv.maxDepth;
				if (previousEnv.topRunId === undefined) delete process.env.PI_SUBAGENT_TOP_RUN_ID;
				else process.env.PI_SUBAGENT_TOP_RUN_ID = previousEnv.topRunId;
				if (previousEnv.parentChildId === undefined) delete process.env.PI_SUBAGENT_PARENT_CHILD_ID;
				else process.env.PI_SUBAGENT_PARENT_CHILD_ID = previousEnv.parentChildId;
				if (previousEnv.gateProfile === undefined) delete process.env.GATE_PROFILE;
				else process.env.GATE_PROFILE = previousEnv.gateProfile;
			}
		});
	});

	test("does not warn when child tool provenance uses a symlinked package path", async () => {
		await withTempProcessCwd(async () => {
			const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
			const linkedExtensionDir = join(process.cwd(), "linked-subagent-orchestrator");
			symlinkSync(extensionDir, linkedExtensionDir, "dir");
			const builtinTools = ["read", "grep", "find", "ls", "bash"].map((name) => ({
				name,
				sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
			}));
			const pi = new FakePi([
				...builtinTools,
				{ name: "delegate_subagent", sourceInfo: { source: "local", path: join(linkedExtensionDir, "index.ts") } },
			]);
			agentAssetsExtension(pi as never);
			subagentOrchestratorExtension(pi as never);
			const tool = pi.tools.get("delegate_subagent");
			assert.ok(tool);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });

			const pending = tool.execute("tool", { agent: "scout", task: "noop" }, new AbortController().signal, undefined, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			assert.ok(request);
			const requestId = (request.data as { requestId?: string }).requestId;
			assert.ok(requestId);
			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				result: {
					mode: "single",
					status: "complete",
					results: [{ agent: "scout", status: "complete", finalText: "ok" }],
				},
			});
			await pending;

			assert.equal(ctx.notifications.some((message) => message.includes("unknown tools") && message.includes("delegate_subagent")), false);
		});
	});

	test("nested delegated runs inherit the root owner for footer visibility", async () => {
		await withTempProcessCwd(async () => {
			const previousEnv = {
				depth: process.env.PI_SUBAGENT_DEPTH,
				maxDepth: process.env.PI_SUBAGENT_MAX_DEPTH,
				topRunId: process.env.PI_SUBAGENT_TOP_RUN_ID,
				parentChildId: process.env.PI_SUBAGENT_PARENT_CHILD_ID,
				gateProfile: process.env.GATE_PROFILE,
			};
			try {
				const pi = new FakePi();
				agentAssetsExtension(pi as never);
				subagentOrchestratorExtension(pi as never);
				const tool = pi.tools.get("delegate_subagent");
				const statusTool = pi.tools.get("delegate_subagent_status");
				assert.ok(tool);
				assert.ok(statusTool);
				const rootCtx = new FakeContext(process.cwd(), {
					branch: [{ type: "custom", customType: "agent-mode-state", data: { modeId: "planner" } }],
				});

				const rootPending = tool.execute("tool", { agent: "scout", task: "parent" }, new AbortController().signal, undefined, rootCtx);
				const rootRequest = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
				assert.ok(rootRequest);
				const rootRequestData = rootRequest.data as { requestId?: string; spec?: { nodeLog?: { nodeLogsDir?: string; runId?: string; rootRunId?: string }; childIds?: string[] } };
				const rootRequestId = rootRequestData.requestId;
				assert.ok(rootRequestId);
				assert.equal(rootRequestData.spec?.nodeLog?.runId, rootRequestId);
				assert.equal(rootRequestData.spec?.nodeLog?.rootRunId, rootRequestId);
				assert.ok(rootRequestData.spec?.nodeLog?.nodeLogsDir?.endsWith(".pi/state/subagent-orchestrator/node-logs"));
				assert.equal(rootRequestData.spec?.childIds?.length, 1);
				pi.events.dispatch("subagent:mode:request.response", {
					requestId: rootRequestId,
					ok: true,
					result: {
						mode: "single",
						status: "complete",
						results: [{ agent: "scout", status: "complete", finalText: "parent-done" }],
					},
				});
				assert.equal((await rootPending).isError, false);

				const childDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "child-sessions");
				const parentChildFile = readdirSync(childDir).find((name) => name.endsWith(".json"));
				assert.ok(parentChildFile);
				const parentChild = JSON.parse(readFileSync(join(childDir, parentChildFile), "utf8")) as { childSessionId: string; runId: string; ownerModeId?: string };
				assert.equal(parentChild.ownerModeId, "planner");

				process.env.PI_SUBAGENT_DEPTH = "1";
				process.env.PI_SUBAGENT_MAX_DEPTH = "2";
				process.env.PI_SUBAGENT_TOP_RUN_ID = "subagent-mode-execution-root";
				process.env.PI_SUBAGENT_PARENT_CHILD_ID = parentChild.childSessionId;
				process.env.GATE_PROFILE = "scout";

				const nestedCtx = new FakeContext(process.cwd(), { branch: [] });
				const nestedPending = tool.execute("tool", { agent: "worker", task: "nested" }, new AbortController().signal, undefined, nestedCtx);
				const nestedRequest = pi.events.emitted.filter((entry) => entry.event === "subagent:mode:request").at(-1);
				assert.ok(nestedRequest);
				const nestedRequestData = nestedRequest.data as { requestId?: string; spec?: { nodeLog?: { nodeLogsDir?: string; runId?: string; rootRunId?: string }; childIds?: string[] } };
				const nestedRequestId = nestedRequestData.requestId;
				assert.ok(nestedRequestId);
				assert.equal(nestedRequestData.spec?.nodeLog?.runId, nestedRequestId);
				assert.equal(nestedRequestData.spec?.nodeLog?.rootRunId, parentChild.runId);
				assert.equal(nestedRequestData.spec?.childIds?.length, 1);
				pi.events.dispatch("subagent:mode:request.response", {
					requestId: nestedRequestId,
					ok: true,
					result: {
						mode: "single",
						status: "complete",
						results: [{ agent: "worker", status: "complete", finalText: "nested-done" }],
					},
				});
				assert.equal((await nestedPending).isError, false);

				const runDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs");
				const runs = readdirSync(runDir)
					.filter((name) => name.endsWith(".json"))
					.map((name) => JSON.parse(readFileSync(join(runDir, name), "utf8")) as { orchestratorRunId: string; ownerModeId?: string; rootRunId?: string; parentChildSessionId?: string; agent?: string });
				const nestedRun = runs.find((run) => run.agent === "worker");
				assert.ok(nestedRun);
				assert.equal(nestedRun.ownerModeId, "planner");
				assert.equal(nestedRun.rootRunId, parentChild.runId);
				assert.equal(nestedRun.parentChildSessionId, parentChild.childSessionId);

				const statusResult = await statusTool.execute("tool", { action: "get", runId: nestedRun.orchestratorRunId }, new AbortController().signal, undefined, nestedCtx);
				assert.equal(statusResult.isError, undefined);

				const children = readdirSync(childDir)
					.filter((name) => name.endsWith(".json"))
					.map((name) => JSON.parse(readFileSync(join(childDir, name), "utf8")) as { agent?: string; ownerModeId?: string; rootRunId?: string; parentChildSessionId?: string });
				const nestedChild = children.find((child) => child.agent === "worker");
				assert.ok(nestedChild);
				assert.equal(nestedChild.ownerModeId, "planner");
				assert.equal(nestedChild.rootRunId, parentChild.runId);
				assert.equal(nestedChild.parentChildSessionId, parentChild.childSessionId);
				assert.equal(pi.events.emitted.filter((entry) => entry.event === COLLECT_AGENT_ASSET_CARDS_EVENT).length, 1);
			} finally {
				if (previousEnv.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
				else process.env.PI_SUBAGENT_DEPTH = previousEnv.depth;
				if (previousEnv.maxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
				else process.env.PI_SUBAGENT_MAX_DEPTH = previousEnv.maxDepth;
				if (previousEnv.topRunId === undefined) delete process.env.PI_SUBAGENT_TOP_RUN_ID;
				else process.env.PI_SUBAGENT_TOP_RUN_ID = previousEnv.topRunId;
				if (previousEnv.parentChildId === undefined) delete process.env.PI_SUBAGENT_PARENT_CHILD_ID;
				else process.env.PI_SUBAGENT_PARENT_CHILD_ID = previousEnv.parentChildId;
				if (previousEnv.gateProfile === undefined) delete process.env.GATE_PROFILE;
				else process.env.GATE_PROFILE = previousEnv.gateProfile;
			}
		});
	});

	test("delegate_subagent rejects current mode banned subagents", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
		agentAssetsExtension(pi as never);
		subagentOrchestratorExtension(pi as never);
		const tool = pi.tools.get("delegate_subagent");
		assert.ok(tool);
		const ctx = new FakeContext(process.cwd(), {
			branch: [{ type: "custom", customType: "agent-mode-state", data: { modeId: "builder", bannedSubagents: ["scout"] } }],
		});

		const result = await tool.execute("tool", { agent: "scout", task: "blocked" }, new AbortController().signal, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content?.[0]?.text ?? "", /banned from delegating/);
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
			for (const handler of pi.lifecycle.get("session_start") ?? []) {
				await (handler as (event: unknown, ctx: FakeContext) => void | Promise<void>)({}, ctx);
			}

			const result = await tool.execute("tool", { action: "list" }, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, undefined);
			assert.match(result.content?.[0]?.text ?? "", /No subagent orchestrator runs found/);
			assert.match(result.content?.[0]?.text ?? "", /Retention: 30d \/ 100/);
			assert.equal(typeof result.details?.retention, "object");
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


	test("pre-aborted delegation is finalized without launching a child request", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const delegateTool = pi.tools.get("delegate_subagent");
			assert.ok(delegateTool);
			const ctx = new FakeContext(process.cwd());
			const controller = new AbortController();
			controller.abort();

			const result = await delegateTool.execute("tool", { agent: "scout", task: "cancelled", async: true }, controller.signal, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(result.content?.[0]?.text ?? "", /cancelled/);
			assert.equal(pi.events.emitted.some((entry) => entry.event === "subagent:mode:request"), false);

			const runDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs");
			const runFile = readdirSync(runDir).find((name) => name.endsWith(".json"));
			assert.ok(runFile);
			assert.equal(JSON.parse(readFileSync(join(runDir, runFile), "utf8")).status, "cancelled");
		});
	});

	test("delegate_subagent_status cancel does not mark already-finished async runs cancelled", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const delegateTool = pi.tools.get("delegate_subagent");
			const statusTool = pi.tools.get("delegate_subagent_status");
			assert.ok(delegateTool);
			assert.ok(statusTool);
			const ctx = new FakeContext(process.cwd());

			const pending = delegateTool.execute("tool", { agent: "scout", task: "async", async: true }, new AbortController().signal, undefined, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			assert.ok(request);
			const requestId = (request.data as { requestId?: string }).requestId;
			assert.ok(requestId);
			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				async: true,
				asyncId: "async-finished",
				asyncDir: join(process.cwd(), "async-finished"),
				result: { mode: "single", status: "running", results: [] },
			});
			assert.notEqual((await pending).isError, true);

			mkdirSync(join(asyncRunManifestPath("async-finished"), ".."), { recursive: true });
			writeFileSync(asyncRunManifestPath("async-finished"), JSON.stringify({
				schemaVersion: 1,
				runId: "async-finished",
				status: "complete",
				pid: process.pid,
				startedAt: Date.now(),
				endedAt: Date.now(),
			}, null, 2));

			const result = await statusTool.execute("tool", { action: "cancel", runId: requestId }, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, undefined);
			assert.match(result.content?.[0]?.text ?? "", /already complete/);

			const runDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs");
			const runFile = readdirSync(runDir).find((name) => name === `${requestId}.json`);
			assert.ok(runFile);
			const runRecord = JSON.parse(readFileSync(join(runDir, runFile), "utf8")) as { status?: string };
			assert.notEqual(runRecord.status, "cancelled");
		});
	});

	test("cancellation stays terminal and releases direct-user continuation", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const inputHandler = pi.lifecycle.get("input")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<{ action: string }>) | undefined;
			const statusTool = pi.tools.get("delegate_subagent_status");
			assert.ok(inputHandler);
			assert.ok(statusTool);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });

			const firstPending = inputHandler({ source: "interactive", text: "~scout --continue first" }, ctx);
			const firstRequest = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			const firstRequestId = (firstRequest?.data as { requestId?: string } | undefined)?.requestId;
			assert.ok(firstRequestId);
			const asyncId = "async-cancelled";
			const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "async-runner-main.ts", asyncId], { stdio: "ignore" });
			try {
				pi.events.dispatch("subagent:mode:request.response", {
					requestId: firstRequestId,
					ok: true,
					async: true,
					asyncId,
					asyncDir: join(process.cwd(), asyncId),
					pid: dummy.pid,
					result: { mode: "single", status: "running", results: [] },
				});
				assert.equal((await firstPending).action, "handled");

				mkdirSync(dirname(asyncRunManifestPath(asyncId)), { recursive: true });
				writeFileSync(asyncRunManifestPath(asyncId), JSON.stringify({
					schemaVersion: 1,
					runId: asyncId,
					status: "running",
					pid: dummy.pid,
					startedAt: Date.now(),
				}, null, 2));

				const cancelled = await statusTool.execute("tool", { action: "cancel", runId: firstRequestId }, new AbortController().signal, undefined, ctx);
				assert.equal(cancelled.isError, undefined);

				pi.events.dispatch("subagent:mode:child.complete", {
					runId: asyncId,
					agent: "scout",
					result: { status: "complete", finalText: "late child result" },
				});
				pi.events.dispatch("subagent:mode:run.complete", {
					async: true,
					runId: asyncId,
					result: { runId: asyncId, mode: "single", status: "complete", results: [{ childId: "late", agent: "scout", status: "complete", finalText: "late run result" }] },
				});

				const runPath = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs", `${firstRequestId}.json`);
				const run = JSON.parse(readFileSync(runPath, "utf8")) as { status?: string };
				assert.equal(run.status, "cancelled");
				const childDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "child-sessions");
				const childFile = readdirSync(childDir).find((name) => name.endsWith(".json"));
				assert.ok(childFile);
				assert.equal(JSON.parse(readFileSync(join(childDir, childFile), "utf8")).status, "cancelled");

				const requestCount = pi.events.emitted.filter((entry) => entry.event === "subagent:mode:request").length;
				const secondPending = inputHandler({ source: "interactive", text: "~scout --continue second" }, ctx);
				const requests = pi.events.emitted.filter((entry) => entry.event === "subagent:mode:request");
				assert.equal(requests.length, requestCount + 1);
				const secondRequestId = (requests.at(-1)?.data as { requestId?: string } | undefined)?.requestId;
				assert.ok(secondRequestId);
				pi.events.dispatch("subagent:mode:request.response", {
					requestId: secondRequestId,
					ok: true,
					async: true,
					asyncId: "async-second",
					asyncDir: join(process.cwd(), "async-second"),
					result: { mode: "single", status: "running", results: [] },
				});
				assert.equal((await secondPending).action, "handled");
			} finally {
				if (dummy.exitCode === null && dummy.signalCode === null) dummy.kill("SIGKILL");
			}
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

	test("reconciles a completion artifact that exists before async metadata is persisted", async () => {
		await withTempProcessCwd(async () => {
			const pi = new FakePi();
			subagentOrchestratorExtension(pi as never);
			const inputHandler = pi.lifecycle.get("input")?.[0] as ((event: Record<string, unknown>, ctx: FakeContext) => Promise<{ action: string }>) | undefined;
			const shutdownHandler = pi.lifecycle.get("session_shutdown")?.[0] as (() => Promise<void>) | undefined;
			assert.ok(inputHandler);
			const ctx = new FakeContext(process.cwd(), { hasUI: true });
			const pending = inputHandler({ source: "interactive", text: "~scout finish immediately" }, ctx);
			const request = pi.events.emitted.find((entry) => entry.event === "subagent:mode:request");
			const requestId = (request?.data as { requestId?: string } | undefined)?.requestId;
			assert.ok(requestId);
			const asyncDir = join(process.cwd(), "async-fast");
			mkdirSync(asyncDir, { recursive: true });
			writeFileSync(join(asyncDir, "result.json"), JSON.stringify({
				endedAt: 10,
				result: { status: "complete", results: [{ agent: "scout", status: "complete", finalText: "done" }] },
			}));
			pi.events.dispatch("subagent:mode:request.response", {
				requestId,
				ok: true,
				async: true,
				asyncId: "async-fast",
				asyncDir,
				result: { mode: "single", status: "running", results: [] },
			});
			assert.equal((await pending).action, "handled");
			const runFile = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "runs", `${requestId}.json`);
			assert.equal(JSON.parse(readFileSync(runFile, "utf8")).status, "complete");
			const handbackDir = join(process.cwd(), ".pi", "state", "subagent-orchestrator", "handbacks");
			assert.equal(readdirSync(handbackDir).filter((name) => name.endsWith(".json")).length, 1);
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

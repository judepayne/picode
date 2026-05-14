import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
} from "../../subagent-mode/types.ts";
import { createStateStore } from "../state.ts";
import { createJsonlFileSubagentStreamHandler } from "../stream-handlers.ts";
import { createSubagentStreamService, emitSubagentStreamRecord, EVENT_SUBAGENT_TASK, type SubagentStreamEvent } from "../stream.ts";
import type { OrchestratorChildSessionRecord } from "../types.ts";

class FakeEventBus {
	readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

class FakePi {
	readonly events = new FakeEventBus();
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempState() {
	const dir = mkdtempSync(join(tmpdir(), "picode-stream-test-"));
	tempDirs.push(dir);
	const state = createStateStore(dir);
	state.ensureReady();
	return state;
}

function childRecord(overrides: Partial<OrchestratorChildSessionRecord> = {}): OrchestratorChildSessionRecord {
	return {
		childSessionId: "child-1",
		runId: "run-1",
		rootRunId: "root-1",
		ownerModeId: "builder",
		parentSessionId: "parent-1",
		requestShape: "single",
		async: false,
		context: "fresh",
		agent: "scout",
		childIndex: 0,
		childKey: "0",
		status: "running",
		taskSummary: "inspect",
		createdAt: 10,
		updatedAt: 10,
		...overrides,
	};
}

async function flushHandlers(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("subagent stream service", () => {
	test("replays existing sanitized records and follows future records", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord());
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 11,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "hello" },
		});
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 12,
			eventType: EVENT_CHILD_TEXT_FINAL,
			event: { type: EVENT_CHILD_TEXT_FINAL, agent: "scout", text: "hello world" },
		});

		const events: SubagentStreamEvent[] = [];
		const close = createSubagentStreamService(pi as never, state).open(child.childSessionId, (event) => events.push(event));
		await flushHandlers();
		assert.equal(events.length, 2);
		assert.equal(events[0]?.replay, true);
		assert.deepEqual(events[1]?.event, { type: EVENT_CHILD_TEXT_FINAL, textElided: true, charCount: 11 });

		const live = state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 13,
			eventType: EVENT_CHILD_TOOL_END,
			event: { type: EVENT_CHILD_TOOL_END, agent: "scout", toolName: "read", toolCallId: "tool-1", ok: true, resultSummary: "result" },
		});
		emitSubagentStreamRecord(pi as never, live, child);
		await flushHandlers();
		assert.equal(events.length, 3);
		assert.equal(events[2]?.replay, false);
		assert.deepEqual(events[2]?.event, { type: EVENT_CHILD_TOOL_END, toolName: "read", toolCallId: "tool-1", ok: true, resultElided: true, resultPreview: "result", resultSummary: "string" });

		close();
		const afterClose = state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 14,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "ignored" },
		});
		emitSubagentStreamRecord(pi as never, afterClose, child);
		assert.equal(events.length, 3);
	});

	test("replays exclusively after a stored cursor", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord());
		const first = state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 11,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "first" },
		});
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 12,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "second" },
		});

		const events: SubagentStreamEvent[] = [];
		createSubagentStreamService(pi as never, state).open(child.childSessionId, (event) => events.push(event), { replay: { afterCursor: first.cursor } });
		await flushHandlers();
		assert.equal(events.length, 1);
		assert.equal(events[0]?.event.delta, "second");
	});

	test("serializes async handler calls in cursor order", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord());
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 11,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "first" },
		});
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 12,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "second" },
		});

		const delivered: string[] = [];
		createSubagentStreamService(pi as never, state).open(child.childSessionId, async (event) => {
			if (event.event.delta === "first") await new Promise((resolve) => setTimeout(resolve, 10));
			delivered.push(String(event.event.delta));
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(delivered, ["first", "second"]);
	});

	test("provides a standard JSONL file handler", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord());
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 11,
			eventType: EVENT_CHILD_TEXT_DELTA,
			event: { type: EVENT_CHILD_TEXT_DELTA, agent: "scout", delta: "logged" },
		});
		const filePath = join(mkdtempSync(join(tmpdir(), "picode-stream-file-")), "stream.jsonl");
		tempDirs.push(filePath.replace(/\/stream\.jsonl$/, ""));

		createSubagentStreamService(pi as never, state).open(child.childSessionId, createJsonlFileSubagentStreamHandler(filePath));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(existsSync(filePath), true);
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]!).event.delta, "logged");
	});

	test("replays delegated task events", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord({ taskSummary: "Inspect stream code" }));
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 10,
			eventType: EVENT_SUBAGENT_TASK,
			event: { type: EVENT_SUBAGENT_TASK, agent: "scout", task: "Inspect stream code" },
		});

		const events: SubagentStreamEvent[] = [];
		createSubagentStreamService(pi as never, state).open(child.childSessionId, (event) => events.push(event));
		await flushHandlers();
		assert.equal(events.length, 1);
		assert.deepEqual(events[0]?.event, { type: EVENT_SUBAGENT_TASK, agent: "scout", task: "Inspect stream code" });
	});

	test("elides tool args and hides thinking by default", async () => {
		const state = tempState();
		const pi = new FakePi();
		const child = state.createChildSession(childRecord());
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 11,
			eventType: EVENT_CHILD_THINKING_END,
			event: { type: EVENT_CHILD_THINKING_END, agent: "scout", summary: "private reasoning" },
		});
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 12,
			eventType: EVENT_CHILD_TOOL_START,
			event: { type: EVENT_CHILD_TOOL_START, agent: "scout", toolName: "write", toolCallId: "tool-1", args: { path: "x", content: "large" } },
		});
		state.appendNodeLogRecord(child.childSessionId, {
			runId: child.runId,
			rootRunId: child.rootRunId,
			timestamp: 13,
			eventType: "subagent:mode:child.progress",
			event: { type: "subagent:mode:child.progress", agent: "scout", toolCount: 1, recentOutput: '{"content":[{"text":"secret output"}]}' },
		});

		const defaultEvents: SubagentStreamEvent[] = [];
		createSubagentStreamService(pi as never, state).open(child.childSessionId, (event) => defaultEvents.push(event));
		await flushHandlers();
		assert.equal(defaultEvents.length, 2);
		assert.deepEqual(defaultEvents[0]?.event, {
			type: EVENT_CHILD_TOOL_START,
			toolName: "write",
			toolCallId: "tool-1",
			argsElided: true,
			command: 'write {"path":"x","contentElided":true}',
			argsSummary: "{path:string,content:string}",
		});
		assert.deepEqual(defaultEvents[1]?.event, {
			type: "subagent:mode:child.progress",
			toolCount: 1,
			recentOutputElided: true,
			recentOutputSummary: "{content:array}",
		});

		const thinkingEvents: SubagentStreamEvent[] = [];
		createSubagentStreamService(pi as never, state).open(child.childSessionId, (event) => thinkingEvents.push(event), { includeThinking: true });
		await flushHandlers();
		assert.equal(thinkingEvents.length, 3);
		assert.deepEqual(thinkingEvents[0]?.event, { type: EVENT_CHILD_THINKING_END, summary: "private reasoning" });
	});
});

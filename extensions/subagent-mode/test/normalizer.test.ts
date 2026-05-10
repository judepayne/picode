import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createNormalizerState,
	normalizeRawEvent,
	parseRawLine,
	type NormalizerIdentity,
} from "../normalizer.ts";
import {
	EVENT_CHILD_PROGRESS,
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_TEXT_FINAL,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	EVENT_CHILD_TOOL_END,
	EVENT_CHILD_TOOL_START,
	type ChildEvent,
} from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "raw-pi-json");

function identity(agent = "scout"): NormalizerIdentity {
	return {
		runId: "test-run",
		topLevelRunId: "test-run",
		childId: "test-child",
		agent,
		depth: 0,
	};
}

function runFixture(fixtureName: string, id: NormalizerIdentity = identity()): {
	events: ChildEvent[];
	state: ReturnType<typeof createNormalizerState>;
} {
	const raw = fs.readFileSync(path.join(fixturesDir, fixtureName), "utf-8");
	const state = createNormalizerState();
	const events: ChildEvent[] = [];
	for (const line of raw.split("\n")) {
		const evt = parseRawLine(line);
		if (!evt) continue;
		events.push(...normalizeRawEvent(evt, id, state));
	}
	return { events, state };
}

describe("normalizer: simple-text fixture", () => {
	test("emits the expected event sequence for a no-tool run", () => {
		const { events } = runFixture("simple-text.jsonl");
		const types = events.map((e) => e.type);

		// Event order is deterministic:
		// thinking_start → thinking_end → text.delta×N → text.final → progress (turn_end)
		assert.deepStrictEqual(types, [
			EVENT_CHILD_THINKING_START,
			EVENT_CHILD_THINKING_END,
			EVENT_CHILD_TEXT_DELTA,
			EVENT_CHILD_TEXT_DELTA,
			EVENT_CHILD_TEXT_FINAL,
			EVENT_CHILD_PROGRESS,
		]);
	});

	test("text_delta events carry the streamed delta", () => {
		const { events } = runFixture("simple-text.jsonl");
		const deltas = events
			.filter((e) => e.type === EVENT_CHILD_TEXT_DELTA)
			.map((e) => (e as { delta: string }).delta);
		assert.deepStrictEqual(deltas, ["Hello", " world"]);
	});

	test("text_final carries the fully-assembled assistant answer", () => {
		const { events } = runFixture("simple-text.jsonl");
		const final = events.find((e) => e.type === EVENT_CHILD_TEXT_FINAL);
		assert.ok(final);
		assert.strictEqual((final as { text: string }).text, "Hello world");
	});

	test("state captures usage from message_end", () => {
		const { state } = runFixture("simple-text.jsonl");
		// Input token count is model-specific; assert structural correctness:
		// the aggregated totals must match the sum of per-turn values.
		assert.ok(state.usage.input > 0, "input tokens should be aggregated");
		assert.ok(state.usage.output > 0, "output tokens should be aggregated");
		assert.strictEqual(state.usage.total, state.usage.input + state.usage.output);
		assert.strictEqual(state.turnCount, 1);
		assert.ok(typeof state.model === "string" && state.model.length > 0);
	});

	test("lastTextFinal is the canonical final-answer candidate", () => {
		const { state } = runFixture("simple-text.jsonl");
		assert.strictEqual(state.lastTextFinal, "Hello world");
	});

	test("every emitted event carries runner-stamped identity fields", () => {
		const id = identity("scout");
		const { events } = runFixture("simple-text.jsonl", id);
		for (const e of events) {
			assert.strictEqual(e.runId, id.runId, `missing runId on ${e.type}`);
			assert.strictEqual(e.topLevelRunId, id.topLevelRunId);
			assert.strictEqual(e.childId, id.childId);
			assert.strictEqual(e.agent, id.agent);
			assert.strictEqual(e.depth, 0);
			assert.ok(typeof e.timestamp === "number" && e.timestamp > 0);
		}
	});
});

describe("normalizer: bash-tool fixture", () => {
	test("emits tool.start and tool.end bracketing the tool invocation", () => {
		const { events } = runFixture("bash-tool.jsonl");
		const types = events.map((e) => e.type);
		const startIdx = types.indexOf(EVENT_CHILD_TOOL_START);
		const endIdx = types.indexOf(EVENT_CHILD_TOOL_END);
		assert.ok(startIdx !== -1, "expected child.tool.start");
		assert.ok(endIdx !== -1, "expected child.tool.end");
		assert.ok(startIdx < endIdx, "tool.start must precede tool.end");
	});

	test("tool.start carries toolName and toolCallId", () => {
		const { events } = runFixture("bash-tool.jsonl");
		const toolStart = events.find((e) => e.type === EVENT_CHILD_TOOL_START);
		assert.ok(toolStart);
		const s = toolStart as { toolName: string; toolCallId: string };
		assert.strictEqual(s.toolName, "bash");
		assert.ok(s.toolCallId.length > 0, "toolCallId should be non-empty");
	});

	test("tool.end reports ok=true for a successful bash invocation", () => {
		const { events } = runFixture("bash-tool.jsonl");
		const toolEnd = events.find((e) => e.type === EVENT_CHILD_TOOL_END);
		assert.ok(toolEnd);
		assert.strictEqual((toolEnd as { ok: boolean }).ok, true);
	});

	test("state.toolCount reflects the number of tool invocations", () => {
		const { state } = runFixture("bash-tool.jsonl");
		assert.strictEqual(state.toolCount, 1);
	});

	test("state aggregates usage across multiple assistant turns", () => {
		const { state } = runFixture("bash-tool.jsonl");
		// Tool-use runs produce two assistant turns: toolcall turn + final-answer turn.
		assert.strictEqual(state.turnCount, 2);
		assert.ok(state.usage.input > 0);
		assert.ok(state.usage.output > 0);
	});

	test("final assistant text is captured after the tool result", () => {
		const { state } = runFixture("bash-tool.jsonl");
		assert.ok(state.lastTextFinal);
		assert.ok(state.lastTextFinal!.includes("fixture-tool-test"));
	});
});

describe("normalizer: stability invariants", () => {
	test("unknown top-level event types produce zero events", () => {
		const state = createNormalizerState();
		const events = normalizeRawEvent({ type: "something-new" }, identity(), state);
		assert.deepStrictEqual(events, []);
	});

	test("missing assistantMessageEvent on message_update is safe", () => {
		const state = createNormalizerState();
		const events = normalizeRawEvent({ type: "message_update" }, identity(), state);
		assert.deepStrictEqual(events, []);
	});

	test("parseRawLine ignores plain text but throws for malformed JSON-looking input", () => {
		assert.strictEqual(parseRawLine(""), undefined);
		assert.strictEqual(parseRawLine("   \t  "), undefined);
		assert.strictEqual(parseRawLine("not json"), undefined);
		assert.throws(() => parseRawLine("{ bad }"), /malformed JSON line/);
	});

	test("tool end without toolName clears current tool state", () => {
		const state = createNormalizerState();
		const id = identity();
		normalizeRawEvent({ type: "tool_execution_start", toolName: "read", toolCallId: "tool-1" }, id, state);
		const events = normalizeRawEvent({ type: "tool_execution_end", result: "ok" }, id, state);
		assert.equal(events[0]?.type, EVENT_CHILD_TOOL_END);
		assert.equal(events[0]?.toolName, "read");
		assert.equal(state.currentToolName, undefined);
		assert.equal(state.currentToolCallId, undefined);
	});
});

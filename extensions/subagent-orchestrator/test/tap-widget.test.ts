import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EVENT_CHILD_TEXT_DELTA, EVENT_CHILD_TOOL_END, EVENT_CHILD_TOOL_START } from "../../subagent-mode/types.ts";
import { appendTapWidgetEvent, createTapWidgetState, renderTapWidgetLines, resetTapWidget, TAP_WIDGET_MAX_LINES } from "../tap-widget.ts";
import type { SubagentStreamEvent } from "../stream.ts";

function event(overrides: Partial<SubagentStreamEvent>): SubagentStreamEvent {
	return {
		childSessionId: "child-1",
		runId: "run-1",
		cursor: "1",
		eventType: "unknown",
		event: {},
		replay: false,
		...overrides,
	};
}

describe("tap widget", () => {
	test("root selection renders a horizontal rule and reserves widget height", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1" });
		const lines = renderTapWidgetLines(state);
		assert.equal(lines.length, TAP_WIDGET_MAX_LINES);
		assert.match(lines[0]!, /^─+$/);
		assert.equal(lines.slice(1).every((line) => line === ""), true);
	});

	test("tool start renders command", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1 > scout 1", selectedChildSessionId: "child-1" });
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TOOL_START, event: { toolName: "bash", command: "npm test" } }));
		assert.equal(renderTapWidgetLines(state)[1], "▶ npm test");
	});

	test("tool end does not render result content", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1 > scout 1", selectedChildSessionId: "child-1" });
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", ok: true, resultSummary: "secret content" } }));
		const lines = renderTapWidgetLines(state);
		assert.equal(lines[1], "✓ read");
		assert.equal(lines.join("\n").includes("secret content"), false);
	});

	test("text deltas are coalesced into readable text", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1 > scout 1", selectedChildSessionId: "child-1" });
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "The tap " } }));
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "widget streams " } }));
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "agent text." } }));
		assert.equal(renderTapWidgetLines(state)[1], "The tap widget streams agent text.");
	});

	test("pending text is bounded", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1 > scout 1", selectedChildSessionId: "child-1" });
		appendTapWidgetEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "a".repeat(5000) } }));
		assert.ok((state.pendingText?.length ?? 0) <= 4000);
	});

	test("output is capped to sixteen lines", () => {
		const state = createTapWidgetState();
		resetTapWidget(state, { crumb: "tap: run 1 > scout 1", selectedChildSessionId: "child-1" });
		for (let i = 0; i < 20; i++) appendTapWidgetEvent(state, event({ cursor: String(i), eventType: `event-${i}` }));
		const lines = renderTapWidgetLines(state);
		assert.equal(lines.length, TAP_WIDGET_MAX_LINES);
		assert.equal(lines[1], "event-5");
		assert.equal(lines[15], "event-19");
	});
});

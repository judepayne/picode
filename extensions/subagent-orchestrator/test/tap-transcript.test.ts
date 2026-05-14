import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";

import { EVENT_CHILD_PROGRESS, EVENT_CHILD_TEXT_DELTA, EVENT_CHILD_TOOL_END, EVENT_CHILD_TOOL_START } from "../../subagent-mode/types.ts";
import { EVENT_SUBAGENT_TASK, type SubagentStreamEvent } from "../stream.ts";
import { appendTapTranscriptEvent, createTapTranscriptComponent, createTapTranscriptState, resetTapTranscript, setTapTranscriptToolsExpanded } from "../tap-transcript.ts";

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

function renderText(state = createTapTranscriptState()): string {
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const component = createTapTranscriptComponent(state, {} as never, theme as never);
	return component.render(120).join("\n");
}

before(() => initTheme(undefined, false));

describe("tap transcript", () => {
	test("root selection renders no widget content", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, {});
		assert.deepEqual(createTapTranscriptComponent(state, {} as never, {} as never).render(120), []);
	});

	test("task event renders as transcript content", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ eventType: EVENT_SUBAGENT_TASK, event: { task: "Read three files and summarize them." } }));
		assert.match(renderText(state), /Read three files and summarize them\./);
	});

	test("text deltas are coalesced into one assistant entry", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "The tap " } }));
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "transcript streams " } }));
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "agent text." } }));
		assert.match(renderText(state), /The tap transcript streams agent text\./);
		assert.equal(state.entries.length, 1);
	});

	test("progress events are suppressed in the transcript", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_PROGRESS, event: { currentTool: "read" } }));
		assert.equal(renderText(state), "");
	});

	test("tool command JSON is formatted as a card with meaningful details", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", toolCallId: "tool-1", command: 'read {"path":"extensions/subagent-orchestrator/index.ts","limit":220}' } }));
		appendTapTranscriptEvent(state, event({ eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", toolCallId: "tool-1", ok: true, resultPreview: "secret content" } }));
		const collapsed = renderText(state);
		assert.match(collapsed, /✓ read extensions\/subagent-orchestrator\/index\.ts/);
		assert.match(collapsed, /limit: 220/);
		assert.match(collapsed, /result hidden/);
		assert.equal(collapsed.includes('{"path"'), false);
		assert.equal(collapsed.includes("secret content"), false);

		setTapTranscriptToolsExpanded(state, true);
		const expanded = renderText(state);
		assert.match(expanded, /secret content/);
	});

	test("tool end without an id updates the latest pending tool of the same type", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ cursor: "1", eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", command: 'read {"path":"file.ts"}' } }));
		appendTapTranscriptEvent(state, event({ cursor: "2", eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", ok: true, resultPreview: "done" } }));
		assert.equal(state.entries.length, 1);
		assert.match(renderText(state), /✓ read file\.ts/);
	});

	test("tap errors render as status text", () => {
		const state = createTapTranscriptState();
		resetTapTranscript(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptEvent(state, event({ eventType: "tap.error", event: { message: "stream failed" } }));
		assert.match(renderText(state), /stream failed/);
	});
});

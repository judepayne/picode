import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";

import { EVENT_CHILD_COMPLETE, EVENT_CHILD_PROGRESS, EVENT_CHILD_STARTED, EVENT_CHILD_TEXT_DELTA, EVENT_CHILD_TEXT_FINAL, EVENT_CHILD_TOOL_END, EVENT_CHILD_TOOL_START } from "../../subagent-mode/types.ts";
import { EVENT_SUBAGENT_EXPANDED_TASK, EVENT_SUBAGENT_TASK, type SubagentStreamEvent } from "../stream.ts";
import {
	__debugTapTranscriptTree,
	appendTapTranscriptTreeEvent,
	ASSISTANT_CHUNK_HARD_LIMIT,
	createTapTranscriptTreeComponent,
	createTapTranscriptTreeState,
	resetTapTranscriptTree,
	setTapTranscriptTreeToolsExpanded,
} from "../tap-transcript-tree.ts";

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

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderText(state = createTapTranscriptTreeState()): string {
	const component = createTapTranscriptTreeComponent(state, {} as never, theme as never);
	return component.render(120).join("\n");
}

before(() => initTheme(undefined, false));

describe("tap transcript tree", () => {
	test("root selection renders no widget content", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, {});
		assert.deepEqual(createTapTranscriptTreeComponent(state, {} as never, theme as never).render(120), []);
	});

	test("task event renders once as transcript content", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_SUBAGENT_TASK, event: { task: "Read three files and summarize them." } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_SUBAGENT_TASK, event: { task: "Duplicate task." } }));
		assert.match(renderText(state), /Read three files and summarize them\./);
		assert.doesNotMatch(renderText(state), /Duplicate task/);
		assert.equal(state.nodes.length, 1);
	});

	test("expanded task event renders as a compact audit status", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_SUBAGENT_EXPANDED_TASK, event: { task: "Full expanded task", taskCharCount: 18 } }));
		assert.match(renderText(state), /expanded task recorded \(18 chars\)/);
	});

	test("text deltas render as assistant markdown output", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "The tap " } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "transcript streams " } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "agent text." } }));
		assert.match(renderText(state), /The tap transcript streams agent text\./);
		assert.deepEqual(__debugTapTranscriptTree(state).map((node) => node.kind), ["assistant"]);
	});

	test("text after a tool starts a new assistant node", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "before" } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", toolCallId: "tool-1", command: 'read {"path":"file.ts"}' } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "after" } }));
		assert.deepEqual(__debugTapTranscriptTree(state).map((node) => node.kind), ["assistant", "tool", "assistant"]);
		assert.match(renderText(state), /before/);
		assert.match(renderText(state), /after/);
	});

	test("long assistant runs split into sealed chunks plus live tail", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: `${"a".repeat(ASSISTANT_CHUNK_HARD_LIMIT + 100)}\n\ntail` } }));
		const debug = __debugTapTranscriptTree(state);
		assert.equal(debug.length >= 2, true);
		assert.equal(debug[0]?.kind, "assistant");
		assert.equal(debug[0]?.sealed, true);
		assert.equal(debug.at(-1)?.sealed, false);
	});

	test("sealed assistant chunks are not rebuilt when later deltas arrive", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: `${"a".repeat(ASSISTANT_CHUNK_HARD_LIMIT + 100)}\n\ntail` } }));
		renderText(state);
		const before = __debugTapTranscriptTree(state);
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: " more" } }));
		renderText(state);
		const after = __debugTapTranscriptTree(state);
		assert.equal(after[0]?.builds, before[0]?.builds);
		assert.equal((after.at(-1)?.builds ?? 0) > (before.at(-1)?.builds ?? 0), true);
	});

	test("assistant chunk splitting preserves whitespace at split boundaries", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: `${"a".repeat(ASSISTANT_CHUNK_HARD_LIMIT + 100)}\n\n    indented code` } }));
		assert.equal(__debugTapTranscriptTree(state).map((node) => node.text ?? "").join(""), `${"a".repeat(ASSISTANT_CHUNK_HARD_LIMIT + 100)}\n\n    indented code`);
	});

	test("progress, start, and complete events are suppressed in the transcript", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_STARTED, event: {} }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_PROGRESS, event: { currentTool: "read" } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_COMPLETE, event: {} }));
		assert.equal(renderText(state), "");
	});

	test("tool command JSON is formatted as a card with meaningful details", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", toolCallId: "tool-1", command: 'read {"path":"extensions/subagent-orchestrator/index.ts","limit":220}' } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", toolCallId: "tool-1", ok: true, resultPreview: "secret content" } }));
		const collapsed = renderText(state);
		assert.match(collapsed, /✓ read extensions\/subagent-orchestrator\/index\.ts/);
		assert.match(collapsed, /limit: 220/);
		assert.match(collapsed, /result hidden/);
		assert.equal(collapsed.includes('{"path"'), false);
		assert.equal(collapsed.includes("secret content"), false);

		setTapTranscriptTreeToolsExpanded(state, true);
		const expanded = renderText(state);
		assert.match(expanded, /secret content/);
	});

	test("tool end without an id updates the latest pending tool of the same type", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ cursor: "1", eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", command: 'read {"path":"file.ts"}' } }));
		appendTapTranscriptTreeEvent(state, event({ cursor: "2", eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", ok: true, resultPreview: "done" } }));
		assert.equal(state.nodes.length, 1);
		assert.match(renderText(state), /✓ read file\.ts/);
	});

	test("tool cards cache collapsed and expanded output", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TOOL_START, event: { toolName: "read", toolCallId: "tool-1", command: 'read {"path":"file.ts"}' } }));
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TOOL_END, event: { toolName: "read", toolCallId: "tool-1", ok: true, resultPreview: "done" } }));
		renderText(state);
		setTapTranscriptTreeToolsExpanded(state, true);
		renderText(state);
		const afterBothModes = __debugTapTranscriptTree(state)[0]?.builds;
		setTapTranscriptTreeToolsExpanded(state, false);
		renderText(state);
		assert.equal(__debugTapTranscriptTree(state)[0]?.builds, afterBothModes);
	});

	test("text final with no output renders a dim status", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: EVENT_CHILD_TEXT_FINAL, event: { charCount: 0 } }));
		assert.match(renderText(state), /No assistant output\./);
	});

	test("tap errors render as status text", () => {
		const state = createTapTranscriptTreeState();
		resetTapTranscriptTree(state, { selectedChildSessionId: "child-1" });
		appendTapTranscriptTreeEvent(state, event({ eventType: "tap.error", event: { message: "stream failed" } }));
		assert.match(renderText(state), /stream failed/);
	});
});

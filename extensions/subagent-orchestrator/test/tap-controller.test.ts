import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";

import { EVENT_CHILD_TEXT_DELTA } from "../../subagent-mode/types.ts";
import { createTapController } from "../tap-controller.ts";
import type { TapRunRoot } from "../tap-navigation.ts";
import { EVENT_SUBAGENT_TASK, type SubagentStreamEvent, type SubagentStreamHandler } from "../stream.ts";

const CTRL_SLASH = "\x1b[47;5u";
const CTRL_DOT = "\x1b[46;5u";
const CTRL_DOT_REPEAT = "\x1b[46;5:2u";
const CTRL_DOT_RELEASE = "\x1b[46;5:3u";
const CTRL_O = "\x0f";
const ESC = "\x1b";
const realDateNow = Date.now;

afterEach(() => {
	Date.now = realDateNow;
});

function roots(): TapRunRoot[] {
	return [{
		id: "run-1",
		label: "run 1",
		kind: "run",
		rootRunId: "run-1",
		children: [{
			childSessionId: "child-1",
			agent: "scout",
			childIndex: 0,
			status: "running",
			taskSummary: "inspect",
			children: [],
		}],
	}];
}

function twoScoutRoots(): TapRunRoot[] {
	const [root] = roots();
	return [{
		...root!,
		children: [
			...root!.children,
			{
				childSessionId: "child-2",
				agent: "scout",
				childIndex: 1,
				status: "running",
				taskSummary: "inspect 2",
				children: [],
			},
		],
	}];
}

function ctx() {
	let inputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	let toolsExpanded = false;
	return {
		context: {
			hasUI: true,
			ui: {
				theme: { bold: (text: string) => `**${text}**`, fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bg: (color: string, text: string) => `<${color}>${text}</${color}>` },
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => {
						inputHandler = undefined;
					};
				},
				setWidget(key: string, content: string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) {
					const lines = typeof content === "function"
						? content(undefined, this.theme).render(120).map((line) => line.trimEnd())
						: content;
					widgets.set(key, lines);
				},
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
				},
				getToolsExpanded() {
					return toolsExpanded;
				},
				setToolsExpanded(expanded: boolean) {
					toolsExpanded = expanded;
				},
			},
		},
		widgets,
		statuses,
		input(data: string) {
			return inputHandler?.(data);
		},
	};
}

before(() => initTheme(undefined, false));

describe("tap controller", () => {
	test("ctrl slash opens at root and does not immediately enter on repeated input", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		const controller = createTapController({ getRoots: roots, openStream: () => () => {} });
		controller.handleCtx(fake.context as never);

		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning> > scout 1");
		assert.equal(fake.widgets.get("subagent-orchestrator-tap"), undefined);

		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning> > scout 1");

		now += 301;
		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > <warning>**scout 1**</warning>");

		assert.deepEqual(fake.input(ESC), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning> > scout 1");
		assert.equal(fake.widgets.get("subagent-orchestrator-tap"), undefined);
		assert.deepEqual(fake.input(ESC), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning> > scout 1");
		now += 301;
		assert.deepEqual(fake.input(ESC), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), undefined);
		assert.equal(fake.widgets.get("subagent-orchestrator-tap"), undefined);
	});

	test("active tap polls until closed", async () => {
		const fake = ctx();
		let polls = 0;
		const controller = createTapController({
			getRoots: roots,
			openStream: () => () => {},
			onPoll: () => { polls += 1; },
			pollIntervalMs: 5,
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(polls > 0);
		fake.input(ESC);
		const afterClose = polls;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(polls, afterClose);
	});

	test("entering a child opens stream and selection changes close previous stream", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		let opened: string[] = [];
		let closed = 0;
		const controller = createTapController({
			getRoots: roots,
			openStream: (childSessionId: string, handler: SubagentStreamHandler) => {
				opened.push(childSessionId);
				handler({ childSessionId, runId: "run-1", cursor: "1", eventType: EVENT_SUBAGENT_TASK, event: { task: "inspect files" }, replay: true } satisfies SubagentStreamEvent);
				return () => { closed += 1; };
			},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		assert.deepEqual(opened, ["child-1"]);
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > <warning>**scout 1**</warning>");
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.join("\n").includes("inspect files"), true);

		controller.dispose();
		assert.equal(closed, 1);
		assert.equal(fake.input(CTRL_SLASH), undefined);
	});

	test("stale stream events from previous sibling are ignored after switching children", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		const handlers = new Map<string, SubagentStreamHandler>();
		const controller = createTapController({
			getRoots: twoScoutRoots,
			openStream: (childSessionId: string, handler: SubagentStreamHandler) => {
				handlers.set(childSessionId, handler);
				return () => {};
			},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > <warning>**scout 1**</warning>, scout 2");
		fake.input(CTRL_DOT);
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > scout 1, <warning>**scout 2**</warning>");

		handlers.get("child-1")?.({ childSessionId: "child-1", runId: "run-1", cursor: "1", eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "old-event" }, replay: false });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > scout 1, <warning>**scout 2**</warning>");
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.includes("old-event"), false);

		handlers.get("child-2")?.({ childSessionId: "child-2", runId: "run-1", cursor: "2", eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "new-event" }, replay: false });
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.includes("new-event"), true);
	});

	test("failed stream open can be retried on refresh", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		let attempts = 0;
		const controller = createTapController({
			getRoots: roots,
			openStream: (childSessionId: string, handler: SubagentStreamHandler) => {
				attempts += 1;
				if (attempts === 1) throw new Error("boom");
				handler({ childSessionId, runId: "run-1", cursor: "2", eventType: EVENT_CHILD_TEXT_DELTA, event: { delta: "recovered" }, replay: true } satisfies SubagentStreamEvent);
				return () => {};
			},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		assert.equal(attempts, 1);
		controller.refresh();
		assert.equal(attempts, 2);
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.includes("recovered"), true);
	});

	test("ctrl o toggles transcript tool result expansion", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		const controller = createTapController({
			getRoots: roots,
			openStream: (childSessionId: string, handler: SubagentStreamHandler) => {
				handler({ childSessionId, runId: "run-1", cursor: "1", eventType: "subagent:mode:child.tool.start", event: { toolName: "read", toolCallId: "tool-1", command: 'read {"path":"file.ts"}' }, replay: true });
				handler({ childSessionId, runId: "run-1", cursor: "2", eventType: "subagent:mode:child.tool.end", event: { toolName: "read", toolCallId: "tool-1", ok: true, resultPreview: "file contents" }, replay: true });
				return () => {};
			},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.join("\n").includes("file contents"), false);
		assert.deepEqual(fake.input(CTRL_O), { consume: true });
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.join("\n").includes("file contents"), true);
	});

	test("key release and repeat events do not navigate between siblings", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		const controller = createTapController({
			getRoots: twoScoutRoots,
			openStream: () => () => {},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		fake.input(CTRL_DOT);
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > scout 1, <warning>**scout 2**</warning>");

		assert.deepEqual(fake.input(CTRL_DOT_RELEASE), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > scout 1, <warning>**scout 2**</warning>");

		assert.deepEqual(fake.input(CTRL_DOT_REPEAT), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > scout 1, <warning>**scout 2**</warning>");
	});
});

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createTapController } from "../tap-controller.ts";
import type { TapRunRoot } from "../tap-navigation.ts";
import type { SubagentStreamEvent, SubagentStreamHandler } from "../stream.ts";

const CTRL_SLASH = "\x1b[47;5u";
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

function ctx() {
	let inputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	return {
		context: {
			hasUI: true,
			ui: {
				theme: { bold: (text: string) => `**${text}**`, fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => {
						inputHandler = undefined;
					};
				},
				setWidget(key: string, content: string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) {
					const lines = typeof content === "function"
						? content(undefined, undefined).render(120).map((line) => line.trimEnd())
						: content;
					widgets.set(key, lines);
				},
				setStatus(key: string, text: string | undefined) {
					statuses.set(key, text);
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

describe("tap controller", () => {
	test("ctrl slash opens at root and does not immediately enter on repeated input", () => {
		let now = 1000;
		Date.now = () => now;
		const fake = ctx();
		const controller = createTapController({ getRoots: roots, openStream: () => () => {} });
		controller.handleCtx(fake.context as never);

		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning>");
		assert.match(fake.widgets.get("subagent-orchestrator-tap")?.[0] ?? "", /^─+$/);

		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning>");

		now += 301;
		assert.deepEqual(fake.input(CTRL_SLASH), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > <warning>**scout 1**</warning>");

		assert.deepEqual(fake.input(ESC), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning>");
		assert.deepEqual(fake.input(ESC), { consume: true });
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: <warning>**run 1**</warning>");
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
				handler({ childSessionId, runId: "run-1", cursor: "1", eventType: "event", event: {}, replay: true } satisfies SubagentStreamEvent);
				return () => { closed += 1; };
			},
		});
		controller.handleCtx(fake.context as never);

		fake.input(CTRL_SLASH);
		now += 301;
		fake.input(CTRL_SLASH);
		assert.deepEqual(opened, ["child-1"]);
		assert.equal(fake.statuses.get("subagent-orchestrator-tap"), "::: run 1 > <warning>**scout 1**</warning>");
		assert.equal(fake.widgets.get("subagent-orchestrator-tap")?.[1], "event");

		controller.dispose();
		assert.equal(closed, 1);
		assert.equal(fake.input(CTRL_SLASH), undefined);
	});
});

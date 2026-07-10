import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContinuationController } from "../continuation-controller.ts";
import type { OrchestratorChildSessionRecord } from "../types.ts";

const target = {
	childSessionId: "child-1",
	agent: "worker",
	parentSessionId: "parent-session",
	sessionFile: "/tmp/worker-session.jsonl",
	status: "complete",
} as OrchestratorChildSessionRecord;

const context = {
	sessionManager: {
		getSessionFile: () => undefined,
		getSessionId: () => "parent-session",
	},
} as never;

describe("continuation controller", () => {
	it("validates agent continuation through the injected state store", () => {
		const state = {
			getChildSession: (id: string) => id === target.childSessionId ? target : undefined,
			listChildSessions: () => [target],
		} as never;
		const controller = createContinuationController(state);
		const result = controller.validateAgent(context, {
			shape: "single",
			agent: "worker",
			async: false,
			context: "continue",
			showRunCard: false,
			childSessionId: target.childSessionId,
			task: "continue",
		});
		assert.deepEqual(result, { sessionFiles: [target.sessionFile] });
	});
});

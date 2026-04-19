import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandbackDeduplicationKey, buildQueuedHandback, formatQueuedHandbackContent, partitionHandbackDuplicates } from "../handbacks.ts";
import type { OrchestratorChildSessionRecord, OrchestratorRunRecord } from "../types.ts";

const run: OrchestratorRunRecord = {
	orchestratorRunId: "run-1",
	ownerModeId: "designer",
	parentSessionId: "session-1",
	launchedAt: 1,
	updatedAt: 1,
	requestShape: "parallel",
	async: true,
	context: "fresh",
	origin: "user",
	agent: "scout",
	status: "running",
	taskSummary: "A | B",
};

const children: OrchestratorChildSessionRecord[] = [
	{
		childSessionId: "child-1",
		runId: "run-1",
		ownerModeId: "designer",
		parentSessionId: "session-1",
		requestShape: "parallel",
		async: true,
		context: "fresh",
		agent: "scout",
		childIndex: 0,
		childKey: "parallel:0",
		status: "complete",
		taskSummary: "A",
		createdAt: 1,
		updatedAt: 1,
	},
	{
		childSessionId: "child-2",
		runId: "run-1",
		ownerModeId: "designer",
		parentSessionId: "session-1",
		requestShape: "parallel",
		async: true,
		context: "fresh",
		agent: "scout",
		childIndex: 1,
		childKey: "parallel:1",
		status: "complete",
		taskSummary: "B",
		createdAt: 1,
		updatedAt: 1,
	},
];

describe("handbacks", () => {
	it("formats grouped content by top-level run", () => {
		const content = formatQueuedHandbackContent(run, children, [
			{ childIndex: 0, output: "Output A" },
			{ childIndex: 1, output: "Output B" },
		], "Fallback");
		assert.equal(content, "Output A\n\nOutput B");
	});

	it("creates a queued handback for non-cancelled async completion", () => {
		const handback = buildQueuedHandback(run, children, {
			id: "async-1",
			status: "complete",
			success: true,
			summary: "done",
			results: [
				{ output: "Output A", success: true },
				{ output: "Output B", success: true },
			],
		}, 10);
		assert.ok(handback);
		assert.equal(handback?.status, "queued");
		assert.equal(handback?.consumer, "user");
		assert.equal(handback?.agent, "scout");
		assert.deepEqual(handback?.childSessionIds, ["child-1", "child-2"]);
	});

	it("builds the same dedupe key for semantically identical handbacks", () => {
		const keyA = buildHandbackDeduplicationKey({
			runId: "run-1",
			childSessionIds: ["child-1", "child-2"],
			content: "Background result\n\nOutput A",
		});
		const keyB = buildHandbackDeduplicationKey({
			runId: "run-1",
			childSessionIds: ["child-2", "child-1"],
			content: "Background   result Output A",
		});
		assert.equal(keyA, keyB);
	});

	it("partitions duplicate handbacks before continuation batching", () => {
		const records = [
			{
				handbackId: "hb-1",
				runId: "run-1",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				childSessionIds: ["child-1"],
				status: "queued" as const,
				content: "Same content",
				summary: "Same content",
				createdAt: 10,
				updatedAt: 10,
			},
			{
				handbackId: "hb-2",
				runId: "run-1",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				childSessionIds: ["child-1"],
				status: "consumed" as const,
				content: "Same   content",
				summary: "Same content",
				createdAt: 20,
				updatedAt: 20,
			},
			{
				handbackId: "hb-3",
				runId: "run-2",
				ownerModeId: "designer",
				parentSessionId: "session-1",
				childSessionIds: ["child-2"],
				status: "queued" as const,
				content: "Different",
				summary: "Different",
				createdAt: 30,
				updatedAt: 30,
			},
		];
		const { unique, duplicates } = partitionHandbackDuplicates(records);
		assert.deepEqual(unique.map((entry) => entry.handbackId), ["hb-2", "hb-3"]);
		assert.deepEqual(duplicates.map((entry) => entry.handbackId), ["hb-1"]);
	});
});

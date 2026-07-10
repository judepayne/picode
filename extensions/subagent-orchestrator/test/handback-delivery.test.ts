import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { createHandbackDeliveryController } from "../handback-delivery.ts";
import { createStateStore } from "../state.ts";


describe("handback delivery persistence", () => {
	it("keeps dispatch failures queued and reuses the durable continuation on scheduled retry", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-handback-delivery-"));
		try {
			const state = createStateStore(root);
			state.ensureReady();
			state.createRun({ orchestratorRunId: "run", ownerModeId: "builder", parentSessionId: "parent", launchedAt: 1, updatedAt: 1, requestShape: "single", async: true, context: "fresh", status: "complete", taskSummary: "task" });
			state.createHandback({ handbackId: "hb", runId: "run", ownerModeId: "builder", parentSessionId: "parent", childSessionIds: [], status: "queued", content: "result", summary: "result", createdAt: 1, updatedAt: 1 });
			let failDispatch = true;
			let deliveryErrors = 0;
			const pi = {
				appendEntry: () => { if (failDispatch) throw new Error("dispatch failed"); },
				sendMessage: () => undefined,
			} as never;
			const ctx = { isIdle: () => true, hasPendingMessages: () => false } as never;
			const controller = createHandbackDeliveryController({
				pi,
				state,
				getLatestCtx: () => ctx,
				findCurrentModeId: () => "builder",
				currentSessionLineage: () => undefined,
				handbackMatchesSessionLineage: () => true,
				normalizeHandbackConsumer: () => "agent",
				refreshRunAggregates: () => undefined,
				onDeliveryError: () => {
					deliveryErrors += 1;
					failDispatch = false;
				},
			});
			assert.throws(() => controller.flushQueuedHandbacks(ctx, { forceAgentDelivery: true }), /dispatch failed/);
			assert.equal(state.getHandback("hb")?.status, "queued");
			assert.equal(state.listContinuations().length, 1);
			assert.equal(state.listContinuations()[0]?.status, "queued");

			controller.scheduleQueuedHandbackFlush(1, 2);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(deliveryErrors, 1);
			assert.equal(state.listContinuations().length, 1);
			assert.equal(state.listContinuations()[0]?.status, "launched");
			assert.equal(state.getHandback("hb")?.status, "consumed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

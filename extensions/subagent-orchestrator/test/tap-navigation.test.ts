import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildTapRoots, formatTapCrumb, formatTapFooterTree, moveTapSelection } from "../tap-navigation.ts";
import type { OrchestratorChildSessionRecord, OrchestratorRunRecord } from "../types.ts";

function run(id: string, overrides: Partial<OrchestratorRunRecord> = {}): OrchestratorRunRecord {
	return {
		orchestratorRunId: id,
		ownerModeId: "builder",
		parentSessionId: "parent",
		launchedAt: 100,
		updatedAt: 100,
		requestShape: "single",
		async: true,
		context: "fresh",
		origin: "agent",
		status: "running",
		taskSummary: id,
		...overrides,
	};
}

const formatters = {
	running: (text: string) => `{${text}}`,
	queued: (text: string) => `?${text}?`,
	complete: (text: string) => `(${text})`,
	failed: (text: string) => `!${text}!`,
	selected: (text: string) => `[${text}]`,
};

function child(id: string, runId: string, index: number, overrides: Partial<OrchestratorChildSessionRecord> = {}): OrchestratorChildSessionRecord {
	return {
		childSessionId: id,
		runId,
		rootRunId: runId,
		ownerModeId: "builder",
		parentSessionId: "parent",
		requestShape: "single",
		async: true,
		context: "fresh",
		agent: "scout",
		childIndex: index,
		childKey: String(index),
		status: "running",
		taskSummary: id,
		createdAt: 100 + index,
		updatedAt: 100 + index,
		...overrides,
	};
}

describe("tap navigation", () => {
	test("root left and right cycle runs", () => {
		const roots = buildTapRoots(
			[run("run-a", { launchedAt: 200 }), run("run-b", { launchedAt: 100 })],
			[child("child-a", "run-a", 0), child("child-b", "run-b", 0)],
		);
		assert.equal(roots.length, 2);
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0 }, "right").selection, { rootIndex: 1 });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0 }, "left").selection, { rootIndex: 1 });
	});

	test("root down enters a run root and root up closes", () => {
		const roots = buildTapRoots([run("run-a")], [child("child-a", "run-a", 0)]);
		assert.deepEqual(moveTapSelection(roots, {}, "down").selection, { rootIndex: 0 });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0 }, "down").selection, { rootIndex: 0, childSessionId: "child-a" });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0 }, "up").selection, {});
		assert.equal(moveTapSelection(roots, {}, "up").close, true);
	});

	test("child left and right cycle siblings", () => {
		const roots = buildTapRoots([run("run-a")], [child("child-a", "run-a", 0), child("child-b", "run-a", 1)]);
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0, childSessionId: "child-a" }, "right").selection, { rootIndex: 0, childSessionId: "child-b" });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0, childSessionId: "child-a" }, "left").selection, { rootIndex: 0, childSessionId: "child-b" });
	});

	test("children sort numerically by child index", () => {
		const roots = buildTapRoots([run("run-a")], [child("child-10", "run-a", 10), child("child-2", "run-a", 2)]);
		assert.equal(roots[0]!.children[0]!.childSessionId, "child-2");
		assert.equal(roots[0]!.children[1]!.childSessionId, "child-10");
	});

	test("child down enters first child and up moves to parent/root", () => {
		const roots = buildTapRoots([run("run-a")], [
			child("parent", "run-a", 0),
			child("nested", "run-a", 0, { parentChildSessionId: "parent" }),
		]);
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0, childSessionId: "parent" }, "down").selection, { rootIndex: 0, childSessionId: "nested" });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0, childSessionId: "nested" }, "up").selection, { rootIndex: 0, childSessionId: "parent" });
		assert.deepEqual(moveTapSelection(roots, { rootIndex: 0, childSessionId: "parent" }, "up").selection, { rootIndex: 0 });
	});

	test("user-origin runs appear under user root", () => {
		const roots = buildTapRoots(
			[run("run-a"), run("user-run", { origin: "user", launchedAt: 50 })],
			[child("child-a", "run-a", 0), child("user-child", "user-run", 0)],
		);
		assert.deepEqual(roots.map((root) => root.label), ["run 1", "user"]);
		assert.equal(roots[1]!.children[0]!.childSessionId, "user-child");
		assert.equal(formatTapCrumb(roots, { rootIndex: 1, childSessionId: "user-child" }), "tap: root > user > scout 1");
	});

	test("footer tree shows all roots and styles queued, running, complete, failed, selected, and tool-failed children", () => {
		const roots = buildTapRoots(
			[run("run-a", { launchedAt: 200 }), run("run-b", { launchedAt: 100 }), run("user-run", { origin: "user", launchedAt: 50, status: "queued" })],
			[
				child("child-a", "run-a", 0, { status: "complete" }),
				child("child-b", "run-a", 1, { status: "failed" }),
				child("child-c", "run-b", 0, { status: "complete", failedToolCount: 1 }),
				child("user-child", "user-run", 0, { status: "queued" }),
			],
		);
		assert.equal(formatTapFooterTree(roots, {}, formatters), "● root > run 1 > (scout 1), !scout 2!, run 2 > !scout 1!, user > ?scout 1?");
		assert.equal(formatTapFooterTree(roots, { rootIndex: 0 }, formatters), "root > [● run 1] > (scout 1), !scout 2!, run 2 > !scout 1!, user > ?scout 1?");
		assert.equal(formatTapFooterTree(roots, { rootIndex: 0, childSessionId: "child-b" }, formatters), "root > run 1 > (scout 1), [!● scout 2!], run 2 > !scout 1!, user > ?scout 1?");
		assert.equal(formatTapFooterTree(roots, { rootIndex: 2, childSessionId: "user-child" }, formatters), "root > run 1 > (scout 1), !scout 2!, run 2 > !scout 1!, user > [?● scout 1?]");
	});

	test("queued async non-chain child in a running or started run renders as running", () => {
		const runningRoots = buildTapRoots(
			[run("run-a", { status: "running" })],
			[child("child-a", "run-a", 0, { status: "queued", requestShape: "single" })],
		);
		assert.equal(formatTapFooterTree(runningRoots, {}, formatters), "● root > run 1 > {scout 1}");

		const startedRoots = buildTapRoots(
			[run("run-a", { status: "queued" })],
			[child("child-a", "run-a", 0, { status: "queued", requestShape: "single", asyncDir: "/tmp/async-run" })],
		);
		assert.equal(formatTapFooterTree(startedRoots, {}, formatters), "● root > run 1 > {scout 1}");

		const syncRoots = buildTapRoots(
			[run("run-a", { status: "running", async: false })],
			[child("child-a", "run-a", 0, { status: "queued", requestShape: "single", async: false })],
		);
		assert.equal(formatTapFooterTree(syncRoots, {}, formatters), "● root > run 1 > ?scout 1?");
	});

	test("footer tree uses arrow separators for chain steps and commas for parallel siblings", () => {
		const roots = buildTapRoots(
			[run("chain-run", { requestShape: "chain", launchedAt: 200 }), run("parallel-run", { requestShape: "parallel", launchedAt: 100 })],
			[
				child("step-1", "chain-run", 0, { requestShape: "chain", stepIndex: 0, status: "complete" }),
				child("step-2", "chain-run", 1, { requestShape: "chain", stepIndex: 1, status: "running" }),
				child("step-3", "chain-run", 2, { requestShape: "chain", stepIndex: 2, status: "queued" }),
				child("parallel-1", "parallel-run", 0, { requestShape: "parallel" }),
				child("parallel-2", "parallel-run", 1, { requestShape: "parallel" }),
			],
		);
		assert.equal(formatTapFooterTree(roots, { rootIndex: 0, childSessionId: "step-2" }, formatters), "root > run 1 > (scout 1) → [{● scout 2}] → ?scout 3?, run 2 > {scout 1}, {scout 2}");
	});
});

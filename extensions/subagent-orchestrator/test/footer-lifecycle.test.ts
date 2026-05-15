import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createFooterLifecycleController } from "../footer-lifecycle.ts";
import { formatTapFooterTree } from "../tap-navigation.ts";
import type { OrchestratorChildSessionRecord, OrchestratorHandbackRecord, OrchestratorRunRecord } from "../types.ts";

function run(id: string, overrides: Partial<OrchestratorRunRecord> = {}): OrchestratorRunRecord {
	return {
		orchestratorRunId: id,
		ownerModeId: "planner",
		parentSessionId: "parent-session",
		parentSessionFile: "parent.jsonl",
		rootRunId: id,
		launchedAt: 100,
		updatedAt: 100,
		requestShape: "single",
		async: true,
		context: "fresh",
		origin: "agent",
		agent: "scout",
		status: "running",
		taskSummary: id,
		...overrides,
	};
}

function child(id: string, runId: string, index: number, overrides: Partial<OrchestratorChildSessionRecord> = {}): OrchestratorChildSessionRecord {
	return {
		childSessionId: id,
		runId,
		rootRunId: "run-root",
		ownerModeId: "planner",
		parentSessionId: "parent-session",
		parentSessionFile: "parent.jsonl",
		requestShape: "single",
		async: true,
		context: "fresh",
		agent: "scout",
		childIndex: index,
		childKey: String(index),
		branchKey: String(index),
		status: "running",
		taskSummary: id,
		createdAt: 100 + index,
		updatedAt: 100 + index,
		...overrides,
	};
}

const formatters = {
	running: (text: string) => `{${text}}`,
	queued: (text: string) => `?${text}?`,
	complete: (text: string) => `(${text})`,
	cancelled: (text: string) => `~${text}~`,
	failed: (text: string) => `!${text}!`,
	selected: (text: string) => `[${text}]`,
};

function createController(
	runs: OrchestratorRunRecord[],
	children: OrchestratorChildSessionRecord[],
	options: {
		runMatchesSessionLineage?: (run: Pick<OrchestratorRunRecord, "parentSessionId" | "parentSessionFile">) => boolean;
		childSessionMatchesSessionLineage?: (child: Pick<OrchestratorChildSessionRecord, "parentSessionId" | "parentSessionFile">) => boolean;
	} = {},
) {
	const state = {
		listHandbacks: (): OrchestratorHandbackRecord[] => [],
		listOwnedRuns: (ownerModeId: string): OrchestratorRunRecord[] => runs.filter((record) => record.ownerModeId === ownerModeId),
		listRunsByRootRunId: (rootRunId: string): OrchestratorRunRecord[] => runs.filter((record) => (record.rootRunId ?? record.orchestratorRunId) === rootRunId),
		listChildSessionsByRootRunIds: (rootRunIds: Set<string>): OrchestratorChildSessionRecord[] => children.filter((record) => rootRunIds.has(record.rootRunId ?? record.runId)),
		updateRun: (runId: string, patch: Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined => {
			const existing = runs.find((record) => record.orchestratorRunId === runId);
			if (!existing) return undefined;
			Object.assign(existing, patch);
			return existing;
		},
	};
	return createFooterLifecycleController({
		state,
		getLatestCtx: () => null,
		findCurrentModeId: () => "planner",
		currentSessionLineage: () => undefined,
		runMatchesSessionLineage: options.runMatchesSessionLineage ?? (() => true),
		childSessionMatchesSessionLineage: options.childSessionMatchesSessionLineage ?? (() => true),
		handbackMatchesSessionLineage: () => true,
		normalizeRunOrigin: (value) => value === "user" ? "user" : "agent",
		normalizeHandbackConsumer: (value) => value === "user" ? "user" : "agent",
		isTerminal: (status) => status === "complete" || status === "failed" || status === "cancelled",
		tapController: { isActive: () => false, refresh: () => undefined },
		uiStatusKey: "subagent-orchestrator",
	});
}

describe("footer lifecycle nested tap roots", () => {
	test("includes descendant child sessions recursively under a visible root", () => {
		const runs = [
			run("run-root"),
			run("run-nested", { rootRunId: "run-root", parentRunId: "run-root", parentChildSessionId: "scout-child", agent: "worker" }),
		];
		const children = [
			child("scout-child", "run-root", 0, { agent: "scout" }),
			child("worker-child", "run-nested", 0, { agent: "worker", parentChildSessionId: "scout-child" }),
			child("reviewer-child", "run-nested", 0, { agent: "reviewer", parentChildSessionId: "worker-child" }),
		];
		const roots = createController(runs, children).buildVisibleTapRoots({} as never);

		assert.equal(roots[0]?.children[0]?.childSessionId, "scout-child");
		assert.equal(roots[0]?.children[0]?.children[0]?.childSessionId, "worker-child");
		assert.equal(roots[0]?.children[0]?.children[0]?.children[0]?.childSessionId, "reviewer-child");
		assert.equal(formatTapFooterTree(roots, {}, formatters), "● root > run 1 > {scout 1} > {worker 1} > {reviewer 1}");
	});

	test("keeps active nested runs visible when their terminal root is hidden", () => {
		const runs = [
			run("run-root", { status: "complete", terminalStatusNotifiedAt: 120 }),
			run("run-nested", { rootRunId: "run-root", parentRunId: "run-root", parentChildSessionId: "scout-child", parentSessionId: "child-session", parentSessionFile: "child.jsonl", agent: "worker" }),
		];
		const children = [
			child("scout-child", "run-root", 0, { agent: "scout" }),
			child("worker-child", "run-nested", 0, { agent: "worker", parentChildSessionId: "scout-child", parentSessionId: "child-session", parentSessionFile: "child.jsonl" }),
		];
		const roots = createController(runs, children, {
			runMatchesSessionLineage: (record) => record.parentSessionId === "parent-session",
			childSessionMatchesSessionLineage: (record) => record.parentSessionId === "parent-session",
		}).buildVisibleTapRoots({} as never);

		assert.equal(formatTapFooterTree(roots, {}, formatters), "● root > run 1 > {scout 1} > {worker 1}");
	});

	test("does not pull unrelated hidden roots into a visible root tree", () => {
		const runs = [
			run("run-root"),
			run("other-root", { launchedAt: 50, updatedAt: 50, status: "complete", terminalStatusNotifiedAt: 60 }),
		];
		const children = [
			child("scout-child", "run-root", 0, { agent: "scout" }),
			child("other-child", "other-root", 0, { rootRunId: "other-root", agent: "worker" }),
		];
		const roots = createController(runs, children).buildVisibleTapRoots({} as never);

		assert.equal(formatTapFooterTree(roots, {}, formatters), "● root > run 1 > {scout 1}");
	});
});

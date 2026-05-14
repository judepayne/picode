import type { OrchestratorChildSessionRecord, OrchestratorRunRecord, RunStatus } from "./types.ts";

export type TapDirection = "left" | "right" | "down" | "up";

export interface TapTreeNode {
	childSessionId: string;
	parentChildSessionId?: string;
	agent: string;
	childIndex: number;
	status: RunStatus;
	taskSummary: string;
	currentTool?: string;
	toolCount?: number;
	failedToolCount?: number;
	children: TapTreeNode[];
}

export interface TapRunRoot {
	id: string;
	label: string;
	kind: "run" | "user";
	rootRunId?: string;
	children: TapTreeNode[];
}

export interface TapSelection {
	rootIndex: number;
	childSessionId?: string;
}

export interface TapMoveResult {
	selection?: TapSelection;
	close?: boolean;
}

function normalizeRunOrigin(value: unknown): "agent" | "user" {
	return value === "user" ? "user" : "agent";
}

function rootRunIdForRun(run: OrchestratorRunRecord): string {
	return run.rootRunId ?? run.orchestratorRunId;
}

function rootRunIdForChild(child: OrchestratorChildSessionRecord): string {
	return child.rootRunId ?? child.runId;
}

function compareNumber(a: number, b: number): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareChildOrder(
	a: Pick<OrchestratorChildSessionRecord, "childIndex" | "stepIndex" | "taskIndex" | "createdAt" | "updatedAt">,
	b: Pick<OrchestratorChildSessionRecord, "childIndex" | "stepIndex" | "taskIndex" | "createdAt" | "updatedAt">,
): number {
	return compareNumber(a.stepIndex ?? -1, b.stepIndex ?? -1)
		|| compareNumber(a.taskIndex ?? -1, b.taskIndex ?? -1)
		|| compareNumber(a.childIndex, b.childIndex)
		|| compareNumber(a.createdAt, b.createdAt)
		|| compareNumber(a.updatedAt, b.updatedAt);
}

function sortChildren<T extends Pick<OrchestratorChildSessionRecord, "childIndex" | "stepIndex" | "taskIndex" | "createdAt" | "updatedAt">>(children: T[]): T[] {
	return [...children].sort(compareChildOrder);
}

function toTapNode(child: OrchestratorChildSessionRecord): TapTreeNode {
	return {
		childSessionId: child.childSessionId,
		...(child.parentChildSessionId ? { parentChildSessionId: child.parentChildSessionId } : {}),
		agent: child.agent,
		childIndex: child.childIndex,
		status: child.status,
		taskSummary: child.taskSummary,
		...(child.currentTool ? { currentTool: child.currentTool } : {}),
		...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
		...(child.failedToolCount !== undefined ? { failedToolCount: child.failedToolCount } : {}),
		children: [],
	};
}

function buildChildTree(children: OrchestratorChildSessionRecord[]): TapTreeNode[] {
	const nodes = new Map<string, TapTreeNode>();
	for (const child of sortChildren(children)) nodes.set(child.childSessionId, toTapNode(child));
	const roots: TapTreeNode[] = [];
	for (const child of sortChildren(children)) {
		const node = nodes.get(child.childSessionId)!;
		const parent = child.parentChildSessionId ? nodes.get(child.parentChildSessionId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

export function buildTapRoots(runs: OrchestratorRunRecord[], children: OrchestratorChildSessionRecord[]): TapRunRoot[] {
	const runByRootId = new Map<string, OrchestratorRunRecord>();
	for (const run of runs) {
		const rootId = rootRunIdForRun(run);
		const existing = runByRootId.get(rootId);
		if (!existing || run.orchestratorRunId === rootId) runByRootId.set(rootId, run);
	}

	const childrenByRootId = new Map<string, OrchestratorChildSessionRecord[]>();
	for (const child of children) {
		const rootId = rootRunIdForChild(child);
		const bucket = childrenByRootId.get(rootId) ?? [];
		bucket.push(child);
		childrenByRootId.set(rootId, bucket);
	}

	const agentRootRuns = [...runByRootId.values()]
		.filter((run) => normalizeRunOrigin(run.origin) !== "user")
		.sort((a, b) => b.launchedAt - a.launchedAt || b.updatedAt - a.updatedAt);

	const roots: TapRunRoot[] = agentRootRuns.map((run, index) => ({
		id: rootRunIdForRun(run),
		label: `run ${index + 1}`,
		kind: "run",
		rootRunId: rootRunIdForRun(run),
		children: buildChildTree(childrenByRootId.get(rootRunIdForRun(run)) ?? []),
	}));

	const userChildren = [...childrenByRootId.entries()]
		.filter(([rootId]) => normalizeRunOrigin(runByRootId.get(rootId)?.origin) === "user")
		.flatMap(([, rootChildren]) => rootChildren);
	if (userChildren.length > 0) {
		roots.push({
			id: "user",
			label: "user",
			kind: "user",
			children: buildChildTree(userChildren),
		});
	}

	return roots.filter((root) => root.children.length > 0);
}

function findNodeIn(nodes: TapTreeNode[], childSessionId: string): TapTreeNode | undefined {
	for (const node of nodes) {
		if (node.childSessionId === childSessionId) return node;
		const found = findNodeIn(node.children, childSessionId);
		if (found) return found;
	}
	return undefined;
}

function findNodeWithParentIn(nodes: TapTreeNode[], childSessionId: string, parent?: TapTreeNode): { node: TapTreeNode; parent?: TapTreeNode; siblings: TapTreeNode[] } | undefined {
	for (const node of nodes) {
		if (node.childSessionId === childSessionId) return { node, parent, siblings: nodes };
		const found = findNodeWithParentIn(node.children, childSessionId, node);
		if (found) return found;
	}
	return undefined;
}

export function selectedTapNode(roots: TapRunRoot[], selection: TapSelection): TapTreeNode | undefined {
	const root = roots[selection.rootIndex];
	if (!root || !selection.childSessionId) return undefined;
	return findNodeIn(root.children, selection.childSessionId);
}

export function normalizeTapSelection(roots: TapRunRoot[], selection: TapSelection | undefined): TapSelection | undefined {
	if (roots.length === 0) return undefined;
	const rootIndex = Math.min(Math.max(selection?.rootIndex ?? 0, 0), roots.length - 1);
	const root = roots[rootIndex]!;
	if (!selection?.childSessionId || findNodeIn(root.children, selection.childSessionId)) return { rootIndex, ...(selection?.childSessionId ? { childSessionId: selection.childSessionId } : {}) };
	return { rootIndex };
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

export function moveTapSelection(roots: TapRunRoot[], selection: TapSelection, direction: TapDirection): TapMoveResult {
	const normalized = normalizeTapSelection(roots, selection);
	if (!normalized) return {};
	const root = roots[normalized.rootIndex]!;
	if (!normalized.childSessionId) {
		if (direction === "up") return { close: true };
		if (direction === "down") {
			const first = root.children[0];
			return { selection: first ? { rootIndex: normalized.rootIndex, childSessionId: first.childSessionId } : normalized };
		}
		const delta = direction === "left" ? -1 : 1;
		return { selection: { rootIndex: wrapIndex(normalized.rootIndex + delta, roots.length) } };
	}

	const found = findNodeWithParentIn(root.children, normalized.childSessionId);
	if (!found) return { selection: { rootIndex: normalized.rootIndex } };
	if (direction === "up") {
		return { selection: found.parent ? { rootIndex: normalized.rootIndex, childSessionId: found.parent.childSessionId } : { rootIndex: normalized.rootIndex } };
	}
	if (direction === "down") {
		const first = found.node.children[0];
		return { selection: first ? { rootIndex: normalized.rootIndex, childSessionId: first.childSessionId } : normalized };
	}
	const currentIndex = found.siblings.findIndex((node) => node.childSessionId === normalized.childSessionId);
	const delta = direction === "left" ? -1 : 1;
	const next = found.siblings[wrapIndex(currentIndex + delta, found.siblings.length)];
	return { selection: next ? { rootIndex: normalized.rootIndex, childSessionId: next.childSessionId } : normalized };
}

function agentLabel(node: TapTreeNode): string {
	return `${node.agent || "subagent"} ${node.childIndex + 1}`;
}

function nodePath(nodes: TapTreeNode[], childSessionId: string, path: TapTreeNode[] = []): TapTreeNode[] | undefined {
	for (const node of nodes) {
		const nextPath = [...path, node];
		if (node.childSessionId === childSessionId) return nextPath;
		const found = nodePath(node.children, childSessionId, nextPath);
		if (found) return found;
	}
	return undefined;
}

export function formatTapCrumb(roots: TapRunRoot[], selection: TapSelection | undefined): string | undefined {
	const normalized = normalizeTapSelection(roots, selection);
	if (!normalized) return undefined;
	const root = roots[normalized.rootIndex]!;
	const parts = [root.label];
	if (normalized.childSessionId) {
		const path = nodePath(root.children, normalized.childSessionId) ?? [];
		parts.push(...path.map(agentLabel));
	}
	return `tap: ${parts.join(" > ")}`;
}

function formatFooterNode(
	node: TapTreeNode,
	selectedChildSessionId: string | undefined,
	highlight: (text: string) => string,
	dim: (text: string) => string,
	failed: (text: string) => string,
): string {
	const label = agentLabel(node);
	const displayLabel = node.childSessionId === selectedChildSessionId
		? highlight(label)
		: node.status === "failed" || (node.failedToolCount ?? 0) > 0
			? failed(label)
			: node.status === "complete"
				? dim(label)
				: label;
	if (node.children.length === 0) return displayLabel;
	return `${displayLabel} > ${node.children.map((child) => formatFooterNode(child, selectedChildSessionId, highlight, dim, failed)).join(", ")}`;
}

export function formatTapFooterTree(
	roots: TapRunRoot[],
	selection: TapSelection | undefined,
	highlight: (text: string) => string = (text) => text,
	dim: (text: string) => string = (text) => text,
	failed: (text: string) => string = (text) => text,
): string | undefined {
	const normalized = normalizeTapSelection(roots, selection);
	if (!normalized) return undefined;
	return roots.map((root, rootIndex) => {
		const rootLabel = rootIndex === normalized.rootIndex && !normalized.childSessionId ? highlight(root.label) : root.label;
		if (root.children.length === 0) return rootLabel;
		return `${rootLabel} > ${root.children.map((child) => formatFooterNode(child, normalized.childSessionId, highlight, dim, failed)).join(", ")}`;
	}).join(", ");
}

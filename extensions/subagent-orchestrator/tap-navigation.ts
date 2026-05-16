import type { OrchestratorChildSessionRecord, OrchestratorRunRecord, RequestShape, RunStatus } from "./types.ts";

export type TapDirection = "left" | "right" | "down" | "up";

export interface TapTreeNode {
	childSessionId: string;
	parentChildSessionId?: string;
	agent: string;
	childIndex: number;
	status: RunStatus;
	runStatus?: RunStatus;
	async?: boolean;
	hasStarted?: boolean;
	requestShape: RequestShape;
	taskSummary: string;
	currentTool?: string;
	toolCount?: number;
	failedToolCount?: number;
	stepIndex?: number;
	taskIndex?: number;
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
	rootIndex?: number;
	childSessionId?: string;
}

export interface TapMoveResult {
	selection?: TapSelection;
	close?: boolean;
}

export interface TapFooterFormatters {
	running: (text: string) => string;
	queued: (text: string) => string;
	complete: (text: string) => string;
	cancelled: (text: string) => string;
	failed: (text: string) => string;
	selected: (text: string) => string;
	neutral?: (text: string) => string;
	separator?: (text: string) => string;
}

export interface TapFooterFormatOptions {
	selectedMarker?: string;
}

export interface TapFooterTheme {
	bold(text: string): string;
}

export type SubagentFooterStatusColor = "queued" | "running" | "complete" | "cancelled" | "failed";
export type SubagentFooterStatusColors = Record<SubagentFooterStatusColor, string>;

export const DEFAULT_SUBAGENT_STATUS_COLORS: SubagentFooterStatusColors = {
	queued: "#f0c986",
	running: "#71e37d",
	complete: "#bababa",
	cancelled: "#874a4a",
	failed: "#FF4D4D",
};

export const DEFAULT_SUBAGENT_SEPARATOR_COLOR = "#1e69e3";
export const SUBAGENT_STATUS_COLOR_VAR_PREFIX = "footer.colors.subagentStatus";
export const SUBAGENT_SEPARATOR_COLOR_VAR = "footer.colors.subagentSeparator";

function normalizeHexColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const match = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
	return match ? `#${match[1]!.toLowerCase()}` : undefined;
}

export function resolveSubagentStatusColors(vars: Record<string, unknown> = {}): SubagentFooterStatusColors {
	return {
		queued: normalizeHexColor(vars[`${SUBAGENT_STATUS_COLOR_VAR_PREFIX}.queued`]) ?? DEFAULT_SUBAGENT_STATUS_COLORS.queued,
		running: normalizeHexColor(vars[`${SUBAGENT_STATUS_COLOR_VAR_PREFIX}.running`]) ?? DEFAULT_SUBAGENT_STATUS_COLORS.running,
		complete: normalizeHexColor(vars[`${SUBAGENT_STATUS_COLOR_VAR_PREFIX}.complete`]) ?? DEFAULT_SUBAGENT_STATUS_COLORS.complete,
		cancelled: normalizeHexColor(vars[`${SUBAGENT_STATUS_COLOR_VAR_PREFIX}.cancelled`]) ?? DEFAULT_SUBAGENT_STATUS_COLORS.cancelled,
		failed: normalizeHexColor(vars[`${SUBAGENT_STATUS_COLOR_VAR_PREFIX}.failed`]) ?? DEFAULT_SUBAGENT_STATUS_COLORS.failed,
	};
}

export function resolveSubagentSeparatorColor(vars: Record<string, unknown> = {}): string {
	return normalizeHexColor(vars[SUBAGENT_SEPARATOR_COLOR_VAR]) ?? DEFAULT_SUBAGENT_SEPARATOR_COLOR;
}

function colorizeHex(text: string, color: string): string {
	const hex = normalizeHexColor(color) ?? "#ffffff";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

export function createTapFooterFormatters(
	theme: TapFooterTheme,
	colors: SubagentFooterStatusColors = DEFAULT_SUBAGENT_STATUS_COLORS,
	separatorColor: string = DEFAULT_SUBAGENT_SEPARATOR_COLOR,
): TapFooterFormatters {
	return {
		running: (text) => colorizeHex(text, colors.running),
		queued: (text) => colorizeHex(text, colors.queued),
		complete: (text) => colorizeHex(text, colors.complete),
		cancelled: (text) => colorizeHex(text, colors.cancelled),
		failed: (text) => colorizeHex(theme.bold(text), colors.failed),
		selected: (text) => text,
		separator: (text) => colorizeHex(theme.bold(text), separatorColor),
	};
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

function toTapNode(child: OrchestratorChildSessionRecord, run: OrchestratorRunRecord | undefined): TapTreeNode {
	return {
		childSessionId: child.childSessionId,
		...(child.parentChildSessionId ? { parentChildSessionId: child.parentChildSessionId } : {}),
		agent: child.agent,
		childIndex: child.childIndex,
		status: child.status,
		...(run?.status ? { runStatus: run.status } : {}),
		async: child.async,
		...(child.underlyingRunId || child.asyncDir || child.currentTool || (child.recentOutput?.length ?? 0) > 0 ? { hasStarted: true } : {}),
		requestShape: child.requestShape,
		taskSummary: child.taskSummary,
		...(child.currentTool ? { currentTool: child.currentTool } : {}),
		...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
		...(child.failedToolCount !== undefined ? { failedToolCount: child.failedToolCount } : {}),
		...(child.stepIndex !== undefined ? { stepIndex: child.stepIndex } : {}),
		...(child.taskIndex !== undefined ? { taskIndex: child.taskIndex } : {}),
		children: [],
	};
}

function buildChildTree(children: OrchestratorChildSessionRecord[], runsById: Map<string, OrchestratorRunRecord>): TapTreeNode[] {
	const nodes = new Map<string, TapTreeNode>();
	for (const child of sortChildren(children)) nodes.set(child.childSessionId, toTapNode(child, runsById.get(child.runId)));
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

	const runsById = new Map(runs.map((run) => [run.orchestratorRunId, run]));
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
		children: buildChildTree(childrenByRootId.get(rootRunIdForRun(run)) ?? [], runsById),
	}));

	const userChildren = [...childrenByRootId.entries()]
		.filter(([rootId]) => normalizeRunOrigin(runByRootId.get(rootId)?.origin) === "user")
		.flatMap(([, rootChildren]) => rootChildren);
	if (userChildren.length > 0) {
		roots.push({
			id: "user",
			label: "user",
			kind: "user",
			children: buildChildTree(userChildren, runsById),
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
	if (selection.rootIndex === undefined) return undefined;
	const root = roots[selection.rootIndex];
	if (!root || !selection.childSessionId) return undefined;
	return findNodeIn(root.children, selection.childSessionId);
}

export function normalizeTapSelection(roots: TapRunRoot[], selection: TapSelection | undefined): TapSelection | undefined {
	if (roots.length === 0) return undefined;
	if (selection?.rootIndex === undefined) return {};
	const rootIndex = Math.min(Math.max(selection.rootIndex, 0), roots.length - 1);
	const root = roots[rootIndex]!;
	if (!selection.childSessionId || findNodeIn(root.children, selection.childSessionId)) return { rootIndex, ...(selection.childSessionId ? { childSessionId: selection.childSessionId } : {}) };
	return { rootIndex };
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

export function moveTapSelection(roots: TapRunRoot[], selection: TapSelection, direction: TapDirection): TapMoveResult {
	const normalized = normalizeTapSelection(roots, selection);
	if (!normalized) return {};
	if (normalized.rootIndex === undefined) {
		if (direction === "up") return { close: true };
		if (direction === "down") return { selection: { rootIndex: 0 } };
		const rootIndex = direction === "left" ? roots.length - 1 : 0;
		return { selection: { rootIndex } };
	}
	const root = roots[normalized.rootIndex]!;
	if (!normalized.childSessionId) {
		if (direction === "up") return { selection: {} };
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
	if (normalized.rootIndex === undefined) return "tap: root";
	const root = roots[normalized.rootIndex]!;
	const parts = ["root", root.label];
	if (normalized.childSessionId) {
		const path = nodePath(root.children, normalized.childSessionId) ?? [];
		parts.push(...path.map(agentLabel));
	}
	return `tap: ${parts.join(" > ")}`;
}

function effectiveFooterStatus(node: TapTreeNode): RunStatus {
	if (node.status === "queued" && node.async && node.requestShape !== "chain" && (node.runStatus === "running" || node.hasStarted)) return "running";
	return node.status;
}

function styleNodeLabel(node: TapTreeNode, selected: boolean, formatters: TapFooterFormatters, options: TapFooterFormatOptions): string {
	const marker = selected ? options.selectedMarker ?? "● " : "";
	const label = `${marker}${agentLabel(node)}`;
	const status = effectiveFooterStatus(node);
	const statusStyled = status === "failed"
		? formatters.failed(label)
		: status === "complete"
			? formatters.complete(label)
			: status === "cancelled"
				? formatters.cancelled(label)
				: status === "queued"
					? formatters.queued(label)
					: formatters.running(label);
	return selected ? formatters.selected(statusStyled) : statusStyled;
}

function footerChildSeparator(nodes: TapTreeNode[]): string {
	if (nodes.length < 2) return ", ";
	const chainSteps = nodes
		.filter((node) => node.requestShape === "chain" && node.stepIndex !== undefined)
		.map((node) => node.stepIndex!);
	const uniqueSteps = new Set(chainSteps);
	return chainSteps.length === nodes.length && uniqueSteps.size === nodes.length ? " → " : ", ";
}

function formatFooterNode(
	node: TapTreeNode,
	selectedChildSessionId: string | undefined,
	formatters: TapFooterFormatters,
	options: TapFooterFormatOptions,
): string {
	const displayLabel = styleNodeLabel(node, node.childSessionId === selectedChildSessionId, formatters, options);
	if (node.children.length === 0) return displayLabel;
	return `${displayLabel} > ${node.children.map((child) => formatFooterNode(child, selectedChildSessionId, formatters, options)).join(footerChildSeparator(node.children))}`;
}

function compactRootLabel(root: TapRunRoot): string {
	const match = /^run\s+(\d+)$/i.exec(root.label.trim());
	return root.kind === "run" && match ? `r${match[1]}` : root.label;
}

function formatRootLabel(root: TapRunRoot, selected: boolean, formatters: TapFooterFormatters, options: TapFooterFormatOptions): string {
	const label = `${selected ? options.selectedMarker ?? "● " : ""}${compactRootLabel(root)}`;
	return selected ? formatters.selected(formatters.neutral?.(label) ?? label) : formatters.neutral?.(label) ?? label;
}

export function formatTapFooterTree(
	roots: TapRunRoot[],
	selection: TapSelection | undefined,
	formatters: TapFooterFormatters,
	options: TapFooterFormatOptions = {},
): string | undefined {
	const normalized = normalizeTapSelection(roots, selection);
	if (!normalized) return undefined;
	const selectedRootIndex = normalized.rootIndex;
	const rootLabel = normalized.rootIndex === undefined ? `${options.selectedMarker ?? "● "}root` : "root";
	const rootSeparator = ` ${formatters.separator?.("|") ?? "|"} `;
	const tree = roots.map((root, rootIndex) => {
		const label = formatRootLabel(root, rootIndex === selectedRootIndex && !normalized.childSessionId, formatters, options);
		if (root.children.length === 0) return label;
		return `${label} > ${root.children.map((child) => formatFooterNode(child, normalized.childSessionId, formatters, options)).join(footerChildSeparator(root.children))}`;
	}).join(rootSeparator);
	return `${formatters.neutral?.(rootLabel) ?? rootLabel} > ${tree}`;
}

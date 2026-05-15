import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildPromptVars } from "../z-prompt-vars/prompt-vars.ts";
import { buildTapRoots, createTapFooterFormatters, formatTapFooterTree, resolveSubagentStatusColors, type TapRunRoot } from "./tap-navigation.ts";
import type { OrchestratorChildSessionRecord, OrchestratorHandbackRecord, OrchestratorRunRecord, RunOrigin } from "./types.ts";

export interface FooterLifecycleTapController {
	isActive(): boolean;
	refresh(): void;
}

export interface FooterLifecycleState {
	listHandbacks(): OrchestratorHandbackRecord[];
	listOwnedRuns(ownerModeId: string): OrchestratorRunRecord[];
	listChildSessionsByRootRunIds(rootRunIds: Set<string>): OrchestratorChildSessionRecord[];
	updateRun(runId: string, patch: Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
}

export interface FooterLifecycleInput<Lineage> {
	state: FooterLifecycleState;
	getLatestCtx(): ExtensionContext | null;
	findCurrentModeId(ctx: ExtensionContext): string | undefined;
	currentSessionLineage(ctx: ExtensionContext): Lineage;
	runMatchesSessionLineage(run: Pick<OrchestratorRunRecord, "parentSessionId" | "parentSessionFile">, lineage: Lineage): boolean;
	childSessionMatchesSessionLineage(child: Pick<OrchestratorChildSessionRecord, "parentSessionId" | "parentSessionFile">, lineage: Lineage): boolean;
	handbackMatchesSessionLineage(handback: Pick<OrchestratorHandbackRecord, "parentSessionId">, lineage: Lineage): boolean;
	normalizeRunOrigin(value: unknown): RunOrigin;
	normalizeHandbackConsumer(value: unknown): "agent" | "user";
	isTerminal(status: OrchestratorRunRecord["status"]): boolean;
	tapController: FooterLifecycleTapController;
	uiStatusKey: string;
}

export interface FooterLifecycleVisibility<Lineage> {
	ownerModeId: string;
	lineage: Lineage;
	runs: OrchestratorRunRecord[];
	queuedHandbacks: OrchestratorHandbackRecord[];
}

export interface FooterLifecycleController<Lineage> {
	buildFooterLifecycleVisibility(ctx?: ExtensionContext | null, options?: { includeUserRuns?: boolean }): FooterLifecycleVisibility<Lineage> | undefined;
	buildVisibleTapRoots(ctx?: ExtensionContext | null, options?: { includeUserRuns?: boolean }): TapRunRoot[];
	applyUiStatus(ctx?: ExtensionContext | null): void;
	updateUiStatus(ctx?: ExtensionContext | null, immediate?: boolean): void;
	acknowledgeVisibleTerminalRuns(ctx?: ExtensionContext | null): void;
	clearUiStatusTimer(): void;
	resetLastUiStatusText(): void;
}

export function createFooterLifecycleController<Lineage>(input: FooterLifecycleInput<Lineage>): FooterLifecycleController<Lineage> {
	let uiStatusTimer: ReturnType<typeof setTimeout> | null = null;
	let lastUiStatusText: string | undefined;

	function clearUiStatusTimer(): void {
		if (!uiStatusTimer) return;
		clearTimeout(uiStatusTimer);
		uiStatusTimer = null;
	}

	function buildFooterLifecycleVisibility(ctx?: ExtensionContext | null, options?: { includeUserRuns?: boolean }): FooterLifecycleVisibility<Lineage> | undefined {
		const runtimeCtx = ctx ?? input.getLatestCtx();
		if (!runtimeCtx) return undefined;
		const ownerModeId = input.findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return undefined;
		const lineage = input.currentSessionLineage(runtimeCtx);
		const queuedHandbacks = input.state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& input.handbackMatchesSessionLineage(record, lineage)
			&& input.normalizeHandbackConsumer(record.consumer) !== "user"
		);
		const queuedHandbackRunIds = new Set(queuedHandbacks.map((record) => record.runId));
		const runs = input.state.listOwnedRuns(ownerModeId)
			.filter((run) => input.runMatchesSessionLineage(run, lineage))
			.filter((run) => options?.includeUserRuns === true || input.normalizeRunOrigin(run.origin) !== "user")
			.filter((run) =>
				!input.isTerminal(run.status)
				|| queuedHandbackRunIds.has(run.orchestratorRunId)
				|| run.terminalStatusNotifiedAt === undefined
				|| (run.status === "failed" && run.failureAcknowledgedAt === undefined)
			);
		return { ownerModeId, lineage, runs, queuedHandbacks };
	}

	function buildVisibleTapRoots(ctx?: ExtensionContext | null, options?: { includeUserRuns?: boolean }): TapRunRoot[] {
		const visibility = buildFooterLifecycleVisibility(ctx, options);
		if (!visibility) return [];
		const rootRunIds = new Set(visibility.runs.map((run) => run.rootRunId ?? run.orchestratorRunId));
		const children = input.state.listChildSessionsByRootRunIds(rootRunIds)
			.filter((child) => child.ownerModeId === visibility.ownerModeId)
			.filter((child) => input.childSessionMatchesSessionLineage(child, visibility.lineage));
		return buildTapRoots(visibility.runs, children);
	}

	function applyUiStatus(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? input.getLatestCtx();
		if (!runtimeCtx?.hasUI) return;
		if (input.tapController.isActive()) {
			input.tapController.refresh();
			return;
		}
		const roots = buildVisibleTapRoots(runtimeCtx, { includeUserRuns: true });
		const statusColors = resolveSubagentStatusColors(buildPromptVars(runtimeCtx.cwd).storedVars);
		const statusText = formatTapFooterTree(
			roots,
			{},
			createTapFooterFormatters(runtimeCtx.ui.theme, statusColors),
			{},
		);
		if (statusText !== lastUiStatusText) {
			runtimeCtx.ui.setStatus(input.uiStatusKey, statusText);
			lastUiStatusText = statusText;
		}
	}

	function updateUiStatus(ctx?: ExtensionContext | null, immediate = false): void {
		if (immediate) {
			clearUiStatusTimer();
			applyUiStatus(ctx);
			return;
		}
		clearUiStatusTimer();
		uiStatusTimer = setTimeout(() => {
			uiStatusTimer = null;
			applyUiStatus(ctx);
		}, 75);
		uiStatusTimer.unref?.();
	}

	function acknowledgeVisibleTerminalRuns(ctx?: ExtensionContext | null): void {
		const visibility = buildFooterLifecycleVisibility(ctx, { includeUserRuns: true });
		if (!visibility) return;
		const now = Date.now();
		for (const run of visibility.runs) {
			if (!input.isTerminal(run.status)) continue;
			input.state.updateRun(run.orchestratorRunId, {
				...(run.terminalStatusNotifiedAt === undefined ? { terminalStatusNotifiedAt: now } : {}),
				...(run.status === "failed" && run.failureAcknowledgedAt === undefined ? { failureAcknowledgedAt: now } : {}),
				updatedAt: now,
			});
		}
	}

	return {
		buildFooterLifecycleVisibility,
		buildVisibleTapRoots,
		applyUiStatus,
		updateUiStatus,
		acknowledgeVisibleTerminalRuns,
		clearUiStatusTimer,
		resetLastUiStatusText: () => { lastUiStatusText = undefined; },
	};
}

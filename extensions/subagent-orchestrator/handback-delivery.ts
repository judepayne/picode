import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildHandbackDeduplicationKey, buildQueuedHandback, partitionHandbackDuplicates } from "./handbacks.ts";
import { buildContinuationEntry, buildHandbackEntry, ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE, ORCHESTRATOR_HANDBACK_ENTRY_TYPE } from "./session-entries.ts";
import type { AsyncCompleteEvent, OrchestratorChildSessionRecord, OrchestratorContinuationMessageDetails, OrchestratorContinuationRecord, OrchestratorHandbackRecord, OrchestratorRunRecord } from "./types.ts";

export interface HandbackDeliveryState {
	listChildSessionsByRun(runId: string): OrchestratorChildSessionRecord[];
	listHandbacks(): OrchestratorHandbackRecord[];
	listHandbacksByRun(runId: string): OrchestratorHandbackRecord[];
	markHandbackConsumed(handbackId: string, consumedAt: number): OrchestratorHandbackRecord | undefined;
	markHandbackDismissed(handbackId: string, dismissedAt: number): OrchestratorHandbackRecord | undefined;
	createHandback(input: OrchestratorHandbackRecord): OrchestratorHandbackRecord;
	createContinuation(input: OrchestratorContinuationRecord): OrchestratorContinuationRecord;
	listContinuations(): OrchestratorContinuationRecord[];
	updateContinuation(continuationId: string, patch: Partial<OrchestratorContinuationRecord>): OrchestratorContinuationRecord | undefined;
}

export interface HandbackDeliveryInput<Lineage> {
	pi: ExtensionAPI;
	state: HandbackDeliveryState;
	getLatestCtx(): ExtensionContext | null;
	findCurrentModeId(ctx: ExtensionContext): string | undefined;
	currentSessionLineage(ctx: ExtensionContext): Lineage;
	handbackMatchesSessionLineage(handback: Pick<OrchestratorHandbackRecord, "parentSessionId">, lineage: Lineage): boolean;
	normalizeHandbackConsumer(value: unknown): "agent" | "user";
	refreshRunAggregates(runId: string): void;
	onDeliveryError?(error: unknown): void;
}

export interface HandbackDeliveryController {
	queueHandback(run: OrchestratorRunRecord, event: AsyncCompleteEvent): OrchestratorHandbackRecord | undefined;
	flushQueuedHandbacks(ctx?: ExtensionContext | null, options?: { forceAgentDelivery?: boolean }): void;
	reconcileDuplicateHandbacks(ctx?: ExtensionContext | null): void;
	consumeQueuedHandbacksForRun(runId: string, consumedAt?: number): void;
	clearQueuedHandbackFlushTimer(): void;
	scheduleQueuedHandbackFlush(delayMs?: number, attemptsRemaining?: number): void;
}

export function createHandbackDeliveryController<Lineage>(input: HandbackDeliveryInput<Lineage>): HandbackDeliveryController {
	let queuedHandbackFlushTimer: ReturnType<typeof setTimeout> | null = null;

	function clearQueuedHandbackFlushTimer(): void {
		if (!queuedHandbackFlushTimer) return;
		clearTimeout(queuedHandbackFlushTimer);
		queuedHandbackFlushTimer = null;
	}

	function queuedHandbackCountForContext(ctx?: ExtensionContext | null): number {
		const runtimeCtx = ctx ?? input.getLatestCtx();
		if (!runtimeCtx) return 0;
		const ownerModeId = input.findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return 0;
		const lineage = input.currentSessionLineage(runtimeCtx);
		return input.state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& input.handbackMatchesSessionLineage(record, lineage)
		).length;
	}

	function scheduleQueuedHandbackFlush(delayMs = 250, attemptsRemaining = 20): void {
		clearQueuedHandbackFlushTimer();
		queuedHandbackFlushTimer = setTimeout(() => {
			queuedHandbackFlushTimer = null;
			try {
				const queuedBeforeFlush = queuedHandbackCountForContext();
				if (queuedBeforeFlush === 0) return;
				reconcileDuplicateHandbacks(input.getLatestCtx());
				flushQueuedHandbacks(input.getLatestCtx());
				if (queuedHandbackCountForContext() > 0 && attemptsRemaining > 1) {
					scheduleQueuedHandbackFlush(Math.min(delayMs * 2, 1000), attemptsRemaining - 1);
				}
			} catch (error) {
				input.onDeliveryError?.(error);
				if (attemptsRemaining > 1) scheduleQueuedHandbackFlush(Math.min(delayMs * 2, 1000), attemptsRemaining - 1);
			}
		}, delayMs);
		queuedHandbackFlushTimer.unref?.();
	}

	function reconcileDuplicateHandbacks(ctx?: ExtensionContext | null): void {
		const runtimeCtx = ctx ?? input.getLatestCtx();
		if (!runtimeCtx) return;
		const ownerModeId = input.findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return;
		const lineage = input.currentSessionLineage(runtimeCtx);
		const activeHandbacks = input.state.listHandbacks().filter((record) =>
			record.ownerModeId === ownerModeId
			&& record.status !== "dismissed"
			&& input.handbackMatchesSessionLineage(record, lineage)
		);
		const { duplicates } = partitionHandbackDuplicates(activeHandbacks);
		if (duplicates.length === 0) return;
		const now = Date.now();
		for (const duplicate of duplicates) {
			input.state.markHandbackDismissed(duplicate.handbackId, now);
			input.refreshRunAggregates(duplicate.runId);
		}
	}

	function formatAgentVisibleContinuationContent(content: string): string {
		return `Summary result of delegated run:\n\n${content}`;
	}

	function formatAgentHiddenContinuationContent(content: string): string {
		return `Orchestrator async completion trigger for the pending delegated request. Answer using this result directly.\n\n${formatAgentVisibleContinuationContent(content)}`;
	}

	function formatUserHiddenContinuationContent(agent: string | undefined, content: string): string {
		const source = agent ?? "subagent";
		return (
			`Background user-addressed exchange from ${source}. `
			+ "This is provided for context only. It is not a user request to comment on, summarize, or act on unless the user later refers to it."
			+ `\n\n${content}`
		);
	}

	function buildContinuationDetails(
		continuation: OrchestratorContinuationRecord,
		handbacks: OrchestratorHandbackRecord[],
	): OrchestratorContinuationMessageDetails {
		return {
			continuationId: continuation.continuationId,
			handbackIds: continuation.handbackIds,
			childCount: handbacks.reduce((total, entry) => total + entry.childSessionIds.length, 0),
			runIds: [...new Set(handbacks.map((entry) => entry.runId))],
			consumer: continuation.consumer,
			...(continuation.agent ? { agent: continuation.agent } : {}),
		};
	}

	function createContinuationRecord(
		parentSessionId: string,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): OrchestratorContinuationRecord {
		const handbackIds = handbacks.map((entry) => entry.handbackId);
		const existing = input.state.listContinuations().find((continuation) =>
			continuation.status === "queued"
			&& continuation.handbackIds.length === handbackIds.length
			&& continuation.handbackIds.every((id, index) => id === handbackIds[index])
		);
		if (existing) return existing;
		const first = handbacks[0];
		return input.state.createContinuation({
			continuationId: randomUUID(),
			parentSessionId,
			ownerModeId,
			handbackIds,
			consumer: input.normalizeHandbackConsumer(first?.consumer),
			...(first?.agent ? { agent: first.agent } : {}),
			status: "queued",
			content: handbacks.map((entry) => entry.content).join("\n\n---\n\n"),
			createdAt: now,
			updatedAt: now,
		});
	}

	function markContinuationLaunched(continuation: OrchestratorContinuationRecord, launchedAt: number): OrchestratorContinuationRecord {
		return input.state.updateContinuation(continuation.continuationId, { status: "launched", updatedAt: launchedAt, launchedAt })
			?? { ...continuation, status: "launched", updatedAt: launchedAt, launchedAt };
	}

	function consumeHandbacks(handbacks: OrchestratorHandbackRecord[], consumedAt: number): void {
		for (const handback of handbacks) {
			input.state.markHandbackConsumed(handback.handbackId, consumedAt);
			input.refreshRunAggregates(handback.runId);
		}
	}

	function consumeQueuedHandbacksForRun(runId: string, consumedAt = Date.now()): void {
		for (const handback of input.state.listHandbacksByRun(runId).filter((entry) => entry.status === "queued")) {
			input.state.markHandbackConsumed(handback.handbackId, consumedAt);
		}
		input.refreshRunAggregates(runId);
	}

	function sendDeferredCustomMessage(
		runtimeCtx: ExtensionContext,
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: OrchestratorContinuationMessageDetails;
		},
	): void {
		if (runtimeCtx.isIdle() && !runtimeCtx.hasPendingMessages()) {
			input.pi.sendMessage(message, { triggerTurn: false });
			return;
		}
		input.pi.sendMessage(message, { triggerTurn: false, deliverAs: "followUp" });
	}

	function deliverUserHandbacks(
		runtimeCtx: ExtensionContext,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): void {
		for (const handback of handbacks) {
			const queuedContinuation = createContinuationRecord(handback.parentSessionId, ownerModeId, [handback], now);
			const continuation = { ...queuedContinuation, status: "launched" as const, updatedAt: now, launchedAt: now };
			input.pi.appendEntry(ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, buildContinuationEntry(continuation));
			const details = buildContinuationDetails(continuation, [handback]);
			sendDeferredCustomMessage(runtimeCtx, {
				customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
				content: continuation.content,
				display: true,
				details,
			});
			sendDeferredCustomMessage(runtimeCtx, {
				customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
				content: formatUserHiddenContinuationContent(continuation.agent, continuation.content),
				display: false,
				details,
			});
			markContinuationLaunched(queuedContinuation, now);
			consumeHandbacks([handback], now);
		}
	}

	function deliverAgentHandbacks(
		parentSessionId: string,
		ownerModeId: string,
		handbacks: OrchestratorHandbackRecord[],
		now: number,
	): void {
		if (handbacks.length === 0) return;
		const queuedContinuation = createContinuationRecord(parentSessionId, ownerModeId, handbacks, now);
		const continuation = { ...queuedContinuation, status: "launched" as const, updatedAt: now, launchedAt: now };
		input.pi.appendEntry(ORCHESTRATOR_CONTINUATION_ENTRY_TYPE, buildContinuationEntry(continuation));
		const details = buildContinuationDetails(continuation, handbacks);
		input.pi.sendMessage({
			customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
			content: formatAgentVisibleContinuationContent(continuation.content),
			display: true,
			details,
		}, { triggerTurn: false });
		input.pi.sendMessage({
			customType: ORCHESTRATOR_CONTINUATION_MESSAGE_TYPE,
			content: formatAgentHiddenContinuationContent(continuation.content),
			display: false,
			details,
		}, { triggerTurn: true });
		markContinuationLaunched(queuedContinuation, now);
		consumeHandbacks(handbacks, now);
	}

	function queueHandback(run: OrchestratorRunRecord, event: AsyncCompleteEvent): OrchestratorHandbackRecord | undefined {
		const now = Date.now();
		const children = input.state.listChildSessionsByRun(run.orchestratorRunId);
		const handback = buildQueuedHandback(run, children, event, now);
		if (!handback) return undefined;
		const dedupeKey = buildHandbackDeduplicationKey(handback);
		const existing = input.state.listHandbacksByRun(run.orchestratorRunId)
			.find((entry) => buildHandbackDeduplicationKey(entry) === dedupeKey && entry.status !== "dismissed");
		if (existing) {
			input.refreshRunAggregates(run.orchestratorRunId);
			scheduleQueuedHandbackFlush();
			return existing;
		}
		const created = input.state.createHandback(handback);
		input.pi.appendEntry(ORCHESTRATOR_HANDBACK_ENTRY_TYPE, buildHandbackEntry(created));
		input.refreshRunAggregates(run.orchestratorRunId);
		scheduleQueuedHandbackFlush();
		return created;
	}

	function flushQueuedHandbacks(ctx?: ExtensionContext | null, options?: { forceAgentDelivery?: boolean }): void {
		const runtimeCtx = ctx ?? input.getLatestCtx();
		if (!runtimeCtx) return;
		const ownerModeId = input.findCurrentModeId(runtimeCtx);
		if (!ownerModeId) return;
		const lineage = input.currentSessionLineage(runtimeCtx);
		const queued = input.state.listHandbacks().filter((record) =>
			record.status === "queued"
			&& record.ownerModeId === ownerModeId
			&& input.handbackMatchesSessionLineage(record, lineage)
		);
		if (queued.length === 0) return;
		const now = Date.now();
		const { unique, duplicates } = partitionHandbackDuplicates(queued);
		for (const duplicate of duplicates) {
			input.state.markHandbackDismissed(duplicate.handbackId, now);
			input.refreshRunAggregates(duplicate.runId);
		}
		if (unique.length === 0) return;
		const userHandbacks = unique.filter((entry) => input.normalizeHandbackConsumer(entry.consumer) === "user");
		if (userHandbacks.length > 0) {
			deliverUserHandbacks(runtimeCtx, ownerModeId, userHandbacks, now);
		}
		const agentHandbacks = unique.filter((entry) => input.normalizeHandbackConsumer(entry.consumer) !== "user");
		if (agentHandbacks.length === 0) return;
		if (!options?.forceAgentDelivery && (!runtimeCtx.isIdle() || runtimeCtx.hasPendingMessages())) return;
		const agentHandbacksBySession = new Map<string, OrchestratorHandbackRecord[]>();
		for (const handback of agentHandbacks) {
			const sessionKey = handback.parentSessionId || "unknown-session";
			const existing = agentHandbacksBySession.get(sessionKey) ?? [];
			existing.push(handback);
			agentHandbacksBySession.set(sessionKey, existing);
		}
		for (const [parentSessionId, handbacks] of agentHandbacksBySession) {
			deliverAgentHandbacks(parentSessionId, ownerModeId, handbacks, now);
		}
	}

	return {
		queueHandback,
		flushQueuedHandbacks,
		reconcileDuplicateHandbacks,
		consumeQueuedHandbacksForRun,
		clearQueuedHandbackFlushTimer,
		scheduleQueuedHandbackFlush,
	};
}

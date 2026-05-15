import * as fs from "node:fs";
import * as path from "node:path";

import type { LoggedChildEvent } from "./event-handlers.ts";
import type { OrchestratorRunRecord, RunStatus } from "./types.ts";

const ASYNC_EVENT_TAIL_INTERVAL_MS = 250;
const ASYNC_EVENT_TAIL_MAX_LINES = 100;
const ASYNC_EVENT_TAIL_MAX_BYTES = 64 * 1024;
const ASYNC_EVENT_TAIL_MAX_LINE_BYTES = 2 * 1024 * 1024;

export interface AsyncEventManagerState {
	getRun(runId: string): OrchestratorRunRecord | undefined;
	updateRun(runId: string, patch: Partial<OrchestratorRunRecord>): OrchestratorRunRecord | undefined;
}

export interface AsyncEventManagerInput {
	state: AsyncEventManagerState;
	handleChildEvent(runId: string, event: LoggedChildEvent, appendEntryOnUpdate?: boolean): void;
	warnDroppedChildEvent(runId: string, event: LoggedChildEvent, reason: string): void;
	warnDiagnostic(message: string, error?: unknown): void;
	isTerminal(status: RunStatus): boolean;
}

export interface AsyncEventManager {
	ingestAsyncEventLines(run: OrchestratorRunRecord, options?: { maxBytes?: number; maxLines?: number }): { advanced: boolean; processedLines: number; hasMore: boolean };
	startAsyncEventTailer(run: OrchestratorRunRecord | undefined): void;
	stopAsyncEventTailer(runId: string): void;
	stopAllAsyncEventTailers(): void;
	hasAsyncEventTailer(runId: string): boolean;
}

export function createAsyncEventManager(input: AsyncEventManagerInput): AsyncEventManager {
	const asyncEventTailers = new Map<string, ReturnType<typeof setInterval>>();

	function ingestAsyncEventLines(run: OrchestratorRunRecord, options?: { maxBytes?: number; maxLines?: number }): { advanced: boolean; processedLines: number; hasMore: boolean } {
		if (!run.asyncDir) return { advanced: false, processedLines: 0, hasMore: false };
		const eventsPath = path.join(run.asyncDir, "events.jsonl");
		if (!fs.existsSync(eventsPath)) return { advanced: false, processedLines: 0, hasMore: false };
		const size = fs.statSync(eventsPath).size;
		let cursor = run.asyncEventCursor ?? 0;
		if (cursor > size) cursor = 0;
		if (cursor >= size) return { advanced: false, processedLines: 0, hasMore: false };
		const unreadBytes = size - cursor;
		const bytesToRead = Math.min(unreadBytes, options?.maxBytes ?? unreadBytes);
		const buffer = Buffer.alloc(bytesToRead);
		const fd = fs.openSync(eventsPath, "r");
		let bytesRead = 0;
		try {
			while (bytesRead < buffer.length) {
				const read = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, cursor + bytesRead);
				if (read === 0) break;
				bytesRead += read;
			}
		} finally {
			fs.closeSync(fd);
		}
		let readableBuffer = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
		if (readableBuffer.length === 0) return { advanced: false, processedLines: 0, hasMore: cursor < size };
		if (readableBuffer.indexOf(0x0a) < 0 && cursor + readableBuffer.length < size) {
			const chunks: Buffer[] = [readableBuffer];
			let storedBytes = readableBuffer.length;
			let scannedBytes = readableBuffer.length;
			let oversized = storedBytes > ASYNC_EVENT_TAIL_MAX_LINE_BYTES;
			let newlineOffset: number | undefined;
			const scanFd = fs.openSync(eventsPath, "r");
			try {
				while (cursor + scannedBytes < size) {
					const chunkSize = Math.min(ASYNC_EVENT_TAIL_MAX_BYTES, size - cursor - scannedBytes);
					const chunk = Buffer.alloc(chunkSize);
					const read = fs.readSync(scanFd, chunk, 0, chunk.length, cursor + scannedBytes);
					if (read === 0) break;
					const scannedChunk = read === chunk.length ? chunk : chunk.subarray(0, read);
					const newlineInChunk = scannedChunk.indexOf(0x0a);
					if (!oversized && storedBytes + scannedChunk.length <= ASYNC_EVENT_TAIL_MAX_LINE_BYTES) {
						chunks.push(scannedChunk);
						storedBytes += scannedChunk.length;
					} else {
						oversized = true;
					}
					scannedBytes += scannedChunk.length;
					if (newlineInChunk >= 0) {
						newlineOffset = scannedBytes - scannedChunk.length + newlineInChunk;
						break;
					}
				}
			} finally {
				fs.closeSync(scanFd);
			}
			if (oversized) {
				const advance = newlineOffset !== undefined ? newlineOffset + 1 : scannedBytes;
				input.warnDroppedChildEvent(run.orchestratorRunId, { type: "unknown" }, "skipped oversized async event line");
				input.state.updateRun(run.orchestratorRunId, { asyncEventCursor: cursor + advance, updatedAt: Date.now() });
				return { advanced: advance > 0, processedLines: 1, hasMore: cursor + advance < size };
			}
			readableBuffer = Buffer.concat(chunks, storedBytes);
		}
		let offset = 0;
		let processedLines = 0;
		const maxLines = options?.maxLines ?? Number.POSITIVE_INFINITY;
		while (offset < readableBuffer.length && processedLines < maxLines) {
			const newlineIndex = readableBuffer.indexOf(0x0a, offset);
			if (newlineIndex < 0) break;
			const rawLine = readableBuffer.subarray(offset, newlineIndex).toString("utf8").trim();
			if (!rawLine) {
				offset = newlineIndex + 1;
				continue;
			}
			processedLines += 1;
			let event: LoggedChildEvent;
			try {
				event = JSON.parse(rawLine) as LoggedChildEvent;
			} catch {
				input.warnDroppedChildEvent(run.orchestratorRunId, { type: "unknown" }, "encountered malformed async event line");
				offset = newlineIndex + 1;
				continue;
			}
			if (typeof event.type !== "string") {
				input.warnDroppedChildEvent(run.orchestratorRunId, event, "missing event type");
				offset = newlineIndex + 1;
				continue;
			}
			if (event.type.startsWith("subagent:mode:child.")) {
				input.handleChildEvent(run.orchestratorRunId, event, false);
			}
			offset = newlineIndex + 1;
		}
		const nextCursor = cursor + offset;
		if (offset > 0 || cursor !== (run.asyncEventCursor ?? 0)) {
			input.state.updateRun(run.orchestratorRunId, { asyncEventCursor: nextCursor, updatedAt: Date.now() });
		}
		return { advanced: nextCursor !== (run.asyncEventCursor ?? 0), processedLines, hasMore: nextCursor < size };
	}

	function stopAsyncEventTailer(runId: string): void {
		const timer = asyncEventTailers.get(runId);
		if (!timer) return;
		clearInterval(timer);
		asyncEventTailers.delete(runId);
	}

	function stopAllAsyncEventTailers(): void {
		for (const runId of asyncEventTailers.keys()) stopAsyncEventTailer(runId);
	}

	function tailAsyncRunEvents(runId: string): void {
		try {
			const run = input.state.getRun(runId);
			if (!run || !run.async || !run.asyncDir) {
				stopAsyncEventTailer(runId);
				return;
			}
			const result = ingestAsyncEventLines(run, { maxBytes: ASYNC_EVENT_TAIL_MAX_BYTES, maxLines: ASYNC_EVENT_TAIL_MAX_LINES });
			const latest = input.state.getRun(runId) ?? run;
			if (input.isTerminal(latest.status) && !result.hasMore) stopAsyncEventTailer(runId);
		} catch (error) {
			input.warnDiagnostic(`async event tailer failed for run ${runId}`, error);
			stopAsyncEventTailer(runId);
		}
	}

	function startAsyncEventTailer(run: OrchestratorRunRecord | undefined): void {
		if (!run || !run.async || !run.asyncDir || input.isTerminal(run.status) || asyncEventTailers.has(run.orchestratorRunId)) return;
		const timer = setInterval(() => tailAsyncRunEvents(run.orchestratorRunId), ASYNC_EVENT_TAIL_INTERVAL_MS);
		timer.unref?.();
		asyncEventTailers.set(run.orchestratorRunId, timer);
		tailAsyncRunEvents(run.orchestratorRunId);
	}

	return {
		ingestAsyncEventLines,
		startAsyncEventTailer,
		stopAsyncEventTailer,
		stopAllAsyncEventTailers,
		hasAsyncEventTailer: (runId) => asyncEventTailers.has(runId),
	};
}

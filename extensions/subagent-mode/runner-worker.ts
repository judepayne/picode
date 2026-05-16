import { parentPort } from "node:worker_threads";

import { appendChildNodeLogRecord } from "./node-log-writer.ts";
import { runChildInProcess } from "./runner-core.ts";
import {
	isControlPlaneChildEvent,
	type RunnerWorkerMainMessage,
	type RunnerWorkerParentMessage,
} from "./runner-worker-protocol.ts";
import type { ChildEvent, ChildNodeLogWriteConfig } from "./types.ts";

if (!parentPort) {
	throw new Error("runner-worker must be started as a worker thread");
}

const port = parentPort;
let controller: AbortController | undefined;
let pendingCancelReason: string | undefined;
let running = false;
let loggedNodeLogFailure = false;

function post(message: RunnerWorkerParentMessage): void {
	port.postMessage(message);
}

function serializeError(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) return { message: error.message, stack: error.stack };
	return { message: String(error) };
}

function writeNodeLog(config: ChildNodeLogWriteConfig | undefined, event: ChildEvent): boolean {
	try {
		return appendChildNodeLogRecord(config, event);
	} catch (error) {
		if (!loggedNodeLogFailure) {
			loggedNodeLogFailure = true;
			console.warn(`[picode] subagent runner worker could not append node log: ${serializeError(error).message}`);
		}
		return false;
	}
}

port.on("message", (message: RunnerWorkerMainMessage) => {
	if (message.type === "cancel") {
		pendingCancelReason = message.reason ?? "aborted";
		controller?.abort(pendingCancelReason);
		return;
	}

	if (message.type !== "run") return;
	if (running) {
		post({ type: "error", message: "runner worker received more than one run message" });
		return;
	}

	running = true;
	controller = new AbortController();
	if (pendingCancelReason) controller.abort(pendingCancelReason);

	void (async () => {
		try {
			const result = await runChildInProcess(
				message.request,
				{
					onEvent: (event) => {
						const hasNodeLogTarget = message.request.nodeLog !== undefined;
						const nodeLogWritten = writeNodeLog(message.request.nodeLog, event);
						if (message.emitDataPlaneEvents || isControlPlaneChildEvent(event) || (hasNodeLogTarget && !nodeLogWritten)) {
							post({ type: "event", event: nodeLogWritten ? { ...event, nodeLogWritten: true } : event });
						}
					},
					onRawLine: message.includeRawLines ? (line) => post({ type: "raw-line", line }) : undefined,
					signal: controller?.signal,
				},
				message.options,
			);
			post({ type: "result", result });
		} catch (error) {
			post({ type: "error", ...serializeError(error) });
		}
	})();
});

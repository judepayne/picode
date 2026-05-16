import * as fs from "node:fs";
import * as path from "node:path";

import { EVENT_SUBAGENT_EXPANDED_TASK, type ChildEvent, type ChildExecutionRequest, type ChildNodeLogWriteConfig } from "./types.ts";

export interface WorkerNodeLogRecord {
	cursor: string;
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	timestamp: number;
	eventType: string;
	event: Record<string, unknown>;
}

export function appendChildNodeLogRecord(config: ChildNodeLogWriteConfig | undefined, event: ChildEvent): boolean {
	return appendNodeLogEvent(config, typeof event.type === "string" ? event.type : "unknown", event, typeof event.timestamp === "number" ? event.timestamp : Date.now());
}

export function appendExpandedTaskNodeLogRecord(request: ChildExecutionRequest): boolean {
	return appendNodeLogEvent(request.nodeLog, EVENT_SUBAGENT_EXPANDED_TASK, {
		type: EVENT_SUBAGENT_EXPANDED_TASK,
		runId: request.runId,
		topLevelRunId: request.topLevelRunId,
		childId: request.childId,
		...(request.parentChildId ? { parentChildId: request.parentChildId } : {}),
		agent: request.agent,
		context: request.context,
		...(request.stepIndex !== undefined ? { stepIndex: request.stepIndex } : {}),
		...(request.taskIndex !== undefined ? { taskIndex: request.taskIndex } : {}),
		task: request.task,
		taskCharCount: request.task.length,
		timestamp: Date.now(),
	});
}

function appendNodeLogEvent(config: ChildNodeLogWriteConfig | undefined, eventType: string, event: Record<string, unknown>, timestamp = Date.now()): boolean {
	if (!config) return false;
	const filePath = resolveNodeLogPath(config.nodeLogsDir, config.childSessionId);
	fs.mkdirSync(config.nodeLogsDir, { recursive: true });
	const cursor = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
	const record: WorkerNodeLogRecord = {
		cursor: String(cursor),
		childSessionId: config.childSessionId,
		runId: config.runId,
		...(config.rootRunId ? { rootRunId: config.rootRunId } : {}),
		timestamp,
		eventType,
		event,
	};
	fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
	return true;
}

function resolveNodeLogPath(nodeLogsDir: string, childSessionId: string): string {
	const root = path.resolve(nodeLogsDir);
	const filePath = path.resolve(root, `${childSessionId}.jsonl`);
	if (filePath !== path.join(root, path.basename(filePath))) {
		throw new Error("invalid child session id for node-log path");
	}
	return filePath;
}

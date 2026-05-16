import {
	EVENT_CHILD_TEXT_DELTA,
	EVENT_CHILD_THINKING_END,
	EVENT_CHILD_THINKING_START,
	type ChildEvent,
	type ChildExecutionRequest,
	type DelegatedChildResult,
} from "./types.ts";
import type { RunChildOptions } from "./runner-core.ts";

export interface RunnerWorkerRunMessage {
	type: "run";
	request: ChildExecutionRequest;
	options: RunChildOptions;
	includeRawLines: boolean;
	emitDataPlaneEvents: boolean;
}

export interface RunnerWorkerCancelMessage {
	type: "cancel";
	reason?: string;
}

export type RunnerWorkerMainMessage = RunnerWorkerRunMessage | RunnerWorkerCancelMessage;

export interface RunnerWorkerEventMessage {
	type: "event";
	event: ChildEvent;
}

export interface RunnerWorkerRawLineMessage {
	type: "raw-line";
	line: string;
}

export interface RunnerWorkerResultMessage {
	type: "result";
	result: DelegatedChildResult;
}

export interface RunnerWorkerErrorMessage {
	type: "error";
	message: string;
	stack?: string;
}

export type RunnerWorkerParentMessage =
	| RunnerWorkerEventMessage
	| RunnerWorkerRawLineMessage
	| RunnerWorkerResultMessage
	| RunnerWorkerErrorMessage;

export function isControlPlaneChildEvent(event: ChildEvent): boolean {
	switch (event.type) {
		case EVENT_CHILD_TEXT_DELTA:
		case EVENT_CHILD_THINKING_START:
		case EVENT_CHILD_THINKING_END:
			return false;
		default:
			return true;
	}
}

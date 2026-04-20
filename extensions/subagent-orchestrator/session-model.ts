import { randomUUID } from "node:crypto";
import type { NormalizedDelegationRequest, OrchestratorChildSessionRecord } from "./types.ts";

interface BuildChildSessionRecordsInput {
	runId: string;
	rootRunId?: string;
	parentChildSessionId?: string;
	ownerModeId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	parentMessageId?: string;
	agent: string;
	request: NormalizedDelegationRequest;
	sessionFiles?: string[];
	now: number;
}

function buildChildMetadata(request: NormalizedDelegationRequest): Array<{
	childIndex: number;
	childKey: string;
	branchKey: string;
	taskSummary: string;
	stepIndex?: number;
	taskIndex?: number;
}> {
	switch (request.shape) {
		case "single":
			return [{
				childIndex: 0,
				childKey: "single:0",
				branchKey: "single:0",
				taskSummary: request.task ?? "Scout task",
			}];
		case "parallel":
			return (request.tasks ?? []).map((task, index) => ({
				childIndex: index,
				childKey: `parallel:${index}`,
				branchKey: `parallel:${index}`,
				taskSummary: task.task,
				taskIndex: index,
			}));
		case "chain":
			return (request.chain ?? []).map((step, index) => ({
				childIndex: index,
				childKey: `chain:${index}`,
				branchKey: `chain:${index}`,
				taskSummary: step.task,
				stepIndex: index,
			}));
	}
}

export function buildChildSessionRecords(input: BuildChildSessionRecordsInput): OrchestratorChildSessionRecord[] {
	const children = buildChildMetadata(input.request);
	return children.map((child) => ({
		childSessionId: randomUUID(),
		runId: input.runId,
		...(input.rootRunId ? { rootRunId: input.rootRunId } : {}),
		...(input.parentChildSessionId ? { parentChildSessionId: input.parentChildSessionId } : {}),
		ownerModeId: input.ownerModeId,
		parentSessionId: input.parentSessionId,
		...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
		...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
		requestShape: input.request.shape,
		async: input.request.async,
		context: input.request.context,
		agent: input.agent,
		childIndex: child.childIndex,
		childKey: child.childKey,
		branchKey: child.branchKey,
		...(child.stepIndex !== undefined ? { stepIndex: child.stepIndex } : {}),
		...(child.taskIndex !== undefined ? { taskIndex: child.taskIndex } : {}),
		status: "queued",
		taskSummary: child.taskSummary,
		...(typeof input.sessionFiles?.[child.childIndex] === "string" ? { sessionFile: input.sessionFiles[child.childIndex] } : {}),
		createdAt: input.now,
		updatedAt: input.now,
	}));
}

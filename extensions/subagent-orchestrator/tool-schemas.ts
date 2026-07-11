import { Type } from "typebox";
import { DEFAULT_SYNC_TIMEOUT_SECONDS, MAX_SYNC_TIMEOUT_SECONDS } from "./timeout.ts";

const DelegateTaskSchema = Type.Object({
	task: Type.String({ description: "The subagent task to run." }),
}, { additionalProperties: false });

export const DelegateSubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "The subagent type to run (defaults to scout)." })),
	task: Type.Optional(Type.String({ description: "Run one subagent task." })),
	tasks: Type.Optional(Type.Array(DelegateTaskSchema, { description: "Run multiple subagents in parallel." })),
	chain: Type.Optional(Type.Array(DelegateTaskSchema, { description: "Run a sequential chain of subagent tasks." })),
	async: Type.Optional(Type.Boolean({ description: "Run in the background and return immediately with a run id." })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SYNC_TIMEOUT_SECONDS, description: `Inactivity timeout for synchronous delegated runs in seconds. Defaults to ${DEFAULT_SYNC_TIMEOUT_SECONDS}. Async runs do not use it, but if provided it must still be within range.` })),
	context: Type.Optional(Type.Union([
		Type.Literal("fresh"),
		Type.Literal("fork"),
		Type.Literal("continue"),
	], { description: "Execution context for child subagents." })),
	childSessionId: Type.Optional(Type.String({ description: 'Explicit child session id to continue when context is "continue".' })),
	showRunCard: Type.Optional(Type.Boolean({ description: "Show a visible subagent orchestrator run card in the UI. Defaults to false." })),
}, { additionalProperties: false });

export const DevSubagentStreamToFileParams = Type.Object({
	childSessionId: Type.String({ description: "The child session id to stream." }),
	filePath: Type.String({ description: "JSONL file path to append sanitized stream events to." }),
	includeThinking: Type.Optional(Type.Boolean({ description: "Include thinking boundary/summary events. Defaults to false." })),
}, { additionalProperties: false });

export const DelegateSubagentStatusParams = Type.Object({
	action: Type.String({ description: 'One of "list", "get", "cancel", "next", "prev", "select", "tree", "log", "log_cursor", or "log_next".' }),
	runId: Type.Optional(Type.String({ description: "The orchestrator run id for get/cancel/next/prev/select/tree." })),
	childIndex: Type.Optional(Type.Number({ description: "The child index for action: \"select\"." })),
	childSessionId: Type.Optional(Type.String({ description: 'The child session id for action: "log", "log_cursor", or "log_next".' })),
	cursor: Type.Optional(Type.String({ description: 'The cursor for action: "log_next".' })),
	includeThinking: Type.Optional(Type.Boolean({ description: "Include thinking events in log responses." })),
}, { additionalProperties: false });

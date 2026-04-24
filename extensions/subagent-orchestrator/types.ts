export type ParentModeId = string;
export type DelegatedAgent = string;
export type DelegationContext = "fresh" | "fork" | "continue";
export type RequestShape = "single" | "parallel" | "chain";
export type RunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type HandbackStatus = "queued" | "consumed" | "dismissed";
export type ContinuationStatus = "queued" | "launched" | "failed" | "deferred";
export type RunOrigin = "agent" | "user";
export type HandbackConsumer = "agent" | "user";

export interface ModeStateSessionEntry {
	type?: string;
	customType?: string;
	data?: {
		modeId?: string;
		subagents?: string[];
	};
}

export interface DelegatedTaskInput {
	task: string;
}

export interface NormalizedDelegationRequest {
	shape: RequestShape;
	agent: DelegatedAgent;
	async: boolean;
	context: DelegationContext;
	showRunCard: boolean;
	timeoutSeconds?: number;
	childSessionId?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt?: string;
	task?: string;
	tasks?: DelegatedTaskInput[];
	chain?: DelegatedTaskInput[];
}

export interface OrchestratorRunRecord {
	orchestratorRunId: string;
	ownerModeId: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	rootRunId?: string;
	parentRunId?: string;
	parentChildSessionId?: string;
	depth?: number;
	launchedAt: number;
	updatedAt: number;
	completedAt?: number;
	requestShape: RequestShape;
	async: boolean;
	context: DelegationContext;
	origin?: RunOrigin;
	agent?: string;
	status: RunStatus;
	taskSummary: string;
	underlyingRequestId?: string;
	underlyingRunId?: string;
	asyncDir?: string;
	pid?: number;
	asyncEventCursor?: number;
	resultSummary?: string;
	error?: string;
	childSessionCount?: number;
	activeChildCount?: number;
	queuedHandbackCount?: number;
	consumedHandbackCount?: number;
	selectedChildIndex?: number;
	terminalStatusNotifiedAt?: number;
	failureAcknowledgedAt?: number;
}

export interface OrchestratorRunSummary {
	orchestratorRunId: string;
	ownerModeId: string;
	parentSessionId?: string;
	rootRunId?: string;
	parentRunId?: string;
	parentChildSessionId?: string;
	depth?: number;
	updatedAt: number;
	requestShape: RequestShape;
	async: boolean;
	context: DelegationContext;
	origin?: RunOrigin;
	agent?: string;
	status: RunStatus;
	taskSummary: string;
	underlyingRunId?: string;
	asyncEventCursor?: number;
	resultSummary?: string;
	error?: string;
	childSessionCount?: number;
	activeChildCount?: number;
	queuedHandbackCount?: number;
	consumedHandbackCount?: number;
	selectedChildIndex?: number;
	terminalStatusNotifiedAt?: number;
	failureAcknowledgedAt?: number;
}

export interface OrchestratorIndexFile {
	version: 1;
	runs: OrchestratorRunSummary[];
}

export interface OrchestratorChildSessionRecord {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	parentChildSessionId?: string;
	ownerModeId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	parentMessageId?: string;
	requestShape: RequestShape;
	async: boolean;
	context: DelegationContext;
	agent: string;
	childIndex: number;
	childKey: string;
	branchKey?: string;
	stepIndex?: number;
	taskIndex?: number;
	executionChildId?: string;
	status: RunStatus;
	taskSummary: string;
	underlyingRunId?: string;
	asyncDir?: string;
	sessionFile?: string;
	currentTool?: string;
	toolCount?: number;
	progressStatus?: string;
	recentOutput?: string[];
	finalAnswer?: string;
	resultSummary?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface OrchestratorChildSessionSummary {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	parentChildSessionId?: string;
	ownerModeId: string;
	parentSessionId: string;
	agent: string;
	childIndex: number;
	childKey: string;
	branchKey?: string;
	stepIndex?: number;
	taskIndex?: number;
	executionChildId?: string;
	status: RunStatus;
	taskSummary: string;
	sessionFile?: string;
	currentTool?: string;
	toolCount?: number;
	recentOutput?: string[];
	resultSummary?: string;
	error?: string;
	updatedAt: number;
	completedAt?: number;
}

export interface OrchestratorChildSessionIndexFile {
	version: 1;
	childSessions: OrchestratorChildSessionSummary[];
}

export interface OrchestratorHandbackRecord {
	handbackId: string;
	runId: string;
	ownerModeId: string;
	parentSessionId: string;
	childSessionIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: HandbackStatus;
	content: string;
	summary: string;
	batchId?: string;
	createdAt: number;
	updatedAt: number;
	visibleNotifiedAt?: number;
	consumedAt?: number;
	dismissedAt?: number;
}

export interface OrchestratorHandbackSummary {
	handbackId: string;
	runId: string;
	ownerModeId: string;
	parentSessionId: string;
	childSessionIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: HandbackStatus;
	summary: string;
	batchId?: string;
	createdAt: number;
	updatedAt: number;
	visibleNotifiedAt?: number;
	consumedAt?: number;
	dismissedAt?: number;
}

export interface OrchestratorHandbackIndexFile {
	version: 1;
	handbacks: OrchestratorHandbackSummary[];
}

export interface OrchestratorContinuationRecord {
	continuationId: string;
	parentSessionId: string;
	ownerModeId: string;
	handbackIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: ContinuationStatus;
	content: string;
	createdAt: number;
	updatedAt: number;
	launchedAt?: number;
	error?: string;
}

export interface OrchestratorContinuationSummary {
	continuationId: string;
	parentSessionId: string;
	ownerModeId: string;
	handbackIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: ContinuationStatus;
	createdAt: number;
	updatedAt: number;
	launchedAt?: number;
	error?: string;
}

export interface OrchestratorContinuationIndexFile {
	version: 1;
	continuations: OrchestratorContinuationSummary[];
}

export interface ChildSessionEntryPayload {
	runId: string;
	childSessionId: string;
	ownerModeId: string;
	status: RunStatus;
	taskSummary: string;
	childIndex: number;
	sessionFile?: string;
	currentTool?: string;
	resultSummary?: string;
	error?: string;
	event: "created" | "updated" | "completed" | "cancelled";
}

export interface HandbackEntryPayload {
	handbackId: string;
	runId: string;
	ownerModeId: string;
	parentSessionId: string;
	childSessionIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: HandbackStatus;
	summary: string;
	batchId?: string;
}

export interface ContinuationEntryPayload {
	continuationId: string;
	parentSessionId: string;
	ownerModeId: string;
	handbackIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
	status: ContinuationStatus;
	error?: string;
}

export interface OrchestratorRunMessageChild {
	childSessionId: string;
	childIndex: number;
	status: RunStatus;
	taskSummary: string;
	currentTool?: string;
	toolCount?: number;
	sessionFile?: string;
	asyncDir?: string;
	recentOutput?: string[];
	resultSummary?: string;
	error?: string;
}

export interface OrchestratorRunMessageDetails {
	runId: string;
	ownerModeId: string;
	parentSessionId?: string;
	requestShape: RequestShape;
	async: boolean;
	context: DelegationContext;
	origin?: RunOrigin;
	agent?: string;
	status: RunStatus;
	taskSummary: string;
	updatedAt: number;
	resultSummary?: string;
	error?: string;
	childSessionCount: number;
	activeChildCount: number;
	queuedHandbackCount: number;
	consumedHandbackCount: number;
	selectedChildIndex?: number;
	children: OrchestratorRunMessageChild[];
}

export interface OrchestratorTreeNodeDetails {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	parentChildSessionId?: string;
	agent: string;
	childIndex: number;
	stepIndex?: number;
	taskIndex?: number;
	status: RunStatus;
	taskSummary: string;
	currentTool?: string;
	toolCount?: number;
	sessionFile?: string;
	recentOutput?: string[];
	resultSummary?: string;
	error?: string;
	children: OrchestratorTreeNodeDetails[];
}

export interface OrchestratorTreeDetails {
	rootRunId: string;
	ownerModeId: string;
	status: RunStatus;
	async: boolean;
	context: DelegationContext;
	origin?: RunOrigin;
	agent?: string;
	taskSummary: string;
	selectedRunId?: string;
	nodes: OrchestratorTreeNodeDetails[];
}

export interface OrchestratorNodeLogRecord {
	cursor: string;
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	timestamp: number;
	eventType: string;
	event: Record<string, unknown>;
}

export interface OrchestratorLogDetails {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	status: RunStatus;
	includeThinking: boolean;
	records: OrchestratorNodeLogRecord[];
}

export interface OrchestratorStreamDetails {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	status: RunStatus;
	includeThinking: boolean;
	terminal: boolean;
	cursor: string | null;
}

export interface OrchestratorStreamNextDetails {
	childSessionId: string;
	runId: string;
	rootRunId?: string;
	status: RunStatus;
	includeThinking: boolean;
	terminal: boolean;
	cursor: string;
	records: OrchestratorNodeLogRecord[];
}

export interface OrchestratorContinuationMessageDetails {
	continuationId: string;
	handbackIds: string[];
	childCount: number;
	runIds: string[];
	consumer?: HandbackConsumer;
	agent?: string;
}

export interface ProgrammaticProgressEntry {
	index?: number;
	agent?: string;
	status?: string;
	task?: string;
	currentTool?: string;
	toolCount?: number;
	recentOutput?: string[];
	durationMs?: number;
	tokens?: number;
	error?: string;
}

export interface ProgrammaticResultEntry {
	agent?: string;
	output?: string;
	finalOutput?: string;
	success?: boolean;
	sessionFile?: string;
	skipped?: boolean;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: unknown[];
	artifactPaths?: unknown;
	truncated?: unknown;
}

export interface ProgrammaticResultDetails {
	mode?: string;
	asyncId?: string;
	asyncDir?: string;
	results?: ProgrammaticResultEntry[];
	progress?: ProgrammaticProgressEntry[];
}

export interface ProgrammaticSubagentResponse {
	requestId: string;
	result: {
		content?: Array<{ type?: string; text?: string }>;
		details?: ProgrammaticResultDetails;
		isError?: boolean;
	};
	isError: boolean;
	errorText?: string;
}

export interface ProgrammaticSubagentUpdate {
	requestId: string;
	progress?: ProgrammaticProgressEntry[];
	currentTool?: string;
	toolCount?: number;
}

export interface AsyncStartedEvent {
	id?: string;
	pid?: number;
	asyncDir?: string;
	agent?: string;
	chain?: string[];
}

export interface AsyncCompleteEvent {
	id?: string | null;
	agent?: string | null;
	success?: boolean;
	status?: "complete" | "failed" | "cancelled";
	cancelled?: boolean;
	summary?: string;
	results?: ProgrammaticResultEntry[];
	exitCode?: number;
	timestamp?: number;
	asyncDir?: string;
	sessionId?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	durationMs?: number;
	cwd?: string;
	taskIndex?: number;
	totalTasks?: number;
}

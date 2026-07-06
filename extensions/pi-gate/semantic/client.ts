import { parseLlamaDecisionText, requestLlamaDecision } from "../model-client.ts";

import type { GateAutoApproverConfig } from "../auto-approver/types.ts";

import type { GateSemanticDecision, GateSemanticResult } from "./types.ts";

interface GateSemanticClientInput {
	endpoint: string;
	stablePrefix: string;
	dynamicPayload: string;
	stableContextHash: string;
	dynamicPayloadHash: string;
	requestId: string;
	config: GateAutoApproverConfig;
}

const DECISIONS = ["allow", "block", "prompt"] as const;

function mapDecision(decision: GateSemanticDecision): GateSemanticResult["outcome"] {
	if (decision === "allow") return "allowed";
	if (decision === "block") return "blocked";
	return "fallback_prompt";
}

export function parseGateSemanticDecisionText(text: string): { decision: GateSemanticDecision; reason: string } | { error: string } {
	return parseLlamaDecisionText<GateSemanticDecision>(text, new Set(DECISIONS), "response decision was not allow, block, or prompt");
}

export async function requestGateSemanticDecision(input: GateSemanticClientInput): Promise<GateSemanticResult> {
	const result = await requestLlamaDecision<GateSemanticDecision>({
		...input,
		model: "local-gate-auto",
		schema: {
			name: "gate_auto_decision",
			decisions: DECISIONS,
			malformedDecisionMessage: "response decision was not allow, block, or prompt",
			mapDecision,
			fallbackDecision: "prompt",
		},
		unavailableReason: "Auto approver unavailable",
		timeoutReason: "Auto approver timed out",
		httpReason: "Auto approver HTTP",
		malformedHttpReason: "Auto approver returned malformed HTTP JSON",
		missingContentReason: "Auto approver response had no content",
		malformedDecisionReason: "Auto approver returned malformed decision",
	});
	return result as GateSemanticResult;
}

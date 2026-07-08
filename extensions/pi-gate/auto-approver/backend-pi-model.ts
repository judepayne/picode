import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { parseGateSemanticDecisionText } from "../semantic/client.ts";
import type { GateSemanticResult } from "../semantic/types.ts";
import type { GateAutoApproverConfig, GateAutoThinking, PiModelGateAutoBackendConfig } from "./types.ts";

type ResolvedPiModelAuth = { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string };

interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders?(model: Model<Api>): Promise<ResolvedPiModelAuth>;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

interface PiModelDecisionInput {
	stablePrefix: string;
	dynamicPayload: string;
	stableContextHash: string;
	dynamicPayloadHash: string;
	requestId: string;
	config: GateAutoApproverConfig;
}

function mapDecision(decision: "allow" | "block" | "prompt"): GateSemanticResult["outcome"] {
	if (decision === "allow") return "allowed";
	if (decision === "block") return "blocked";
	return "fallback_prompt";
}

function fallback(input: PiModelDecisionInput, started: number, reason: string, outcome: GateSemanticResult["outcome"], error?: string): GateSemanticResult {
	return {
		decision: "prompt",
		reason,
		outcome,
		latencyMs: Date.now() - started,
		requestId: input.requestId,
		stableContextHash: input.stableContextHash,
		dynamicPayloadHash: input.dynamicPayloadHash,
		error,
	};
}

function textContent(message: Awaited<ReturnType<typeof completeSimple>>): string | undefined {
	const parts = message.content
		.map((part) => part.type === "text" ? part.text : "")
		.filter(Boolean);
	return parts.join("\n") || undefined;
}

function reasoningOption(thinking: GateAutoThinking): SimpleStreamOptions["reasoning"] | undefined {
	return thinking === "off" ? undefined : thinking;
}

async function resolvePiModel(ctx: ExtensionContext, backend: PiModelGateAutoBackendConfig): Promise<{ ok: true; model: Model<Api>; auth?: Extract<ResolvedPiModelAuth, { ok: true }> } | { ok: false; error: string }> {
	const registry = (ctx as { modelRegistry?: ModelRegistryLike }).modelRegistry;
	if (!registry) return { ok: false, error: "Pi model registry unavailable" };
	const model = registry.find(backend.provider, backend.model);
	if (!model) return { ok: false, error: `Pi model not found: ${backend.provider}/${backend.model}` };
	if (registry.getApiKeyAndHeaders) {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { ok: false, error: `Pi model auth unavailable: ${auth.error}` };
		return { ok: true, model, auth };
	}
	if (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model)) {
		return { ok: false, error: `Pi model auth unavailable for ${backend.provider}` };
	}
	return { ok: true, model };
}

export async function validatePiModelBackend(ctx: ExtensionContext, backend: PiModelGateAutoBackendConfig): Promise<{ ok: true } | { ok: false; error: string }> {
	const resolved = await resolvePiModel(ctx, backend);
	return resolved.ok ? { ok: true } : { ok: false, error: resolved.error };
}

export async function requestPiModelDecision(ctx: ExtensionContext, input: PiModelDecisionInput): Promise<GateSemanticResult> {
	const started = Date.now();
	const backend = input.config.backend as PiModelGateAutoBackendConfig;
	const resolved = await resolvePiModel(ctx, backend);
	if (!resolved.ok) return fallback(input, started, resolved.error, "unavailable", resolved.error);
	const { model, auth } = resolved;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);
	try {
		const message = await completeSimple(model, {
			systemPrompt: input.stablePrefix,
			messages: [{ role: "user", content: input.dynamicPayload, timestamp: Date.now() }],
			tools: [],
		}, {
			temperature: backend.temperature,
			maxTokens: backend.maxTokens,
			timeoutMs: input.config.timeoutMs,
			cacheRetention: backend.cacheRetention,
			reasoning: reasoningOption(backend.thinking),
			signal: controller.signal,
			...(auth?.ok && auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth?.ok && auth.headers ? { headers: auth.headers } : {}),
			...(auth?.ok && auth.env ? { env: auth.env } : {}),
		});
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return fallback(input, started, message.errorMessage ?? "Pi model approver failed", message.stopReason === "aborted" ? "timeout" : "error", message.errorMessage);
		}
		const content = textContent(message);
		if (!content) return fallback(input, started, "Pi model approver response had no content", "malformed", "missing content");
		const parsed = parseGateSemanticDecisionText(content);
		if ("error" in parsed) return fallback(input, started, "Pi model approver returned malformed decision", "malformed", parsed.error);
		return {
			decision: parsed.decision,
			reason: parsed.reason,
			outcome: mapDecision(parsed.decision),
			latencyMs: Date.now() - started,
			requestId: input.requestId,
			stableContextHash: input.stableContextHash,
			dynamicPayloadHash: input.dynamicPayloadHash,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = (error as { name?: string }).name === "AbortError";
		return fallback(input, started, aborted ? "Pi model approver timed out" : "Pi model approver unavailable", aborted ? "timeout" : "unavailable", message);
	} finally {
		clearTimeout(timer);
	}
}

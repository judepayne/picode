import type { GateAutoApprovalResult, GateAutoApproverConfig, GateAutoDecision } from "./types.ts";

interface LlamaClientInput {
	endpoint: string;
	stablePrefix: string;
	dynamicPayload: string;
	stableContextHash: string;
	dynamicPayloadHash: string;
	requestId: string;
	config: GateAutoApproverConfig;
}

interface LlamaWarmupInput {
	endpoint: string;
	stablePrefix: string;
	stableContextHash: string;
	config: GateAutoApproverConfig;
}

const DECISIONS = new Set(["allow", "deny", "escalate"]);

function mapDecision(decision: GateAutoDecision): GateAutoApprovalResult["outcome"] {
	if (decision === "allow") return "allowed";
	if (decision === "deny") return "blocked";
	return "escalated";
}

function safeReason(value: unknown): string {
	const reason = typeof value === "string" ? value.trim() : "";
	return reason ? reason.slice(0, 300) : "No reason provided";
}

export function parseGateAutoDecisionText(text: string): { decision: GateAutoDecision; reason: string } | { error: string } {
	const trimmed = text.trim();
	const candidate = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
	if (!candidate) return { error: "response did not contain a JSON object" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `invalid JSON: ${message}` };
	}
	if (!parsed || typeof parsed !== "object") return { error: "response JSON was not an object" };
	const decision = (parsed as { decision?: unknown }).decision;
	if (typeof decision !== "string" || !DECISIONS.has(decision)) return { error: "response decision was not allow, deny, or escalate" };
	return { decision: decision as GateAutoDecision, reason: safeReason((parsed as { reason?: unknown }).reason) };
}

function responseFormatBody(config: GateAutoApproverConfig): Record<string, unknown> | undefined {
	const format = config.llama.responseFormat === "auto" ? "json_schema" : config.llama.responseFormat;
	if (format === "json_schema") {
		return {
			type: "json_schema",
			json_schema: {
				name: "gate_auto_decision",
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["decision", "reason"],
					properties: {
						decision: { type: "string", enum: ["allow", "deny", "escalate"] },
						reason: { type: "string" },
					},
				},
			},
		};
	}
	if (format === "json_object") return { type: "json_object" };
	return undefined;
}

function completionContent(data: unknown): string | undefined {
	const choices = (data as { choices?: unknown })?.choices;
	if (!Array.isArray(choices)) return undefined;
	const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as { message?: { content?: unknown }; text?: unknown }) : undefined;
	if (typeof message?.message?.content === "string") return message.message.content;
	if (typeof message?.text === "string") return message.text;
	return undefined;
}

export async function warmGateAutoApprover(input: LlamaWarmupInput): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.min(Math.max(input.config.timeoutMs, 1000), 5000));
	try {
		const body: Record<string, unknown> = {
			model: "local-gate-auto",
			messages: [
				{ role: "system", content: input.stablePrefix },
				{ role: "user", content: JSON.stringify({ requestId: "warmup", instruction: "Warm the approval context. Return a minimal JSON decision." }) },
			],
			temperature: 0,
			top_p: 1,
			max_tokens: 16,
			cache_prompt: input.config.llama.cachePrompt,
			chat_template_kwargs: { enable_thinking: input.config.llama.enableThinking },
		};
		if (input.config.llama.idSlot !== undefined) body.id_slot = input.config.llama.idSlot;
		const responseFormat = responseFormatBody(input.config);
		if (responseFormat) body.response_format = responseFormat;
		const response = await fetch(`${input.endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, latencyMs: Date.now() - started, error: `warmup HTTP ${response.status}` };
		await response.arrayBuffer().catch(() => undefined);
		return { ok: true, latencyMs: Date.now() - started };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, latencyMs: Date.now() - started, error: message };
	} finally {
		clearTimeout(timer);
	}
}

export async function requestGateAutoDecision(input: LlamaClientInput): Promise<GateAutoApprovalResult> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);
	const finish = (partial: Omit<GateAutoApprovalResult, "latencyMs" | "requestId" | "stableContextHash" | "dynamicPayloadHash">): GateAutoApprovalResult => ({
		...partial,
		latencyMs: Date.now() - started,
		requestId: input.requestId,
		stableContextHash: input.stableContextHash,
		dynamicPayloadHash: input.dynamicPayloadHash,
	});

	try {
		const body: Record<string, unknown> = {
			model: "local-gate-auto",
			messages: [
				{ role: "system", content: input.stablePrefix },
				{ role: "user", content: input.dynamicPayload },
			],
			temperature: 0,
			top_p: 1,
			max_tokens: 128,
			cache_prompt: input.config.llama.cachePrompt,
			chat_template_kwargs: { enable_thinking: input.config.llama.enableThinking },
		};
		if (input.config.llama.idSlot !== undefined) body.id_slot = input.config.llama.idSlot;
		const responseFormat = responseFormatBody(input.config);
		if (responseFormat) body.response_format = responseFormat;

		const response = await fetch(`${input.endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			return finish({ decision: "escalate", reason: `Approver HTTP ${response.status}`, outcome: response.status === 404 ? "unavailable" : "error", error: await response.text().catch(() => response.statusText) });
		}
		const data = await response.json().catch((error: unknown) => ({ __parseError: error instanceof Error ? error.message : String(error) }));
		if ((data as { __parseError?: string }).__parseError) {
			return finish({ decision: "escalate", reason: "Approver returned malformed HTTP JSON", outcome: "malformed", error: (data as { __parseError: string }).__parseError });
		}
		const content = completionContent(data);
		if (!content) return finish({ decision: "escalate", reason: "Approver response had no content", outcome: "malformed", error: "missing content" });
		const parsed = parseGateAutoDecisionText(content);
		if ("error" in parsed) return finish({ decision: "escalate", reason: "Approver returned malformed decision", outcome: "malformed", error: parsed.error });
		return finish({ decision: parsed.decision, reason: parsed.reason, outcome: mapDecision(parsed.decision) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = (error as { name?: string }).name === "AbortError";
		return finish({ decision: "escalate", reason: aborted ? "Approver timed out" : "Approver unavailable", outcome: aborted ? "timeout" : "unavailable", error: message });
	} finally {
		clearTimeout(timer);
	}
}

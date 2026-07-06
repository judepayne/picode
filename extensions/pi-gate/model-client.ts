import type { GateAutoApproverConfig, GateAutoResponseFormat } from "./auto-approver/types.ts";

export interface LlamaDecisionSchema<TDecision extends string> {
	name: string;
	decisions: readonly TDecision[];
	malformedDecisionMessage: string;
	mapDecision(decision: TDecision): string;
	fallbackDecision: TDecision;
}

export interface LlamaDecisionRequest<TDecision extends string> {
	endpoint: string;
	model: string;
	stablePrefix: string;
	dynamicPayload: string;
	stableContextHash: string;
	dynamicPayloadHash: string;
	requestId: string;
	config: GateAutoApproverConfig;
	schema: LlamaDecisionSchema<TDecision>;
	unavailableReason: string;
	timeoutReason: string;
	httpReason: string;
	malformedHttpReason: string;
	missingContentReason: string;
	malformedDecisionReason: string;
}

export interface LlamaDecisionResult<TDecision extends string> {
	decision: TDecision;
	reason: string;
	outcome: string;
	latencyMs: number;
	requestId: string;
	stableContextHash: string;
	dynamicPayloadHash: string;
	error?: string;
}

function safeReason(value: unknown): string {
	const reason = typeof value === "string" ? value.trim() : "";
	return reason ? reason.slice(0, 300) : "No reason provided";
}

export function parseLlamaDecisionText<TDecision extends string>(text: string, decisions: ReadonlySet<string>, errorDecisionText: string): { decision: TDecision; reason: string } | { error: string } {
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
	if (typeof decision !== "string" || !decisions.has(decision)) return { error: errorDecisionText };
	return { decision: decision as TDecision, reason: safeReason((parsed as { reason?: unknown }).reason) };
}

export function responseFormatBody(config: GateAutoApproverConfig, name: string, decisions: readonly string[]): Record<string, unknown> | undefined {
	const format: GateAutoResponseFormat = config.llama.responseFormat === "auto" ? "json_schema" : config.llama.responseFormat;
	if (format === "json_schema") {
		return {
			type: "json_schema",
			json_schema: {
				name,
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["decision", "reason"],
					properties: {
						decision: { type: "string", enum: decisions },
						reason: { type: "string" },
					},
				},
			},
		};
	}
	if (format === "json_object") return { type: "json_object" };
	return undefined;
}

export function completionContent(data: unknown): string | undefined {
	const choices = (data as { choices?: unknown })?.choices;
	if (!Array.isArray(choices)) return undefined;
	const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as { message?: { content?: unknown }; text?: unknown }) : undefined;
	if (typeof message?.message?.content === "string") return message.message.content;
	if (typeof message?.text === "string") return message.text;
	return undefined;
}

export async function requestLlamaDecision<TDecision extends string>(input: LlamaDecisionRequest<TDecision>): Promise<LlamaDecisionResult<TDecision>> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);
	const finish = (partial: Omit<LlamaDecisionResult<TDecision>, "latencyMs" | "requestId" | "stableContextHash" | "dynamicPayloadHash">): LlamaDecisionResult<TDecision> => ({
		...partial,
		latencyMs: Date.now() - started,
		requestId: input.requestId,
		stableContextHash: input.stableContextHash,
		dynamicPayloadHash: input.dynamicPayloadHash,
	});

	try {
		const body: Record<string, unknown> = {
			model: input.model,
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
		const responseFormat = responseFormatBody(input.config, input.schema.name, input.schema.decisions);
		if (responseFormat) body.response_format = responseFormat;

		const response = await fetch(`${input.endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			return finish({ decision: input.schema.fallbackDecision, reason: `${input.httpReason} ${response.status}`, outcome: response.status === 404 ? "unavailable" : "error", error: await response.text().catch(() => response.statusText) });
		}
		const data = await response.json().catch((error: unknown) => ({ __parseError: error instanceof Error ? error.message : String(error) }));
		if ((data as { __parseError?: string }).__parseError) {
			return finish({ decision: input.schema.fallbackDecision, reason: input.malformedHttpReason, outcome: "malformed", error: (data as { __parseError: string }).__parseError });
		}
		const content = completionContent(data);
		if (!content) return finish({ decision: input.schema.fallbackDecision, reason: input.missingContentReason, outcome: "malformed", error: "missing content" });
		const parsed = parseLlamaDecisionText<TDecision>(content, new Set(input.schema.decisions), input.schema.malformedDecisionMessage);
		if ("error" in parsed) return finish({ decision: input.schema.fallbackDecision, reason: input.malformedDecisionReason, outcome: "malformed", error: parsed.error });
		return finish({ decision: parsed.decision, reason: parsed.reason, outcome: input.schema.mapDecision(parsed.decision) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = (error as { name?: string }).name === "AbortError";
		return finish({ decision: input.schema.fallbackDecision, reason: aborted ? input.timeoutReason : input.unavailableReason, outcome: aborted ? "timeout" : "unavailable", error: message });
	} finally {
		clearTimeout(timer);
	}
}

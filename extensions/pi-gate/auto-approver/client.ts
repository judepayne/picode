import { responseFormatBody } from "../model-client.ts";
import type { GateAutoApproverConfig } from "./types.ts";

interface LlamaWarmupInput {
	endpoint: string;
	stablePrefix: string;
	stableContextHash: string;
	config: GateAutoApproverConfig;
}

const DECISIONS = ["allow", "block", "prompt"] as const;

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
		const responseFormat = responseFormatBody(input.config, "gate_auto_decision", DECISIONS);
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

import * as crypto from "node:crypto";

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashGateAutoText(value: string): string {
	return sha256(value);
}

export function truncateText(value: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (value.length <= maxChars) return value;
	if (maxChars <= 32) return `${value.slice(0, maxChars)}…`;
	return `${value.slice(0, maxChars - 32)}\n[truncated ${value.length - (maxChars - 32)} chars]`;
}

function extractText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const parts = value.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
				return (part as { text: string }).text;
			}
			return "";
		}).filter(Boolean);
		return parts.join("\n") || undefined;
	}
	return undefined;
}

export function getLastUserTurn(ctx: unknown, maxChars: number): { text?: string; hash?: string } {
	try {
		const branch = (ctx as { sessionManager?: { getBranch?: () => unknown } })?.sessionManager?.getBranch?.();
		const entries = Array.isArray(branch) ? branch : Array.isArray((branch as { messages?: unknown[] })?.messages) ? (branch as { messages: unknown[] }).messages : [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as Record<string, unknown> | undefined;
			const message = (entry?.message && typeof entry.message === "object" ? entry.message : entry) as Record<string, unknown> | undefined;
			if (message?.role !== "user") continue;
			const text = extractText(message.content) ?? extractText(entry?.content);
			if (!text) continue;
			const truncated = truncateText(text, maxChars);
			return truncated ? { text: truncated, hash: sha256(text) } : { text: "" };
		}
	} catch {
		// Best effort only.
	}
	return {};
}

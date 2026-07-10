export function errorResult(message: string, mode: "single" | "parallel" | "chain" = "single") {
	return { content: [{ type: "text" as const, text: message }], isError: true, details: { mode, results: [] } };
}
export function successText(message: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: message }], details };
}
export function firstTextContent(content: Array<{ type?: string; text?: string }> | undefined): string | undefined {
	for (const item of content ?? []) if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
	return undefined;
}
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

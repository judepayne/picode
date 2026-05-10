export function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function normalizeOptionalFrontmatterString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = unquote(value).trim();
	if (!normalized || normalized === "-") return undefined;
	return normalized;
}

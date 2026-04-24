export type ToolSelectionMode = "omitted" | "all" | "list";
export type ToolSelectionDefaultMode = "all" | "inherit";

export interface ToolSelectionSpec {
	toolsMode: ToolSelectionMode;
	tools?: string[];
	banTools?: string[];
}

export interface ResolveToolSelectionOptions {
	defaultMode: ToolSelectionDefaultMode;
	availableTools: string[];
	inheritedTools?: string[];
}

export interface ResolvedToolSelection {
	tools: string[];
	unknownRequestedTools: string[];
	unknownBannedTools: string[];
}

function normalizeToolName(value: string): string {
	return value.trim().toLowerCase();
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function dedupeTools(tools: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tool of tools) {
		if (!tool || seen.has(tool)) continue;
		seen.add(tool);
		out.push(tool);
	}
	return out;
}

function parseToolList(value: string | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	if (!trimmed) return [];
	const list = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return dedupeTools(
		list
			.split(",")
			.map((entry) => normalizeToolName(unquote(entry)))
			.filter(Boolean),
	);
}

export function parseToolSelection(values: { tools?: string; banTools?: string }): ToolSelectionSpec {
	const parsedTools = parseToolList(values.tools);
	const parsedBanTools = parseToolList(values.banTools);
	const toolsMode: ToolSelectionMode = parsedTools.length === 0
		? "omitted"
		: parsedTools.length === 1 && parsedTools[0] === "all"
			? "all"
			: "list";

	return {
		toolsMode,
		...(toolsMode === "list" ? { tools: parsedTools } : {}),
		...(parsedBanTools.length > 0 ? { banTools: parsedBanTools } : {}),
	};
}

export function resolveToolSelection(
	spec: ToolSelectionSpec | undefined,
	options: ResolveToolSelectionOptions,
): ResolvedToolSelection {
	const normalizedSpec = spec ?? { toolsMode: "omitted" as const };
	const availableTools = dedupeTools(options.availableTools.map(normalizeToolName).filter(Boolean));
	const availableToolSet = new Set(availableTools);
	const inheritedTools = dedupeTools((options.inheritedTools ?? []).map(normalizeToolName).filter(Boolean));
	const requestedTools = normalizedSpec.tools ?? [];
	const banTools = normalizedSpec.banTools ?? [];

	const baseTools = normalizedSpec.toolsMode === "list"
		? requestedTools
		: normalizedSpec.toolsMode === "all" || options.defaultMode === "all"
			? availableTools
			: inheritedTools;

	const unknownRequestedTools = normalizedSpec.toolsMode === "list"
		? requestedTools.filter((tool) => !availableToolSet.has(tool))
		: [];
	const unknownBannedTools = banTools.filter((tool) => !availableToolSet.has(tool));
	const banToolSet = new Set(banTools.filter((tool) => availableToolSet.has(tool)));
	const resolvedTools = dedupeTools(baseTools)
		.filter((tool) => availableToolSet.has(tool))
		.filter((tool) => !banToolSet.has(tool));

	return {
		tools: resolvedTools,
		unknownRequestedTools,
		unknownBannedTools,
	};
}

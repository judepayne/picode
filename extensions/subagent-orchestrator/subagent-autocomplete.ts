import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";

import { shouldOfferUserDispatchAutocomplete } from "./user-dispatch.ts";

function normalizeAllowedSubagents(getAllowedSubagents: () => string[]): string[] {
	return [...new Set(
		getAllowedSubagents()
			.map((subagent) => subagent.trim().toLowerCase())
			.filter(Boolean),
	)].sort((left, right) => left.localeCompare(right));
}

function buildUserDispatchItems(prefix: string, getAllowedSubagents: () => string[]): AutocompleteItem[] {
	const query = prefix.slice(1).toLowerCase();
	return normalizeAllowedSubagents(getAllowedSubagents)
		.filter((subagent) => !query || subagent.startsWith(query))
		.map((subagent) => ({
			value: subagent,
			label: subagent,
			description: `Dispatch a background ${subagent} run`,
		}));
}

export class UserDispatchAutocompleteProvider implements AutocompleteProvider {
	private readonly delegate: AutocompleteProvider;
	private readonly getAllowedSubagents: () => string[];

	constructor(delegate: AutocompleteProvider, getAllowedSubagents: () => string[]) {
		this.delegate = delegate;
		this.getAllowedSubagents = getAllowedSubagents;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const prefix = shouldOfferUserDispatchAutocomplete(lines, cursorLine, cursorCol);
		if (prefix) {
			const items = buildUserDispatchItems(prefix, this.getAllowedSubagents);
			if (items.length > 0) {
				return { items, prefix };
			}
		}
		return await this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const userDispatchPrefix = shouldOfferUserDispatchAutocomplete(lines, cursorLine, cursorCol);
		if (userDispatchPrefix && prefix === userDispatchPrefix) {
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const value = `~${item.value} `;
			const nextLines = [...lines];
			nextLines[cursorLine] = `${beforePrefix}${value}${afterCursor}`;
			return {
				lines: nextLines,
				cursorLine,
				cursorCol: beforePrefix.length + value.length,
			};
		}
		return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

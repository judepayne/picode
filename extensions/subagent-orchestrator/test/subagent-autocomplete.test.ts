import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";

import { UserDispatchAutocompleteProvider } from "../subagent-autocomplete.ts";

class StubAutocompleteProvider implements AutocompleteProvider {
	private readonly suggestions: AutocompleteSuggestions | null;

	constructor(suggestions: AutocompleteSuggestions | null = null) {
		this.suggestions = suggestions;
	}

	async getSuggestions(): Promise<AutocompleteSuggestions | null> {
		return this.suggestions;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		_prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const nextLines = [...lines];
		nextLines[cursorLine] = item.value;
		return { lines: nextLines, cursorLine, cursorCol };
	}
}

describe("user dispatch autocomplete", () => {
	it("suggests allowed subagents for a routed prefix", async () => {
		const provider = new UserDispatchAutocompleteProvider(
			new StubAutocompleteProvider(),
			() => ["generalist", "scout"],
		);
		const suggestions = await provider.getSuggestions(["~sc"], 0, 3, {
			signal: AbortSignal.abort(),
		});
		assert.deepEqual(suggestions, {
			prefix: "~sc",
			items: [{ value: "scout", label: "scout", description: "Dispatch a background scout run" }],
		});
	});

	it("falls back to the wrapped provider outside the routed prefix", async () => {
		const provider = new UserDispatchAutocompleteProvider(
			new StubAutocompleteProvider({ prefix: "he", items: [{ value: "hello", label: "hello" }] }),
			() => ["scout"],
		);
		const suggestions = await provider.getSuggestions(["he"], 0, 2, {
			signal: AbortSignal.abort(),
		});
		assert.deepEqual(suggestions, { prefix: "he", items: [{ value: "hello", label: "hello" }] });
	});

	it("completes the chosen subagent with a trailing space", () => {
		const provider = new UserDispatchAutocompleteProvider(
			new StubAutocompleteProvider(),
			() => ["generalist", "scout"],
		);
		assert.deepEqual(
			provider.applyCompletion(["~gen"], 0, 4, { value: "generalist", label: "generalist" }, "~gen"),
			{
				lines: ["~generalist "],
				cursorLine: 0,
				cursorCol: 12,
			},
		);
	});
});

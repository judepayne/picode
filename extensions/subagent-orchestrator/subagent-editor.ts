import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@earendil-works/pi-tui";

import { UserDispatchAutocompleteProvider } from "./subagent-autocomplete.ts";

export class SubagentEditor extends CustomEditor {
	private readonly getAllowedSubagents: () => string[];

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getAllowedSubagents: () => string[],
	) {
		super(tui, theme, keybindings);
		this.getAllowedSubagents = getAllowedSubagents;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(new UserDispatchAutocompleteProvider(provider, this.getAllowedSubagents));
	}
}

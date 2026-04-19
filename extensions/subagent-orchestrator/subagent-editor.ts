import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, KeybindingsManager, TUI } from "@mariozechner/pi-tui";

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

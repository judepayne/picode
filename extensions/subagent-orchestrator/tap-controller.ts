import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text } from "@mariozechner/pi-tui";
import type { SubagentStreamEvent, SubagentStreamHandler } from "./stream.ts";
import { formatTapCrumb, moveTapSelection, normalizeTapSelection, selectedTapNode, type TapRunRoot, type TapSelection } from "./tap-navigation.ts";
import { appendTapWidgetEvent, createTapWidgetState, renderTapWidgetLines, resetTapWidget, TAP_STATUS_KEY, TAP_WIDGET_KEY } from "./tap-widget.ts";

export interface TapController {
	handleCtx(ctx: ExtensionContext): void;
	refresh(): void;
	close(): void;
	dispose(): void;
}

export interface TapControllerInput {
	getRoots(ctx: ExtensionContext): TapRunRoot[];
	openStream(childSessionId: string, handler: SubagentStreamHandler): () => void;
	onPoll?: (ctx: ExtensionContext) => void;
	pollIntervalMs?: number;
	warn?: (message: string, error?: unknown) => void;
}

function hasTapTarget(roots: TapRunRoot[]): boolean {
	return roots.some((root) => root.children.length > 0);
}

function formatFooterCrumb(crumb: string | undefined, highlight: (text: string) => string): string | undefined {
	if (!crumb) return undefined;
	const parts = crumb.replace(/^tap:\s*/, "").split(" > ");
	if (parts.length === 0) return undefined;
	const current = parts[parts.length - 1]!;
	parts[parts.length - 1] = highlight(current);
	return `::: ${parts.join(" > ")}`;
}

export function createTapController(input: TapControllerInput): TapController {
	let latestCtx: ExtensionContext | undefined;
	let active = false;
	let roots: TapRunRoot[] = [];
	let selection: TapSelection | undefined;
	let closeStream: (() => void) | undefined;
	let subscribedChildSessionId: string | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let polling = false;
	let openedAt = 0;
	let movedUpToRootAt = 0;
	const widget = createTapWidgetState();

	function clearStream(): void {
		if (closeStream) closeStream();
		closeStream = undefined;
		subscribedChildSessionId = undefined;
	}

	function render(ctx = latestCtx): void {
		if (!ctx?.hasUI || !active) return;
		const lines = renderTapWidgetLines(widget);
		ctx.ui.setWidget(TAP_WIDGET_KEY, () => new Text(lines.map((line) => line || " ").join("\n"), 0, 0), { placement: "aboveEditor" });
		ctx.ui.setStatus(TAP_STATUS_KEY, formatFooterCrumb(widget.crumb, (text) => ctx.ui.theme.fg("warning", ctx.ui.theme.bold(text))));
	}

	function clearPollTimer(): void {
		if (!pollTimer) return;
		clearInterval(pollTimer);
		pollTimer = undefined;
		polling = false;
	}

	function ensurePollTimer(): void {
		if (pollTimer || !input.onPoll) return;
		pollTimer = setInterval(() => {
			const ctx = latestCtx;
			if (!active || !ctx || polling) return;
			polling = true;
			try {
				input.onPoll?.(ctx);
			} catch (error) {
				input.warn?.("tap poll failed", error);
			} finally {
				polling = false;
			}
		}, input.pollIntervalMs ?? 500);
		pollTimer.unref?.();
	}

	function rebuildRoots(ctx = latestCtx): TapRunRoot[] {
		if (!ctx) return [];
		try {
			return input.getRoots(ctx);
		} catch (error) {
			input.warn?.("failed to build tap roots", error);
			return [];
		}
	}

	function subscribeSelectedChild(ctx = latestCtx): void {
		if (!ctx || !selection) return;
		const node = selectedTapNode(roots, selection);
		const nextChildSessionId = node?.childSessionId;
		if (nextChildSessionId === subscribedChildSessionId) return;
		clearStream();
		resetTapWidget(widget, {
			crumb: formatTapCrumb(roots, selection),
			...(nextChildSessionId ? { selectedChildSessionId: nextChildSessionId } : {}),
		});
		if (!nextChildSessionId) {
			render(ctx);
			return;
		}
		try {
			closeStream = input.openStream(nextChildSessionId, (event: SubagentStreamEvent) => {
				appendTapWidgetEvent(widget, event);
				render();
			});
			subscribedChildSessionId = nextChildSessionId;
		} catch (error) {
			input.warn?.(`failed to open tap stream for ${nextChildSessionId}`, error);
			appendTapWidgetEvent(widget, {
				childSessionId: nextChildSessionId,
				runId: "",
				cursor: "",
				eventType: "tap.error",
				event: { message: error instanceof Error ? error.message : String(error) },
				replay: false,
			});
		}
		render(ctx);
	}

	function setSelection(nextSelection: TapSelection | undefined): void {
		selection = normalizeTapSelection(roots, nextSelection);
		if (!selection) {
			close();
			return;
		}
		subscribeSelectedChild();
	}

	function open(ctx = latestCtx): boolean {
		if (!ctx?.hasUI) return false;
		roots = rebuildRoots(ctx);
		if (!hasTapTarget(roots)) return false;
		active = true;
		openedAt = Date.now();
		ensurePollTimer();
		selection = { rootIndex: 0 };
		resetTapWidget(widget, { crumb: formatTapCrumb(roots, selection) });
		subscribeSelectedChild(ctx);
		render(ctx);
		return true;
	}

	function handleMove(direction: "left" | "right" | "down" | "up"): void {
		if (!selection) return;
		roots = rebuildRoots();
		selection = normalizeTapSelection(roots, selection);
		if (!selection) {
			close();
			return;
		}
		const moved = moveTapSelection(roots, selection, direction);
		if (moved.close) {
			close();
			return;
		}
		setSelection(moved.selection ?? selection);
	}

	function handleInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!active) {
			if (!matchesKey(data, "ctrl+/")) return undefined;
			return open() ? { consume: true } : undefined;
		}
		if (matchesKey(data, "ctrl+/")) {
			if (Date.now() - openedAt >= 300) handleMove("down");
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+,")) {
			handleMove("left");
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+.")) {
			handleMove("right");
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			const wasAtChild = Boolean(selection?.childSessionId);
			if (!wasAtChild && Date.now() - movedUpToRootAt < 300) return { consume: true };
			handleMove("up");
			if (wasAtChild && active && !selection?.childSessionId) movedUpToRootAt = Date.now();
			return { consume: true };
		}
		return undefined;
	}

	function ensureInputListener(ctx: ExtensionContext): void {
		if (!ctx.hasUI || unsubscribeInput) return;
		unsubscribeInput = ctx.ui.onTerminalInput(handleInput);
	}

	function close(): void {
		active = false;
		selection = undefined;
		roots = [];
		clearPollTimer();
		clearStream();
		latestCtx?.ui.setWidget(TAP_WIDGET_KEY, undefined);
		latestCtx?.ui.setStatus(TAP_STATUS_KEY, undefined);
	}

	return {
		handleCtx(ctx: ExtensionContext): void {
			latestCtx = ctx;
			ensureInputListener(ctx);
		},
		refresh(): void {
			if (!active) return;
			roots = rebuildRoots();
			selection = normalizeTapSelection(roots, selection);
			if (!selection) {
				close();
				return;
			}
			subscribeSelectedChild();
			render();
		},
		close,
		dispose(): void {
			close();
			if (unsubscribeInput) unsubscribeInput();
			unsubscribeInput = undefined;
			latestCtx = undefined;
		},
	};
}

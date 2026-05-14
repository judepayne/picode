import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import type { SubagentStreamEvent, SubagentStreamHandler } from "./stream.ts";
import { formatTapFooterTree, moveTapSelection, normalizeTapSelection, selectedTapNode, type TapRunRoot, type TapSelection } from "./tap-navigation.ts";
import { appendTapTranscriptEvent, createTapTranscriptComponent, createTapTranscriptState, resetTapTranscript, setTapTranscriptToolsExpanded, TAP_STATUS_KEY, TAP_TRANSCRIPT_KEY } from "./tap-transcript.ts";

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


export function createTapController(input: TapControllerInput): TapController {
	let latestCtx: ExtensionContext | undefined;
	let active = false;
	let roots: TapRunRoot[] = [];
	let selection: TapSelection | undefined;
	let closeStream: (() => void) | undefined;
	let subscribedChildSessionId: string | undefined;
	let streamGeneration = 0;
	let unsubscribeInput: (() => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let polling = false;
	let openedAt = 0;
	let movedUpToRootAt = 0;
	const transcript = createTapTranscriptState();

	function clearStream(): void {
		streamGeneration += 1;
		if (closeStream) closeStream();
		closeStream = undefined;
		subscribedChildSessionId = undefined;
	}

	function render(ctx = latestCtx): void {
		if (!ctx?.hasUI || !active) return;
		setTapTranscriptToolsExpanded(transcript, ctx.ui.getToolsExpanded());
		if (selection?.childSessionId) {
			ctx.ui.setWidget(TAP_TRANSCRIPT_KEY, (tui, theme) => createTapTranscriptComponent(transcript, tui, theme), { placement: "aboveEditor" });
		} else {
			ctx.ui.setWidget(TAP_TRANSCRIPT_KEY, undefined);
		}
		const footerTree = formatTapFooterTree(
			roots,
			selection,
			(text) => ctx.ui.theme.fg("warning", ctx.ui.theme.bold(text)),
			(text) => ctx.ui.theme.fg("dim", text),
		);
		ctx.ui.setStatus(TAP_STATUS_KEY, footerTree ? `::: ${footerTree}` : undefined);
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
		resetTapTranscript(transcript, {
			...(nextChildSessionId ? { selectedChildSessionId: nextChildSessionId } : {}),
		});
		if (!nextChildSessionId) {
			render(ctx);
			return;
		}
		const generation = streamGeneration + 1;
		streamGeneration = generation;
		subscribedChildSessionId = nextChildSessionId;
		render(ctx);
		try {
			closeStream = input.openStream(nextChildSessionId, (event: SubagentStreamEvent) => {
				if (generation !== streamGeneration || event.childSessionId !== subscribedChildSessionId) return;
				appendTapTranscriptEvent(transcript, event);
				render();
			});
		} catch (error) {
			streamGeneration += 1;
			if (subscribedChildSessionId === nextChildSessionId) subscribedChildSessionId = undefined;
			closeStream = undefined;
			input.warn?.(`failed to open tap stream for ${nextChildSessionId}`, error);
			appendTapTranscriptEvent(transcript, {
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
		resetTapTranscript(transcript, {});
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
		const isDownKey = matchesKey(data, "ctrl+/");
		const isLeftKey = matchesKey(data, "ctrl+,");
		const isRightKey = matchesKey(data, "ctrl+.");
		const isUpKey = matchesKey(data, "escape");
		const isToolsExpandKey = matchesKey(data, "ctrl+o");
		const isTapKey = isDownKey || isLeftKey || isRightKey || isUpKey;
		if ((isTapKey || isToolsExpandKey) && (isKeyRelease(data) || isKeyRepeat(data))) {
			return isTapKey && active ? { consume: true } : undefined;
		}
		if (!active) {
			if (!isDownKey) return undefined;
			return open() ? { consume: true } : undefined;
		}
		if (isDownKey) {
			if (Date.now() - openedAt >= 300) handleMove("down");
			return { consume: true };
		}
		if (isLeftKey) {
			handleMove("left");
			return { consume: true };
		}
		if (isRightKey) {
			handleMove("right");
			return { consume: true };
		}
		if (isUpKey) {
			const wasAtChild = Boolean(selection?.childSessionId);
			if (!wasAtChild && Date.now() - movedUpToRootAt < 300) return { consume: true };
			handleMove("up");
			if (wasAtChild && active && !selection?.childSessionId) movedUpToRootAt = Date.now();
			return { consume: true };
		}
		if (isToolsExpandKey) {
			const ctx = latestCtx;
			if (!ctx?.hasUI) return undefined;
			const expanded = !ctx.ui.getToolsExpanded();
			ctx.ui.setToolsExpanded(expanded);
			setTapTranscriptToolsExpanded(transcript, expanded);
			render(ctx);
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
		latestCtx?.ui.setWidget(TAP_TRANSCRIPT_KEY, undefined);
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

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import type { SubagentStreamEvent, SubagentStreamHandler } from "./stream.ts";
import { buildPromptVars } from "../z-prompt-vars/prompt-vars.ts";
import { createTapFooterFormatters, formatTapFooterTree, moveTapSelection, normalizeTapSelection, resolveSubagentSeparatorColor, resolveSubagentStatusColors, selectedTapNode, type TapRunRoot, type TapSelection } from "./tap-navigation.ts";
import { appendTapTranscriptTreeEvent, createTapTranscriptTreeComponent, createTapTranscriptTreeState, requestTapTranscriptTreeRender, resetTapTranscriptTree, setTapTranscriptTreeToolsExpanded, TAP_STATUS_KEY, TAP_TRANSCRIPT_KEY } from "./tap-transcript-tree.ts";

export interface TapController {
	handleCtx(ctx: ExtensionContext): void;
	refresh(): void;
	close(): void;
	dispose(): void;
	isActive(): boolean;
}

export interface TapControllerInput {
	getRoots(ctx: ExtensionContext): TapRunRoot[];
	openStream(childSessionId: string, handler: SubagentStreamHandler): () => void;
	onPoll?: (ctx: ExtensionContext, selectedChildSessionId?: string) => void;
	pollIntervalMs?: number;
	warn?: (message: string, error?: unknown) => void;
	onClose?: () => void;
}

function hasTapTarget(roots: TapRunRoot[]): boolean {
	return roots.some((root) => root.children.length > 0);
}

function isTapDownKey(data: string): boolean {
	// Legacy terminals commonly encode Ctrl+/ as ASCII Unit Separator.
	// pi-tui parses that byte as ctrl+-, so keep an explicit fallback for
	// the documented tap-down binding.
	return matchesKey(data, "ctrl+/") || data === "\x1f";
}

const TAP_STREAM_RENDER_INTERVAL_MS = 500;
const TAP_FOOTER_REFRESH_DEBOUNCE_MS = 75;
const FOOTER_COLOR_CACHE_TTL_MS = 2_000;

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
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let transcriptWidgetChildSessionId: string | undefined;
	let polling = false;
	let lastFooterTree: string | undefined;
	let cachedFooterColors: { cwd: string; expiresAt: number; statusColors: ReturnType<typeof resolveSubagentStatusColors>; separatorColor: string } | undefined;
	const transcript = createTapTranscriptTreeState();

	function clearScheduledRender(): void {
		if (!renderTimer) return;
		clearTimeout(renderTimer);
		renderTimer = undefined;
	}

	function clearScheduledRefresh(): void {
		if (!refreshTimer) return;
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
	}

	function resolveFooterColors(cwd: string): { statusColors: ReturnType<typeof resolveSubagentStatusColors>; separatorColor: string } {
		const now = Date.now();
		if (cachedFooterColors && cachedFooterColors.cwd === cwd && cachedFooterColors.expiresAt > now) {
			return cachedFooterColors;
		}
		const vars = buildPromptVars(cwd).storedVars;
		const statusColors = resolveSubagentStatusColors(vars);
		const separatorColor = resolveSubagentSeparatorColor(vars);
		cachedFooterColors = { cwd, expiresAt: now + FOOTER_COLOR_CACHE_TTL_MS, statusColors, separatorColor };
		return { statusColors, separatorColor };
	}

	function clearStream(): void {
		clearScheduledRender();
		streamGeneration += 1;
		if (closeStream) closeStream();
		closeStream = undefined;
		subscribedChildSessionId = undefined;
	}

	function renderFooter(ctx = latestCtx): void {
		if (!ctx?.hasUI || !active) return;
		const { statusColors, separatorColor } = resolveFooterColors(ctx.cwd);
		const footerTree = formatTapFooterTree(
			roots,
			selection,
			createTapFooterFormatters(ctx.ui.theme, statusColors, separatorColor),
			{ selectedMarker: "● " },
		);
		if (footerTree === lastFooterTree) return;
		ctx.ui.setStatus(TAP_STATUS_KEY, footerTree);
		lastFooterTree = footerTree;
	}

	function renderTranscript(ctx = latestCtx): void {
		if (!ctx?.hasUI || !active) return;
		setTapTranscriptTreeToolsExpanded(transcript, ctx.ui.getToolsExpanded());
		const selectedChildSessionId = selection?.childSessionId;
		if (selectedChildSessionId) {
			if (transcriptWidgetChildSessionId === selectedChildSessionId && requestTapTranscriptTreeRender(transcript)) return;
			transcriptWidgetChildSessionId = selectedChildSessionId;
			ctx.ui.setWidget(TAP_TRANSCRIPT_KEY, (tui, theme) => createTapTranscriptTreeComponent(transcript, tui, theme), { placement: "aboveEditor" });
		} else if (transcriptWidgetChildSessionId !== undefined) {
			transcriptWidgetChildSessionId = undefined;
			ctx.ui.setWidget(TAP_TRANSCRIPT_KEY, undefined);
		}
	}

	function render(ctx = latestCtx): void {
		renderTranscript(ctx);
		renderFooter(ctx);
	}

	function scheduleTranscriptRender(): void {
		if (!latestCtx?.hasUI || !active || renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			renderTranscript();
		}, TAP_STREAM_RENDER_INTERVAL_MS);
		renderTimer.unref?.();
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
				input.onPoll?.(ctx, subscribedChildSessionId);
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

	function subscribeSelectedChild(ctx = latestCtx, sameChildRender: "full" | "footer" = "full"): void {
		if (!ctx || !selection) return;
		const node = selectedTapNode(roots, selection);
		const nextChildSessionId = node?.childSessionId;
		if (nextChildSessionId === subscribedChildSessionId) {
			if (sameChildRender === "footer") renderFooter(ctx);
			else render(ctx);
			return;
		}
		clearStream();
		resetTapTranscriptTree(transcript, {
			...(nextChildSessionId ? { selectedChildSessionId: nextChildSessionId } : {}),
		});
		if (!nextChildSessionId) {
			clearPollTimer();
			render(ctx);
			return;
		}
		ensurePollTimer();
		const generation = streamGeneration + 1;
		streamGeneration = generation;
		subscribedChildSessionId = nextChildSessionId;
		render(ctx);
		try {
			closeStream = input.openStream(nextChildSessionId, (event: SubagentStreamEvent) => {
				if (generation !== streamGeneration || event.childSessionId !== subscribedChildSessionId) return;
				appendTapTranscriptTreeEvent(transcript, event);
				scheduleTranscriptRender();
			});
		} catch (error) {
			streamGeneration += 1;
			if (subscribedChildSessionId === nextChildSessionId) subscribedChildSessionId = undefined;
			closeStream = undefined;
			input.warn?.(`failed to open tap stream for ${nextChildSessionId}`, error);
			appendTapTranscriptTreeEvent(transcript, {
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

	function open(initialSelection: TapSelection = {}, ctx = latestCtx): boolean {
		if (!ctx?.hasUI) return false;
		clearScheduledRefresh();
		lastFooterTree = undefined;
		roots = rebuildRoots(ctx);
		if (!hasTapTarget(roots)) return false;
		const nextSelection = normalizeTapSelection(roots, initialSelection);
		if (!nextSelection) return false;
		active = true;
		selection = nextSelection;
		resetTapTranscriptTree(transcript, {});
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
		const isDownKey = isTapDownKey(data);
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
			return open({ rootIndex: 0 }) ? { consume: true } : undefined;
		}
		if (isDownKey) {
			handleMove("down");
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
			handleMove("up");
			return { consume: true };
		}
		if (isToolsExpandKey) {
			const ctx = latestCtx;
			if (!ctx?.hasUI) return undefined;
			const expanded = !ctx.ui.getToolsExpanded();
			ctx.ui.setToolsExpanded(expanded);
			setTapTranscriptTreeToolsExpanded(transcript, expanded);
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
		const wasActive = active;
		active = false;
		selection = undefined;
		roots = [];
		clearScheduledRefresh();
		clearPollTimer();
		clearStream();
		if (latestCtx?.hasUI) {
			latestCtx.ui.setWidget(TAP_TRANSCRIPT_KEY, undefined);
			transcriptWidgetChildSessionId = undefined;
			latestCtx.ui.setStatus(TAP_STATUS_KEY, undefined);
			lastFooterTree = undefined;
		}
		if (wasActive) input.onClose?.();
	}

	return {
		handleCtx(ctx: ExtensionContext): void {
			latestCtx = ctx;
			ensureInputListener(ctx);
		},
		refresh(): void {
			if (!active || refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = undefined;
				if (!active) return;
				roots = rebuildRoots();
				selection = normalizeTapSelection(roots, selection);
				if (!selection) {
					close();
					return;
				}
				subscribeSelectedChild(undefined, "footer");
			}, TAP_FOOTER_REFRESH_DEBOUNCE_MS);
			refreshTimer.unref?.();
		},
		close,
		isActive(): boolean {
			return active;
		},
		dispose(): void {
			close();
			if (unsubscribeInput) unsubscribeInput();
			unsubscribeInput = undefined;
			latestCtx = undefined;
		},
	};
}

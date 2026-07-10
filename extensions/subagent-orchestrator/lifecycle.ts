import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatUserLaunchNotification } from "./footer-status.ts";
import { parseUserDispatch } from "./user-dispatch.ts";
import { SubagentEditor } from "./subagent-editor.ts";
import { firstTextContent } from "./tool-results.ts";
import type { DelegationContextResolver } from "./delegation-context.ts";
import type { NormalizedDelegationRequest, ProgrammaticSubagentResponse } from "./types.ts";

interface ActiveLifecycleRegistration {
	token: symbol;
	dispose(): void;
}

const lifecycleOwners = new WeakMap<object, ActiveLifecycleRegistration>();

export interface OrchestratorLifecycleOptions {
	pi: ExtensionAPI;
	delegationContext: DelegationContextResolver;
	getLatestCtx(): ExtensionContext | null;
	setLatestCtx(ctx: ExtensionContext | null): void;
	hydrate(ctx: ExtensionContext, request: NormalizedDelegationRequest, thinking?: string): NormalizedDelegationRequest;
	launch(ctx: ExtensionContext, modeId: string, request: NormalizedDelegationRequest): Promise<{ response: ProgrammaticSubagentResponse }>;
	acknowledgeVisibleTerminalRuns(ctx: ExtensionContext): void;
	updateFooter(ctx: ExtensionContext, force?: boolean): void;
	handleTapContext(ctx: ExtensionContext): void;
	ensureStateReady(): void;
	restoreSnapshots(entries: unknown[]): void;
	reconcileOwned(ctx: ExtensionContext): void;
	reconcileDuplicateHandbacks(ctx: ExtensionContext): void;
	flushQueuedHandbacks(ctx: ExtensionContext): void;
	scheduleHandbackFlush(): void;
	shutdown(): void | Promise<void>;
}

export function registerOrchestratorLifecycle(options: OrchestratorLifecycleOptions): void {
	const { pi } = options;
	const owner = pi as object;
	lifecycleOwners.get(owner)?.dispose();
	const token = Symbol("subagent-orchestrator-lifecycle");
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (lifecycleOwners.get(owner)?.token === token) lifecycleOwners.delete(owner);
		void options.shutdown();
	};
	lifecycleOwners.set(owner, { token, dispose });
	const ownsLifecycle = (): boolean => !disposed && lifecycleOwners.get(owner)?.token === token;

	pi.on("input", async (event, ctx) => {
		if (!ownsLifecycle()) return { action: "continue" };
		options.setLatestCtx(ctx);
		if (event.source !== "interactive") return { action: "continue" };
		options.acknowledgeVisibleTerminalRuns(ctx);
		options.updateFooter(ctx, true);
		if ((event.images?.length ?? 0) > 0) return { action: "continue" };
		const currentMode = options.delegationContext.findCurrent(ctx);
		if (!currentMode.modeId || currentMode.availableSubagents.length === 0) return { action: "continue" };
		const parsed = parseUserDispatch(event.text, currentMode.availableSubagents, ctx.cwd);
		if (!parsed) return { action: "continue" };
		const request = options.hydrate(ctx, {
			shape: "single",
			agent: parsed.agent,
			async: true,
			context: parsed.context,
			showRunCard: false,
			task: parsed.task,
		}, pi.getThinkingLevel());
		const launched = await options.launch(ctx, currentMode.modeId, request);
		const responseText = firstTextContent(launched.response.result.content);
		if (launched.response.isError) {
			if (ctx.hasUI) ctx.ui.notify(responseText ?? launched.response.errorText ?? "Background subagent launch failed.", "warning");
			return { action: "handled" };
		}
		if (ctx.hasUI) {
			const message = formatUserLaunchNotification(parsed.agent);
			ctx.ui.notify(ctx.ui.theme.fg("accent", ctx.ui.theme.bold(message)), "info");
		}
		return { action: "handled" };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ownsLifecycle()) return;
		options.setLatestCtx(ctx);
		options.handleTapContext(ctx);
		options.ensureStateReady();
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new SubagentEditor(
				tui,
				theme,
				keybindings,
				() => options.delegationContext.currentAvailableSubagents(options.getLatestCtx() ?? ctx),
			));
		}
		options.restoreSnapshots(ctx.sessionManager.getBranch());
		options.reconcileOwned(ctx);
		options.reconcileDuplicateHandbacks(ctx);
		options.flushQueuedHandbacks(ctx);
		options.updateFooter(ctx, true);
		options.scheduleHandbackFlush();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ownsLifecycle()) return;
		options.setLatestCtx(ctx);
		options.handleTapContext(ctx);
		options.reconcileOwned(ctx);
		options.reconcileDuplicateHandbacks(ctx);
		options.flushQueuedHandbacks(ctx);
		options.updateFooter(ctx, true);
		options.scheduleHandbackFlush();
	});

	pi.on("session_shutdown", async () => {
		if (!ownsLifecycle()) return;
		dispose();
	});
}

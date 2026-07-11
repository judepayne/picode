import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatRunCardLines } from "./run-ui.ts";
import { getRenderableRunSnapshot } from "./run-live-state.ts";
import { formatContinuationTitle } from "./session-entries.ts";
import type { OrchestratorContinuationMessageDetails, OrchestratorRunMessageDetails } from "./types.ts";

function shortRunId(runId: string | undefined): string | undefined {
	if (typeof runId !== "string" || !runId.trim()) return undefined;
	return runId.slice(0, 8);
}

function collapsePreview(text: string | undefined, maxLines = 8, maxChars = 280): string | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const lines = trimmed.split(/\r?\n/);
	const sliced = lines.slice(0, maxLines).join("\n");
	if (trimmed.length <= maxChars && lines.length <= maxLines) return trimmed;
	const shortened = sliced.length > maxChars ? `${sliced.slice(0, maxChars - 1).trimEnd()}…` : sliced;
	return `${shortened}\n…`;
}

export function createRunMessageComponent(
	details: OrchestratorRunMessageDetails,
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getRenderableRunSnapshot(details);
		if (snapshot.version !== lastVersion) {
			lastVersion = snapshot.version;
			container.clear();
			container.addChild(new Spacer(1));
			const boxTheme = snapshot.details.status === "failed"
				? "toolErrorBg"
				: snapshot.details.status === "complete"
					? "toolSuccessBg"
					: "toolPendingBg";
			const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
			const inner = new Container();
			inner.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent orchestrator run card")), 0, 0));
			inner.addChild(new Text("", 0, 0));
			for (const line of formatRunCardLines(snapshot.details)) {
				inner.addChild(new Text(line, 0, 0));
			}
			box.addChild(inner);
			container.addChild(box);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

export function createContinuationMessageComponent(
	message: { details?: unknown; content?: unknown },
	options: { expanded?: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Box {
	const details = (message.details ?? {}) as Partial<OrchestratorContinuationMessageDetails>;
	const childCount = typeof details.childCount === "number"
		? details.childCount
		: Array.isArray(details.handbackIds) ? details.handbackIds.length : 1;
	const consumer = details.consumer === "user" ? "user" : "agent";
	const title = formatContinuationTitle(childCount, consumer, details.agent);
	const runIds = Array.isArray(details.runIds)
		? details.runIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		: [];
	const titleRunId = consumer === "agent" && runIds.length === 1 ? shortRunId(runIds[0]) : undefined;
	const content = typeof message.content === "string" ? message.content.trim() : "";
	const boxBg = consumer === "user" ? "toolPendingBg" : "customMessageBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxBg, text));
	const titleColor = consumer === "user" ? "accent" : "success";
	const titleText = `${theme.fg(titleColor, title)}${titleRunId ? ` ${theme.bold(titleRunId)}` : ""}`;
	if (!content) {
		box.addChild(new Text(titleText, 0, 0));
		return box;
	}
	if (options.expanded) {
		box.addChild(new Text(`${titleText}\n\n${content}`, 0, 0));
		return box;
	}
	if (consumer === "user") {
		const preview = collapsePreview(content, 8, 700) ?? content;
		const hint = preview !== content
			? theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)
			: undefined;
		const body = hint ? `${titleText}\n\n${preview}\n\n${hint}` : `${titleText}\n\n${preview}`;
		box.addChild(new Text(body, 0, 0));
		return box;
	}
	const hint = theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
	box.addChild(new Text(`${titleText} ${hint}`, 0, 0));
	return box;
}

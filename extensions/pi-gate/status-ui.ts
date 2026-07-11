import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GateAutoApproverManager } from "./auto-approver/manager.ts";
import { isWithinRoot, normalizeAbsPath, normalizeSlashes } from "./matching.ts";
import { loadGateSemanticConfig } from "./semantic/loader.ts";

const SESSION_STATUS_KEY = "gate";
const GATE_ERROR_STATUS = "gate:error";

export function displayStatusPath(cwd: string, value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizeAbsPath(value);
	const cwdPath = normalizeAbsPath(cwd);
	const homePath = normalizeAbsPath(os.homedir());
	if (isWithinRoot(cwdPath, normalized)) return normalizeSlashes(path.relative(cwdPath, normalized) || ".");
	if (isWithinRoot(homePath, normalized)) return `~/${normalizeSlashes(path.relative(homePath, normalized))}`;
	return value;
}

export function formatGateAutoStatusMessage(ctx: ExtensionContext, status: ReturnType<GateAutoApproverManager["status"]>, startOnSession: boolean, runtimeEnabled: boolean): string {
	const configured = status.backendType === "pi-model" ? Boolean(status.provider && status.model) : Boolean(status.endpoint || (status.serverPath && status.modelPath));
	const loadedSemantic = loadGateSemanticConfig(path.dirname(fileURLToPath(import.meta.url)), ctx.cwd);
	const lines = [
		`Gate auto: ${status.enabled ? runtimeEnabled ? "on" : "configured, not running" : "off"}`,
		`Config: ${displayStatusPath(ctx.cwd, loadedSemantic.configPath)}`,
		`Backend: ${status.backendType ?? "managed-llama"}`,
	];
	if (runtimeEnabled) {
		lines.push(`Runtime: ${status.healthy ? "ready" : "not ready"}${status.mode !== "disabled" ? ` (${status.mode}${status.pid ? `, pid ${status.pid}` : ""})` : ""}`);
		if (status.endpoint) lines.push(`Endpoint: ${status.endpoint}`);
	} else if (status.enabled) {
		lines.push(status.backendType === "pi-model" ? "Runtime: stopped (run /gate auto on to validate model access)" : "Runtime: stopped (run /gate auto on to start)");
	}
	if (status.enabled || startOnSession) lines.push(`Starts on Pi launch: ${startOnSession ? "yes" : "no"}`);
	if (configured) {
		if (status.backendType === "pi-model") {
			lines.push(`Provider: ${status.provider}`);
			lines.push(`Model: ${status.model}`);
			lines.push(`Thinking: ${status.thinking ?? "off"}`);
			lines.push("Cache: provider-dependent");
			lines.push("Privacy: full Gate auto semantic context is sent to this provider.");
		} else {
			if (status.serverPath) lines.push(`Server: ${displayStatusPath(ctx.cwd, status.serverPath)}`);
			if (status.modelPath) lines.push(`Model: ${displayStatusPath(ctx.cwd, status.modelPath)}`);
		}
	} else {
		lines.push("Setup: not configured (run /gate auto setup)");
	}
	if (runtimeEnabled && status.auditPath) lines.push(`Audit: ${displayStatusPath(ctx.cwd, status.auditPath)}`);
	if (loadedSemantic.error) lines.push(`Problem: ${loadedSemantic.error}`);
	if (status.lastError) lines.push(`Runtime problem: ${status.lastError}`);
	return lines.join("\n");
}

export function updateStatus(
	ctx: ExtensionContext,
	profileName: string | undefined,
	sessionAllows: Set<string>,
	yolo = false,
	locked = false,
	autoEnabled = false,
): void {
	if (!ctx.hasUI) return;
	if (yolo) {
		ctx.ui.setStatus(SESSION_STATUS_KEY, GATE_ERROR_STATUS);
		return;
	}
	const lockSuffix = locked ? "🔒" : "";
	const autoSuffix = autoEnabled ? " \u001b[1;38;2;247;207;5mauto\u001b[0m" : "";
	const sessionSuffix = sessionAllows.size > 0 ? ` +${sessionAllows.size}` : "";
	ctx.ui.setStatus(SESSION_STATUS_KEY, `gate:${profileName ?? "base"}${lockSuffix}${autoSuffix}${sessionSuffix}`);
}

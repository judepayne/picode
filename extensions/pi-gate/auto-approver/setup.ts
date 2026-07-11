import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setVar } from "../../z-prompt-vars/prompt-vars.ts";

const GATE_AUTO_SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const GATE_AUTO_SETUP_MAX_OUTPUT_CHARS = 8000;

function truncateSetupOutput(value: string): string {
	if (value.length <= GATE_AUTO_SETUP_MAX_OUTPUT_CHARS) return value;
	return `${value.slice(0, GATE_AUTO_SETUP_MAX_OUTPUT_CHARS)}\n[truncated ${value.length - GATE_AUTO_SETUP_MAX_OUTPUT_CHARS} chars]`;
}

interface GateAutoSetupWriteResult {
	scope: "project" | "global";
	configPath: string;
}

export function setGateAutoBackendFromSetup(ctx: Pick<ExtensionContext, "cwd">, backend: Record<string, unknown>): GateAutoSetupWriteResult {
	setVar(ctx.cwd, "gate.auto.backend", backend);
	const state = setVar(ctx.cwd, "gate.auto.timeoutMs", 4000);
	return { scope: state.writeLocation, configPath: state.configPath };
}

export interface ConfiguredPiModelChoice {
	provider: string;
	model: string;
	display: string;
}

export function listConfiguredPiModels(): ConfiguredPiModelChoice[] {
	const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as { providers?: Record<string, { models?: Array<{ id?: unknown; name?: unknown }> }> };
		const out: ConfiguredPiModelChoice[] = [];
		for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
			for (const model of config.models ?? []) {
				if (typeof model.id !== "string" || !model.id.trim()) continue;
				const label = typeof model.name === "string" && model.name.trim() ? `${model.name} (${model.id})` : model.id;
				out.push({ provider, model: model.id, display: `${provider}/${label}` });
			}
		}
		return out.sort((a, b) => a.display.localeCompare(b.display));
	} catch {
		return [];
	}
}

export function managedLlamaBackendConfig(setup: { serverPath: string; modelPath: string }): Record<string, unknown> {
	return {
		type: "managed-llama",
		serverPath: setup.serverPath,
		modelPath: setup.modelPath,
		host: "127.0.0.1",
		port: 0,
		parallel: 2,
		cachePrompt: true,
		startupTimeoutMs: 30000,
		responseFormat: "auto",
		enableThinking: false,
		warmup: true,
	};
}

export function runGateAutoSetupScript(extensionDir: string, onChild?: (child: ChildProcess) => void): Promise<{ installDir: string; serverPath: string; modelPath: string; modelSha256?: string }> {
	const packageRoot = path.resolve(extensionDir, "..", "..");
	const scriptPath = path.join(packageRoot, "scripts", "setup-gate-auto-approver.mjs");
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(scriptPath)) {
			reject(new Error(`setup script not found: ${scriptPath}`));
			return;
		}
		const child = spawn(process.execPath, [scriptPath, "--json"], { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
		onChild?.(child);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Best effort; close/error will settle the promise.
			}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Best effort.
				}
			}, 3000);
		}, GATE_AUTO_SETUP_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout = truncateSetupOutput(stdout + chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = truncateSetupOutput(stderr + chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (timedOut) {
				reject(new Error(`setup timed out after ${GATE_AUTO_SETUP_TIMEOUT_MS}ms`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`setup failed${signal ? ` signal=${signal}` : ` code=${code}`}\n${truncateSetupOutput([stderr, stdout].filter(Boolean).join("\n"))}`.trim()));
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { installDir?: unknown; serverPath?: unknown; modelPath?: unknown; modelSha256?: unknown };
				if (typeof parsed.installDir !== "string" || typeof parsed.serverPath !== "string" || typeof parsed.modelPath !== "string") {
					throw new Error("setup JSON did not include installDir, serverPath, and modelPath");
				}
				resolve({ installDir: parsed.installDir, serverPath: parsed.serverPath, modelPath: parsed.modelPath, modelSha256: typeof parsed.modelSha256 === "string" ? parsed.modelSha256 : undefined });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				reject(new Error(`setup completed but returned invalid JSON: ${message}\n${truncateSetupOutput(stdout)}`));
			}
		});
	});
}


import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";

import type { GateAutoApproverConfig } from "./types.ts";

export interface ManagedLlamaServerStatus {
	endpoint?: string;
	pid?: number;
	healthy: boolean;
	lastError?: string;
}

export class ManagedLlamaServer {
	private proc?: ChildProcessWithoutNullStreams;
	private endpoint?: string;
	private lastError?: string;

	status(): ManagedLlamaServerStatus {
		return { endpoint: this.endpoint, pid: this.proc?.pid, healthy: Boolean(this.proc && this.endpoint && !this.proc.killed), lastError: this.lastError };
	}

	async start(config: GateAutoApproverConfig): Promise<ManagedLlamaServerStatus> {
		if (this.proc && this.endpoint) return this.status();
		if (!config.llama.serverPath || !config.llama.modelPath) {
			this.lastError = "gate.auto.llama.serverPath and gate.auto.llama.modelPath are required for managed mode";
			return this.status();
		}

		const port = config.llama.port || await pickPort(config.llama.host);
		const args = buildArgs(config, port);
		try {
			this.proc = spawn(config.llama.serverPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			this.proc.stdout.resume();
			this.proc.stderr.resume();
			this.endpoint = `http://${config.llama.host}:${port}`;
			this.lastError = undefined;
			this.proc.once("exit", (code, signal) => {
				this.lastError = `llama-server exited code=${code ?? "null"} signal=${signal ?? "null"}`;
				this.proc = undefined;
			});
			this.proc.once("error", (error) => {
				this.lastError = error.message;
			});
			await waitForHealth(this.endpoint, config.llama.startupTimeoutMs);
			return this.status();
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			await this.stop();
			return this.status();
		}
	}

	killNow(): void {
		const proc = this.proc;
		this.proc = undefined;
		this.endpoint = undefined;
		if (!proc || proc.killed) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			// best effort
		}
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		this.proc = undefined;
		this.endpoint = undefined;
		if (!proc || proc.killed) return;
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// best effort
				}
			}, 3000);
			proc.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
			try {
				proc.kill("SIGTERM");
			} catch {
				clearTimeout(killTimer);
				resolve();
			}
		});
	}
}

function buildArgs(config: GateAutoApproverConfig, port: number): string[] {
	const args = ["--model", config.llama.modelPath!, "--host", config.llama.host, "--port", String(port), "--parallel", String(config.llama.parallel)];
	if (config.llama.cachePrompt) args.push("--cache-prompt");
	if (config.llama.ctxSize) args.push("--ctx-size", String(config.llama.ctxSize));
	if (config.llama.threads) args.push("--threads", String(config.llama.threads));
	if (config.llama.threadsBatch) args.push("--threads-batch", String(config.llama.threadsBatch));
	if (config.llama.nGpuLayers !== undefined) args.push("--n-gpu-layers", String(config.llama.nGpuLayers));
	if (config.llama.cacheReuse !== undefined) args.push("--cache-reuse", String(config.llama.cacheReuse));
	return args;
}

function pickPort(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function waitForHealth(endpoint: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			const req = http.get(`${endpoint}/health`, (res) => {
				res.resume();
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
					resolve();
					return;
				}
				retry();
			});
			req.setTimeout(1000, () => {
				req.destroy();
				retry();
			});
			req.on("error", retry);
		};
		const retry = () => {
			if (Date.now() >= deadline) {
				reject(new Error(`llama-server did not become healthy at ${endpoint}`));
				return;
			}
			setTimeout(tick, 200);
		};
		tick();
	});
}

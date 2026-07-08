#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MODEL_URL = "https://huggingface.co/openbmb/MiniCPM5-1B-GGUF/resolve/main/MiniCPM5-1B-Q4_K_M.gguf";
const DEFAULT_MODEL_SHA256 = "81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa";

function defaultInstallDir() {
	if (process.env.PICODE_GATE_AUTO_HOME) return path.resolve(process.env.PICODE_GATE_AUTO_HOME);
	if (process.env.HF_HOME) return path.join(path.resolve(process.env.HF_HOME), "picode", "gate-auto-approver");
	return path.join(os.homedir(), ".pi", "picode", "gate-auto-approver");
}

const DEFAULT_INSTALL_DIR = defaultInstallDir();

function parseArgs(argv) {
	const out = { installDir: DEFAULT_INSTALL_DIR, modelUrl: DEFAULT_MODEL_URL, force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--install-dir") out.installDir = path.resolve(argv[++i] ?? "");
		else if (arg === "--model-url") out.modelUrl = argv[++i] ?? out.modelUrl;
		else if (arg === "--model-sha256") out.modelSha256 = (argv[++i] ?? "").toLowerCase();
		else if (arg === "--server-path") out.serverPath = path.resolve(argv[++i] ?? "");
		else if (arg === "--force") out.force = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--help" || arg === "-h") out.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return out;
}

function usage() {
	return `Usage: node scripts/setup-gate-auto-approver.mjs [--install-dir DIR] [--model-url URL --model-sha256 SHA256] [--server-path PATH] [--force] [--json]

Downloads/verifies the MiniCPM5-1B GGUF model and locates llama-server.
It prints /vars commands; it does not enable gate auto approval.

Default install dir: $PICODE_GATE_AUTO_HOME, else $HF_HOME/picode/gate-auto-approver, else ~/.pi/picode/gate-auto-approver.`;
}

function which(name) {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

async function sha256File(filePath) {
	const hash = crypto.createHash("sha256");
	for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function download(url, target, force, json = false) {
	if (!force && fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) return;
	(json ? console.error : console.log)(`Downloading ${url}`);
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temp = `${target}.tmp`;
	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
	fs.renameSync(temp, target);
}

function verifyServer(serverPath) {
	const result = spawnSync(serverPath, ["--help"], { encoding: "utf8", timeout: 15000 });
	if (result.error) throw result.error;
	if (result.status !== 0 && !(result.stdout || result.stderr).includes("llama")) {
		throw new Error(`${serverPath} did not look like a llama-server binary`);
	}
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	console.log(usage());
	process.exit(0);
}

const expectedModelSha256 = args.modelSha256 ?? (args.modelUrl === DEFAULT_MODEL_URL ? DEFAULT_MODEL_SHA256 : undefined);
if (!expectedModelSha256) throw new Error("Custom --model-url requires --model-sha256 for artifact verification");
if (!/^[a-f0-9]{64}$/.test(expectedModelSha256)) throw new Error("--model-sha256 must be a 64-character hex SHA-256 digest");

const modelName = path.basename(new URL(args.modelUrl).pathname);
const modelPath = path.join(args.installDir, "models", modelName);
await download(args.modelUrl, modelPath, args.force, args.json);
const modelSize = fs.statSync(modelPath).size;
if (modelSize < 1024 * 1024) throw new Error(`model file is suspiciously small: ${modelPath}`);
const actualModelSha256 = await sha256File(modelPath);
if (actualModelSha256 !== expectedModelSha256) {
	throw new Error(`model SHA-256 mismatch for ${modelPath}: expected ${expectedModelSha256}, got ${actualModelSha256}`);
}

const serverPath = args.serverPath ?? which("llama-server");
if (!serverPath) {
	(args.json ? console.error : console.log)(`Model ready: ${modelPath}`);
	(args.json ? console.error : console.log)("Could not find llama-server on PATH. Install llama.cpp (for example: brew install llama.cpp) or rerun with --server-path.");
	process.exit(1);
}
verifyServer(serverPath);

if (args.json) {
	console.log(JSON.stringify({ installDir: args.installDir, serverPath, modelPath, modelSha256: actualModelSha256 }, null, 2));
} else {
	console.log("Gate auto-approver files verified.");
	console.log(`install dir: ${args.installDir}`);
	console.log(`llama-server: ${serverPath}`);
	console.log(`model: ${modelPath}`);
	console.log("");
	console.log("Run these commands in Pi:");
	console.log(`/vars location global`);
	console.log(`/vars set gate.auto.backend ${JSON.stringify({ type: "managed-llama", serverPath, modelPath, host: "127.0.0.1", port: 0, parallel: 2, cachePrompt: true, startupTimeoutMs: 30000, responseFormat: "auto", enableThinking: false, warmup: true })}`);
	console.log(`/vars set gate.auto.timeoutMs 4000`);
	console.log(`/gate auto on`);
	console.log("");
	console.log("Optional: start gate auto automatically after future Pi restarts for this project:");
	console.log(`/vars set gate.auto.startOnSession true`);
	console.log("");
	console.log("Optional real-model smoke test:");
	console.log(`node scripts/eval-gate-auto-approver.mjs --repeat 3`);
}

import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, test } from "node:test";

import { terminateChildProcess } from "../runner-core.ts";

describe("terminateChildProcess", () => {
	test("escalates to SIGKILL when a child ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
		const child = spawn(process.execPath, [
			"-e",
			"process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
		], { stdio: ["ignore", "pipe", "ignore"] });
		await once(child.stdout!, "data");

		const closed = once(child, "close");
		terminateChildProcess(child, 50);
		const [exitCode, signal] = await closed;

		assert.strictEqual(exitCode, null);
		assert.strictEqual(signal, "SIGKILL");
	});

	test("does not escalate after a child exits from SIGTERM", { skip: process.platform === "win32" }, async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});
		await once(child, "spawn");
		const signals: Array<NodeJS.Signals | number> = [];
		const originalKill = child.kill.bind(child);
		child.kill = ((signal?: NodeJS.Signals | number) => {
			signals.push(signal ?? "SIGTERM");
			return originalKill(signal);
		}) as typeof child.kill;

		const closed = once(child, "close");
		terminateChildProcess(child, 100);
		await closed;
		await new Promise((resolve) => setTimeout(resolve, 125));

		assert.deepStrictEqual(signals, ["SIGTERM"]);
	});
});

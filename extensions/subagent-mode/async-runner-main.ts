/**
 * Detached async-runner entry point.
 *
 * Launched by async-executor.ts via `jiti async-runner-main.ts <configPath>`.
 * Reads the run config, executes the spec, persists state, exits.
 *
 * This file is intentionally minimal so importing from it has no side effects;
 * the runtime only runs when `process.argv[2]` is a config path.
 */

import { runAsyncMain } from "./async-executor.ts";

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (!configPath) {
		console.error("async-runner-main: missing config path argument");
		process.exit(2);
	}
	try {
		await runAsyncMain(configPath);
		process.exit(0);
	} catch (error) {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		console.error(`async-runner-main: ${message}`);
		process.exit(1);
	}
}

void main();

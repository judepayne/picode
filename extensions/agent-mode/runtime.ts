import { ENV_TOP_RUN_ID } from "../subagent-mode/depth.ts";

export function isDelegatedSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[ENV_TOP_RUN_ID];
	return typeof value === "string" && value.trim().length > 0;
}

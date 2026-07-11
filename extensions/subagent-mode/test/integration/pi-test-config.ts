import { homedir } from "node:os";
import { join } from "node:path";

const configuredPiDir = process.env.PI_CODING_AGENT_DIR?.trim();
const configuredModel = process.env.PICODE_INTEGRATION_MODEL?.trim();

/** Keep real-child tests on one Pi config even if HOME changes during the test run. */
export const piIntegrationEnv = {
	PI_CODING_AGENT_DIR: configuredPiDir || join(homedir(), ".pi", "agent"),
};

/** Optional deterministic override; otherwise the spawned Pi resolves its configured default. */
export const piIntegrationModel = configuredModel || undefined;

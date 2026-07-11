import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const configuredPiDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(userInfo().homedir, ".pi", "agent");
const configuredModel = process.env.PICODE_INTEGRATION_MODEL?.trim();

function readDefaultModel(configDir: string): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
			defaultProvider?: unknown;
			defaultModel?: unknown;
		};
		const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
		const model = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
		if (!model) return undefined;
		return provider ? `${provider}/${model}` : model;
	} catch {
		return undefined;
	}
}

/** Keep real-child tests on one Pi config even if HOME changes during the test run. */
export const piIntegrationEnv = {
	PI_CODING_AGENT_DIR: configuredPiDir,
};

/** Optional deterministic override; otherwise pin Pi's configured global default. */
export const piIntegrationModel = configuredModel || readDefaultModel(configuredPiDir);

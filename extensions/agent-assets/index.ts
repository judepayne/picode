import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { COLLECT_AGENT_ASSET_CARDS_EVENT, type CollectAgentAssetCardsRequest } from "./contract.ts";
import { resolveAgentAssetManifest } from "./resolver.ts";

export default function agentAssetsExtension(pi: ExtensionAPI): void {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const nativeAgentsDir = path.join(extensionDir, "agents");
	const nativeSubagentsDir = path.join(extensionDir, "subagents");

	pi.events.on(COLLECT_AGENT_ASSET_CARDS_EVENT, (payload) => {
		const request = payload as CollectAgentAssetCardsRequest | undefined;
		if (!request?.entries) return;
		const manifest = resolveAgentAssetManifest({
			cwd: process.cwd(),
			env: process.env,
			nativeAgentsDir,
			nativeSubagentsDir,
		});
		request.entries.push({
			source: "picode",
			priority: 0,
			agents: manifest.agents,
			subagents: manifest.subagents,
			diagnostics: manifest.diagnostics,
		});
	});
}

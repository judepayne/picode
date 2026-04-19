import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { COLLECT_AGENT_ASSET_DIRS_EVENT, type CollectAgentAssetDirsRequest } from "./contract.ts";

export default function agentAssetsExtension(pi: ExtensionAPI): void {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const packageRoot = path.dirname(path.dirname(extensionDir));
	const agentsDir = path.join(packageRoot, "agents");
	const subagentsDir = path.join(packageRoot, "subagents");

	pi.events.on(COLLECT_AGENT_ASSET_DIRS_EVENT, (payload) => {
		const request = payload as CollectAgentAssetDirsRequest | undefined;
		if (!request?.entries) return;
		request.entries.push({
			source: "picode",
			priority: 0,
			...(fs.existsSync(agentsDir) ? { agentsDir } : {}),
			...(fs.existsSync(subagentsDir) ? { subagentsDir } : {}),
		});
	});
}

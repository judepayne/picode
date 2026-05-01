import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveAgentAssetManifest } from "../resolver.ts";

const tempDirs: string[] = [];

function makeRoot(prefix = "pi-agent-assets-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	return root;
}

function writeMarkdown(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("resolveAgentAssetManifest", () => {
	it("returns built-in cards when no overlay config exists", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\nprofile: builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents, [{ name: "Builder", profile: "builder", prompt: "Builder" }]);
		assert.deepEqual(manifest.subagents, [{ name: "Scout", prompt: "Scout" }]);
		assert.deepEqual(manifest.diagnostics, []);
	});

	it("adds non-conflicting user cards from project settings.json", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		const overlaySubagentsDir = path.join(root, "custom-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "05-writer.md"), "---\nname: Writer\n---\nWriter\n");
		writeMarkdown(path.join(overlaySubagentsDir, "reviewer.md"), "---\nname: Reviewer\n---\nReviewer\n");
		writeMarkdown(
			path.join(root, ".pi", "settings.json"),
			JSON.stringify({
				picode: {
					agentsDir: "../custom-agents",
					subagentsDir: "../custom-subagents",
				},
			}, null, 2),
		);

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents.map((card) => card.name), ["Builder", "Writer"]);
		assert.deepEqual(manifest.subagents.map((card) => card.name), ["Reviewer", "Scout"]);
		assert.deepEqual(manifest.diagnostics, []);
	});

	it("merges a same-filename frontmatter-only overlay into a native card", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\nprofile: builder\nsubagents: scout, worker, reviewer\nmodel: openai/foo\n---\nNative prompt\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "01-builder.md"), "---\nsubagents: scout, worker, reviewer, researcher\nmodel:\n---\n   \n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { agentsDir: "../custom-agents" } }, null, 2));

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents, [{
			name: "Builder",
			profile: "builder",
			subagents: "scout, worker, reviewer, researcher",
			model: "openai/foo",
			prompt: "Native prompt",
		}]);
	});

	it("lets a same-filename overlay replace the prompt entirely when body is non-empty", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "03-designer.md"), "---\nname: Designer\ncolor: green\n---\nNative prompt\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "03-designer.md"), "---\ncolor: blue\n---\nUser prompt\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { agentsDir: "../custom-agents" } }, null, 2));

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents, [{ name: "Designer", color: "blue", prompt: "User prompt" }]);
	});

	it("allows explicit non-blank sentinels to override native values", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\nmodel: openai/foo\n---\nNative\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "01-builder.md"), "---\nmodel: -\n---\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { agentsDir: "../custom-agents" } }, null, 2));

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.equal(manifest.agents[0]?.model, "-");
	});

	it("skips user-only cards without a final name", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "05-writer.md"), "---\nprofile: builder\n---\nWriter\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { agentsDir: "../custom-agents" } }, null, 2));

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents.map((card) => card.name), ["Builder"]);
		assert.match(manifest.diagnostics.map((entry) => entry.message).join("\n"), /does not define a name/);
	});

	it("resolves extensions relative to the card that supplies the winning value", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlaySubagentsDir = path.join(root, "custom-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "researcher.md"), "---\nname: Researcher\nextensions: ./native-ext.ts\n---\nNative\n");
		writeMarkdown(path.join(overlaySubagentsDir, "researcher.md"), "---\nextensions: [./overlay-ext.ts]\n---\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { subagentsDir: "../custom-subagents" } }, null, 2));

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.equal(manifest.subagents[0]?.extensions, path.join(overlaySubagentsDir, "overlay-ext.ts"));
	});

	it("reports duplicate final names and keeps the first ordered card", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nFirst\n");
		writeMarkdown(path.join(nativeAgentsDir, "02-builder.md"), "---\nname: Builder\n---\nSecond\n");
		writeMarkdown(path.join(nativeSubagentsDir, "research-a.md"), "---\nname: Research Assistant\n---\nFirst\n");
		writeMarkdown(path.join(nativeSubagentsDir, "research-b.md"), "---\nname: research-assistant\n---\nSecond\n");

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents, [{ name: "Builder", prompt: "First" }]);
		assert.deepEqual(manifest.subagents, [{ name: "Research Assistant", prompt: "First" }]);
		const messages = manifest.diagnostics.map((entry) => entry.message).join("\n");
		assert.match(messages, /Duplicate agent name/);
		assert.match(messages, /Duplicate subagent name/);
	});

	it("reports invalid config and missing overlay directories as diagnostics", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), "{ not-json\n");

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home"), PICODE_AGENT_DIR: "./missing-agents" } });
		const messages = manifest.diagnostics.map((entry) => entry.message).join("\n");
		assert.match(messages, /Failed to read/);
		assert.match(messages, /Configured agent overlay directory does not exist/);
	});

	it("lets env vars override file config", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const fileOverlayDir = path.join(root, "file-overlay");
		const envOverlayDir = path.join(root, "env-overlay");
		writeMarkdown(path.join(nativeAgentsDir, "03-designer.md"), "---\nname: Designer\n---\nNative\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(fileOverlayDir, "04-file.md"), "---\nname: File Overlay\n---\nFile overlay\n");
		writeMarkdown(path.join(envOverlayDir, "05-env.md"), "---\nname: Env Overlay\n---\nEnv overlay\n");
		writeMarkdown(path.join(root, ".pi", "settings.json"), JSON.stringify({ picode: { agentsDir: "../file-overlay" } }, null, 2));

		const manifest = resolveAgentAssetManifest({
			cwd: root,
			nativeAgentsDir,
			nativeSubagentsDir,
			env: {
				HOME: path.join(root, "home"),
				PICODE_AGENT_DIR: "./env-overlay",
			},
		});
		assert.deepEqual(manifest.agents.map((card) => card.name), ["Designer", "Env Overlay"]);
	});
});

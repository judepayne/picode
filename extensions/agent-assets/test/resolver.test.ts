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
	it("returns built-in assets when no overlay config exists", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		writeMarkdown(path.join(nativeAgentsDir, "01-builder.md"), "---\nname: Builder\n---\nBuilder\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.deepEqual(manifest.agents.map((file) => ({ fileName: file.fileName, origin: file.origin })), [{ fileName: "01-builder.md", origin: "native" }]);
		assert.deepEqual(manifest.subagents.map((file) => ({ fileName: file.fileName, origin: file.origin })), [{ fileName: "scout.md", origin: "native" }]);
		assert.deepEqual(manifest.diagnostics, []);
	});

	it("adds non-conflicting user assets from project settings.json", () => {
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
		assert.deepEqual(manifest.agents.map((file) => file.fileName), ["01-builder.md", "05-writer.md"]);
		assert.deepEqual(manifest.subagents.map((file) => file.fileName), ["reviewer.md", "scout.md"]);
		assert.deepEqual(manifest.diagnostics, []);
	});

	it("prefers user files on same-filename clashes when configured", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "03-designer.md"), "---\nname: Designer\n---\nNative\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "03-designer.md"), "---\nname: Designer\n---\nUser\n");
		writeMarkdown(
			path.join(root, ".pi", "settings.json"),
			JSON.stringify({ picode: { agentsDir: "../custom-agents", agentsOnConflict: "prefer-user" } }, null, 2),
		);

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.equal(manifest.agents[0]?.origin, "user");
		assert.equal(path.basename(manifest.agents[0]?.filePath ?? ""), "03-designer.md");
		assert.equal(manifest.agents[0]?.shadowedFilePath, path.join(nativeAgentsDir, "03-designer.md"));
	});

	it("keeps native files on same-filename clashes when configured", () => {
		const root = makeRoot();
		const nativeAgentsDir = path.join(root, "native-agents");
		const nativeSubagentsDir = path.join(root, "native-subagents");
		const overlayAgentsDir = path.join(root, "custom-agents");
		writeMarkdown(path.join(nativeAgentsDir, "03-designer.md"), "---\nname: Designer\n---\nNative\n");
		writeMarkdown(path.join(nativeSubagentsDir, "scout.md"), "---\nname: Scout\n---\nScout\n");
		writeMarkdown(path.join(overlayAgentsDir, "03-designer.md"), "---\nname: Designer\n---\nUser\n");
		writeMarkdown(
			path.join(root, ".pi", "settings.json"),
			JSON.stringify({ picode: { agentsDir: "../custom-agents", agentsOnConflict: "prefer-native" } }, null, 2),
		);

		const manifest = resolveAgentAssetManifest({ cwd: root, nativeAgentsDir, nativeSubagentsDir, env: { HOME: path.join(root, "home") } });
		assert.equal(manifest.agents[0]?.origin, "native");
		assert.match(manifest.diagnostics.map((entry) => entry.message).join("\n"), /Ignoring user agent override 03-designer.md/);
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
		writeMarkdown(path.join(fileOverlayDir, "03-designer.md"), "---\nname: Designer\n---\nFile overlay\n");
		writeMarkdown(path.join(envOverlayDir, "03-designer.md"), "---\nname: Designer\n---\nEnv overlay\n");
		writeMarkdown(
			path.join(root, ".pi", "settings.json"),
			JSON.stringify({ picode: { agentsDir: "../file-overlay", agentsOnConflict: "prefer-native" } }, null, 2),
		);

		const manifest = resolveAgentAssetManifest({
			cwd: root,
			nativeAgentsDir,
			nativeSubagentsDir,
			env: {
				HOME: path.join(root, "home"),
				PICODE_AGENT_DIR: "./env-overlay",
				PICODE_AGENT_OVERRIDE_ON_CONFLICT: "true",
			},
		});
		assert.equal(manifest.agents[0]?.origin, "user");
		assert.equal(manifest.agents[0]?.filePath, path.join(envOverlayDir, "03-designer.md"));
	});
});

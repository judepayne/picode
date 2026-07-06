import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	bootstrapVarsFiles,
	buildPromptVars,
	formatBootstrapResult,
	formatMutationResult,
	formatWriteLocation,
	getGlobalVarsConfigPath,
	getRawStoredVarValue,
	getVarValue,
	getVarsConfigPath,
	getVisibleVars,
	getWriteLocationConfigPath,
	interpolatePrompt,
	setAutomodeEnabled,
	setGateAutoEnabled,
	setVar,
	setWriteLocation,
	unsetVar,
} from "../prompt-vars.ts";

const tempDirs: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
	savedHome = process.env.HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-vars-home-"));
	tempDirs.push(home);
	process.env.HOME = home;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeWorkspace(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-vars-"));
	tempDirs.push(cwd);
	return cwd;
}

describe("prompt-vars", () => {
	test("uses project agent-mode-vars.json overrides for resolved prompt paths", () => {
		const cwd = makeWorkspace();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			getVarsConfigPath(cwd),
			JSON.stringify({ paths: { design: "configs/design.md" } }, null, 2),
		);

		const state = buildPromptVars(cwd, "designer");

		assert.strictEqual(getVarValue(state, "paths.design"), "configs/design.md");
		assert.strictEqual(state.promptVars["design.path"], path.join(cwd, "configs", "design.md"));
		assert.strictEqual(state.promptVars["design.active"], "true");
		assert.strictEqual(state.promptVars["plan.active"], "false");
	});

	test("bootstrapVarsFiles creates the initial project vars files without overwriting existing files", () => {
		const cwd = makeWorkspace();

		const first = bootstrapVarsFiles(cwd);
		const second = bootstrapVarsFiles(cwd);
		const varsFile = fs.readFileSync(getVarsConfigPath(cwd), "utf8");
		const configFile = fs.readFileSync(getWriteLocationConfigPath(cwd), "utf8");

		// Bootstrap creates write-config, project vars, and global vars.
		const expectedFirstCreated = [getVarsConfigPath(cwd), getWriteLocationConfigPath(cwd), getGlobalVarsConfigPath()].sort();
		assert.deepStrictEqual(first.created.sort(), expectedFirstCreated);
		assert.deepStrictEqual(second.existing.sort(), expectedFirstCreated);
		assert.match(varsFile, /"paths"/);
		assert.match(varsFile, /"defaultContext": "fresh"/);
		assert.match(varsFile, /"automode"/);
		assert.match(varsFile, /"enabled": false/);
		assert.match(configFile, /"pi-location": "project"/);
		assert.match(formatBootstrapResult(first), /created=/);
	});

	test("bootstrapVarsFiles does not shadow existing global plan and design paths", () => {
		const cwd = makeWorkspace();
		fs.mkdirSync(path.dirname(getGlobalVarsConfigPath()), { recursive: true });
		fs.writeFileSync(
			getGlobalVarsConfigPath(),
			JSON.stringify({ paths: { plan: "global-plan.md", design: "global-design.md" } }, null, 2),
		);

		const result = bootstrapVarsFiles(cwd);
		const projectConfig = JSON.parse(fs.readFileSync(getVarsConfigPath(cwd), "utf8")) as { paths?: unknown };

		assert.strictEqual(projectConfig.paths, undefined);
		assert.strictEqual(result.state.promptVars["plan.path"], path.join(cwd, "global-plan.md"));
		assert.strictEqual(result.state.promptVars["design.path"], path.join(cwd, "global-design.md"));
	});

	test("setVar persists arbitrary JSON values to the project config and creates the write-location config", () => {
		const cwd = makeWorkspace();

		const state = setVar(cwd, "project", { name: "Prompt Vars", flags: { beta: true, rollout: 25 } });
		const fileContent = fs.readFileSync(getVarsConfigPath(cwd), "utf8");
		const writeConfig = fs.readFileSync(getWriteLocationConfigPath(cwd), "utf8");

		assert.match(fileContent, /"project"/);
		assert.match(writeConfig, /"pi-location": "project"/);
		assert.strictEqual(getRawStoredVarValue(state, "project.flags.beta"), true);
		assert.strictEqual(getVarValue(state, "project.name"), "Prompt Vars");
		assert.strictEqual(getVarValue(state, "project.flags.rollout"), "25");
		assert.strictEqual(getVarValue(state, "project"), JSON.stringify({ name: "Prompt Vars", flags: { beta: true, rollout: 25 } }));
	});

	test("reads global fallback and lets project vars take precedence in the merged view", () => {
		const cwd = makeWorkspace();
		fs.mkdirSync(path.dirname(getGlobalVarsConfigPath()), { recursive: true });
		fs.writeFileSync(
			getGlobalVarsConfigPath(),
			JSON.stringify({
				project: { owner: "global-owner", theme: "dark" },
				subagents: { dispatch: { defaultContext: "fresh" } },
			}, null, 2),
		);
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			getVarsConfigPath(cwd),
			JSON.stringify({ project: { owner: "project-owner" } }, null, 2),
		);

		const state = buildPromptVars(cwd, "planner");

		assert.strictEqual(getVarValue(state, "project.owner"), "project-owner");
		assert.strictEqual(getVarValue(state, "project.theme"), "dark");
		assert.strictEqual(getRawStoredVarValue(state, "subagents.dispatch.defaultContext"), "fresh");
	});

	test("setWriteLocation switches future writes to the global config", () => {
		const cwd = makeWorkspace();
		const locationState = setWriteLocation(cwd, "global");
		const state = setVar(cwd, "project.name", "Global Prompt Vars");

		assert.strictEqual(locationState.writeLocation, "global");
		assert.strictEqual(state.writeLocation, "global");
		assert.ok(fs.existsSync(getGlobalVarsConfigPath()));
		assert.strictEqual(getVarValue(state, "project.name"), "Global Prompt Vars");
		assert.match(formatWriteLocation(state), /"global"/);
	});

	test("vars-file-name override changes the effective project/global vars file name and strips any path prefix", () => {
		const cwd = makeWorkspace();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			getWriteLocationConfigPath(cwd),
			JSON.stringify({ "pi-location": "project", "vars-file-name": "nested/custom-vars.json" }, null, 2),
		);

		const state = setVar(cwd, "project.name", "Custom File");
		const projectPath = path.join(cwd, ".pi", "custom-vars.json");

		assert.strictEqual(state.varsFileName, "custom-vars.json");
		assert.strictEqual(state.projectConfigPath, projectPath);
		assert.ok(fs.existsSync(projectPath));
		assert.strictEqual(getVarValue(state, "project.name"), "Custom File");
		assert.match(formatWriteLocation(state), /vars-file-name="custom-vars\.json"/);
	});

	test("unsetVar removes arbitrary nested keys and prunes empty objects", () => {
		const cwd = makeWorkspace();
		setVar(cwd, "project.name", "Prompt Vars");
		setVar(cwd, "project.owner", "jude");

		let state = unsetVar(cwd, "project.name");
		assert.strictEqual(getVarValue(state, "project.name"), undefined);
		assert.strictEqual(getVarValue(state, "project.owner"), "jude");

		state = unsetVar(cwd, "project.owner");
		assert.strictEqual(getVarValue(state, "project"), undefined);
		assert.ok(!fs.existsSync(getVarsConfigPath(cwd)));
	});

	test("list/get surface merged vars together with built-in derived vars", () => {
		const cwd = makeWorkspace();
		setVar(cwd, "project.name", "Prompt Vars");
		const state = buildPromptVars(cwd, "planner");
		const vars = getVisibleVars(state);

		assert.strictEqual(vars["project.name"], "Prompt Vars");
		assert.strictEqual(vars["automode.enabled"], "false");
		assert.strictEqual(vars["gate.auto.startOnSession"], "false");
		assert.strictEqual(vars["plan.path"], path.join(cwd, ".pi", "plans", "active.md"));
		assert.strictEqual(vars["plan.active"], "true");
		assert.ok(vars.plan.includes("Plan file:"));
	});

	test("interpolatePrompt expands custom vars and leaves unknown placeholders unchanged", () => {
		const cwd = makeWorkspace();
		const state = setVar(cwd, "project.name", "Prompt Vars");

		const rendered = interpolatePrompt(
			"Project: ${project.name}; Plan: ${plan.path}; Unknown: ${unknown.key}",
			state.promptVars,
		);

		assert.strictEqual(
			rendered,
			`Project: Prompt Vars; Plan: ${path.join(cwd, ".pi", "plans", "active.md")}; Unknown: ${"${unknown.key}"}`,
		);
	});

	test("interpolatePrompt supports escaped placeholders", () => {
		const rendered = interpolatePrompt("Literal: \\${project.name}; Real: ${project.name}", { "project.name": "Picode" });
		assert.strictEqual(rendered, "Literal: ${project.name}; Real: Picode");
	});

	test("setting paths.plan updates derived plan vars", () => {
		const cwd = makeWorkspace();
		const planFile = path.join(cwd, "alt", "plan.md");
		fs.mkdirSync(path.dirname(planFile), { recursive: true });
		fs.writeFileSync(planFile, "# Plan\n");

		const state = setVar(cwd, "paths.plan", "alt/plan.md", "planner");

		assert.strictEqual(getVarValue(state, "paths.plan"), "alt/plan.md");
		assert.strictEqual(getVarValue(state, "plan.path"), planFile);
		assert.strictEqual(getVarValue(state, "plan.exists"), "true");
		assert.match(formatMutationResult("paths.plan", state), /write-location="project"/);
		assert.match(formatMutationResult("paths.plan", state), new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	test("automode.enabled can be cleared generically but only enabled through the automode helper", () => {
		const cwd = makeWorkspace();
		assert.throws(
			() => setVar(cwd, "automode.enabled", true),
			/Start automode with \/automode from Designer mode/i,
		);
		assert.throws(
			() => setVar(cwd, "automode", { enabled: true }),
			/Cannot set "automode" directly/i,
		);
		assert.throws(
			() => setVar(cwd, "automode.enabled", "false"),
			/must be a boolean/i,
		);

		let state = setAutomodeEnabled(cwd, true);
		assert.strictEqual(getRawStoredVarValue(state, "automode.enabled"), true);
		assert.strictEqual(getVarValue(state, "automode.enabled"), "true");

		state = setVar(cwd, "automode.enabled", false);
		assert.strictEqual(getRawStoredVarValue(state, "automode.enabled"), false);
		assert.strictEqual(getVarValue(state, "automode.enabled"), "false");
	});

	test("automode writes project state regardless of generic write location", () => {
		const cwd = makeWorkspace();
		setWriteLocation(cwd, "global");

		let state = setAutomodeEnabled(cwd, true);

		assert.strictEqual(state.writeLocation, "global");
		assert.strictEqual(state.projectConfig.automode && typeof state.projectConfig.automode === "object" && !Array.isArray(state.projectConfig.automode)
			? (state.projectConfig.automode as { enabled?: unknown }).enabled
			: undefined, true);
		assert.strictEqual(getVarValue(state, "automode.enabled"), "true");

		state = setVar(cwd, "automode.enabled", false);
		assert.strictEqual(state.writeLocation, "global");
		assert.strictEqual(state.projectConfig.automode && typeof state.projectConfig.automode === "object" && !Array.isArray(state.projectConfig.automode)
			? (state.projectConfig.automode as { enabled?: unknown }).enabled
			: undefined, false);
		assert.strictEqual(getVarValue(state, "automode.enabled"), "false");

		setAutomodeEnabled(cwd, true);
		state = unsetVar(cwd, "automode.enabled");
		assert.strictEqual(getRawStoredVarValue(state, "automode.enabled"), undefined);
		assert.strictEqual(getVarValue(state, "automode.enabled"), "false");
	});

	test("gate.auto.enabled is project-scoped and only enabled through the gate helper", () => {
		const cwd = makeWorkspace();
		assert.strictEqual(getVarValue(buildPromptVars(cwd), "gate.auto.enabled"), "false");
		assert.throws(
			() => setVar(cwd, "gate.auto.enabled", true),
			/Use \/gate auto on/i,
		);
		assert.throws(
			() => setVar(cwd, "gate.auto.enabled", "true"),
			/must be a boolean/i,
		);
		assert.throws(
			() => setVar(cwd, "gate.auto", { enabled: true }),
			/Cannot set "gate\.auto" directly/i,
		);

		setWriteLocation(cwd, "global");
		let state = setGateAutoEnabled(cwd, true);
		assert.strictEqual(state.writeLocation, "global");
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.enabled"), true);
		assert.strictEqual(getVarValue(state, "gate.auto.enabled"), "true");
		assert.strictEqual(state.projectConfig.gate && typeof state.projectConfig.gate === "object" && !Array.isArray(state.projectConfig.gate)
			? (((state.projectConfig.gate as { auto?: unknown }).auto as { enabled?: unknown } | undefined)?.enabled)
			: undefined, true);

		state = setVar(cwd, "gate.auto.enabled", false);
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.enabled"), false);
		assert.strictEqual(getVarValue(state, "gate.auto.enabled"), "false");

		state = unsetVar(cwd, "gate.auto.enabled");
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.enabled"), false);
		assert.strictEqual(getVarValue(state, "gate.auto.enabled"), "false");
	});

	test("gate.auto.startOnSession is user-configurable and defaults off", () => {
		const cwd = makeWorkspace();
		assert.strictEqual(getRawStoredVarValue(buildPromptVars(cwd), "gate.auto.startOnSession"), undefined);
		assert.strictEqual(getVarValue(buildPromptVars(cwd), "gate.auto.startOnSession"), "false");
		assert.throws(
			() => setVar(cwd, "gate.auto.startOnSession", "true"),
			/must be a boolean/i,
		);
		const state = setVar(cwd, "gate.auto.startOnSession", true);
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.startOnSession"), true);
		assert.strictEqual(getVarValue(state, "gate.auto.startOnSession"), "true");
	});

	test("global gate.auto.enabled=true does not activate a project without explicit project opt-in", () => {
		const cwd = makeWorkspace();
		fs.mkdirSync(path.dirname(getGlobalVarsConfigPath()), { recursive: true });
		fs.writeFileSync(getGlobalVarsConfigPath(), JSON.stringify({ gate: { auto: { enabled: true, timeoutMs: 900 } } }, null, 2));

		const state = buildPromptVars(cwd);
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.enabled"), false);
		assert.strictEqual(getVarValue(state, "gate.auto.enabled"), "false");
		assert.strictEqual(getRawStoredVarValue(state, "gate.auto.timeoutMs"), 900);
	});

	test("derived vars cannot be set directly", () => {
		const cwd = makeWorkspace();
		assert.throws(
			() => setVar(cwd, "plan.path", "elsewhere.md"),
			/cannot set or unset derived var: plan\.path/i,
		);
	});
});

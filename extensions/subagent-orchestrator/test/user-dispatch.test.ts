import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { parseUserDispatch, shouldOfferUserDispatchAutocomplete } from "../user-dispatch.ts";

const tempDirs: string[] = [];

function makeWorkspace(vars?: unknown): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-user-dispatch-"));
	tempDirs.push(cwd);
	if (vars !== undefined) {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "agent-mode-vars.json"), `${JSON.stringify(vars, null, 2)}\n`, "utf8");
	}
	return cwd;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("user dispatch parsing", () => {
	it("parses a valid routed prefix with the configured default context", () => {
		const cwd = makeWorkspace({ subagents: { dispatch: { defaultContext: "fresh" } } });
		assert.deepEqual(
			parseUserDispatch("~scout inspect the repo", ["scout", "generalist"], cwd),
			{ agent: "scout", context: "fresh", task: "inspect the repo" },
		);
	});

	it("prefers an inline context override", () => {
		const cwd = makeWorkspace({ subagents: { dispatch: { defaultContext: "fork" } } });
		assert.deepEqual(
			parseUserDispatch("~generalist --fresh build the fix", ["scout", "generalist"], cwd),
			{ agent: "generalist", context: "fresh", task: "build the fix" },
		);
	});

	it("falls back to fresh when no dispatch config exists", () => {
		const cwd = makeWorkspace();
		assert.deepEqual(
			parseUserDispatch("~scout inspect the repo", ["scout"], cwd),
			{ agent: "scout", context: "fresh", task: "inspect the repo" },
		);
	});

	it("treats invalid or incomplete prefixes as unrouted", () => {
		const cwd = makeWorkspace();
		assert.equal(parseUserDispatch("~foo inspect", ["scout"], cwd), undefined);
		assert.equal(parseUserDispatch("~scout", ["scout"], cwd), undefined);
		assert.equal(parseUserDispatch("~scout --fork", ["scout"], cwd), undefined);
	});
});

describe("user dispatch autocomplete guard", () => {
	it("only offers completion at the start of the first line", () => {
		assert.equal(shouldOfferUserDispatchAutocomplete(["~sc"], 0, 3), "~sc");
		assert.equal(shouldOfferUserDispatchAutocomplete(["hello ~sc"], 0, 9), undefined);
		assert.equal(shouldOfferUserDispatchAutocomplete(["first", "~sc"], 1, 3), undefined);
	});
});

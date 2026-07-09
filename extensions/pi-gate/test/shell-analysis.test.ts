import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	analyzeShellCommand,
	shellHasSubstitution,
	splitConservativeShellChain,
	splitConservativeShellPipeline,
	tokenizeShellCommand,
} from "../../shared/shell-analysis.ts";

describe("conservative shell analysis", () => {
	it("tokenizes quotes, escaping, separators, pipes, and redirects consistently", () => {
		assert.deepEqual(tokenizeShellCommand("printf '%s \\n' \"a b\" escaped\\ value && cat < in |& grep x >> out"), [
			"printf", "%s \\n", "a b", "escaped value", "&&", "cat", "<", "in", "|&", "grep", "x", ">>", "out",
		]);
	});

	it("reports malformed quoting as parse uncertainty", () => {
		assert.deepEqual(analyzeShellCommand("echo 'unterminated"), {
			tokens: undefined,
			hasSubstitution: false,
			parseUncertain: true,
		});
	});

	it("detects substitutions except inside single quotes or when escaped", () => {
		assert.equal(shellHasSubstitution("echo $(pwd)"), true);
		assert.equal(shellHasSubstitution("echo `pwd`"), true);
		assert.equal(shellHasSubstitution("echo '$(pwd)'"), false);
		assert.equal(shellHasSubstitution("echo \\$(pwd)"), false);
	});

	it("splits only independently assessable chains and preserves quoting", () => {
		assert.deepEqual(splitConservativeShellChain("echo 'a && b'; git status || command git diff"), [
			"echo 'a && b'",
			"git status",
			"command git diff",
		]);
		assert.equal(splitConservativeShellChain("git status | sh"), undefined);
		assert.deepEqual(splitConservativeShellPipeline("cat file |& grep error"), ["cat file", "grep error"]);
		assert.equal(splitConservativeShellChain("git status > out"), undefined);
		assert.equal(splitConservativeShellChain("echo $(pwd)"), undefined);
		assert.equal(splitConservativeShellChain("echo x & echo y"), undefined);
		assert.equal(splitConservativeShellChain("echo 'unterminated"), undefined);
	});
});

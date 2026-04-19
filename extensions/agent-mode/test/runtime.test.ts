import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDelegatedSubagentChildProcess } from "../runtime.ts";

describe("agent-mode runtime", () => {
	it("detects delegated subagent child processes from the top-run env", () => {
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "run-123" }), true);
		assert.equal(isDelegatedSubagentChildProcess({ PI_SUBAGENT_TOP_RUN_ID: "  " }), false);
		assert.equal(isDelegatedSubagentChildProcess({}), false);
	});
});

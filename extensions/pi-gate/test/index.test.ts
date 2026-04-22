import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractMutationTargets } from "../index.ts";

describe("pi-gate bash mutation analysis", () => {
	const cwd = process.cwd();

	it("treats plain find as read-only", () => {
		assert.deepEqual(
			extractMutationTargets("find . -name '*.ts'", cwd),
			{
				mutating: false,
				complex: false,
				paths: [],
				inferredCwdTarget: false,
				reason: "read-only command",
			},
		);
	});

	it("treats find -delete as mutating", () => {
		const analysis = extractMutationTargets("find . -name '*.tmp' -delete", cwd);
		assert.equal(analysis.mutating, true);
		assert.equal(analysis.reason, "find -delete targets");
		assert.ok(analysis.paths.length >= 1);
	});

	it("treats mutating awk patterns as mutating", () => {
		assert.equal(extractMutationTargets("awk 'BEGIN{system(\"touch /tmp/x\")}'", cwd).mutating, true);
		assert.equal(extractMutationTargets("awk 'BEGIN{print 1 > \"out.txt\"}'", cwd).mutating, true);
	});
});

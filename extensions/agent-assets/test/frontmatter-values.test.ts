import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeOptionalFrontmatterString } from "../frontmatter-values.ts";

describe("frontmatter value helpers", () => {
	it("treats missing, blank, and dash sentinel values as omitted", () => {
		assert.equal(normalizeOptionalFrontmatterString(undefined), undefined);
		assert.equal(normalizeOptionalFrontmatterString(""), undefined);
		assert.equal(normalizeOptionalFrontmatterString("   "), undefined);
		assert.equal(normalizeOptionalFrontmatterString("-"), undefined);
		assert.equal(normalizeOptionalFrontmatterString(" '-' "), undefined);
		assert.equal(normalizeOptionalFrontmatterString(' "-" '), undefined);
	});

	it("preserves real unquoted values", () => {
		assert.equal(normalizeOptionalFrontmatterString(" openai-codex/gpt-5.5 "), "openai-codex/gpt-5.5");
		assert.equal(normalizeOptionalFrontmatterString(' "high" '), "high");
	});
});

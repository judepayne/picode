import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionLineage, sessionReferenceInLineage } from "../session-lineage.ts";

describe("session lineage", () => {
	it("matches the current session and all ancestor session files and ids", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-lineage-"));
		try {
			const root = join(tempDir, "root.jsonl");
			const child = join(tempDir, "child.jsonl");
			const grandchild = join(tempDir, "grandchild.jsonl");
			writeFileSync(root, `${JSON.stringify({ type: "session", id: "root-id" })}\n`, "utf8");
			writeFileSync(child, `${JSON.stringify({ type: "session", id: "child-id", parentSession: root })}\n`, "utf8");
			writeFileSync(grandchild, `${JSON.stringify({ type: "session", id: "grandchild-id", parentSession: child })}\n`, "utf8");
			const lineage = buildSessionLineage(grandchild, "fallback-id");
			assert.equal(sessionReferenceInLineage(grandchild, lineage), true);
			assert.equal(sessionReferenceInLineage(child, lineage), true);
			assert.equal(sessionReferenceInLineage(root, lineage), true);
			assert.equal(sessionReferenceInLineage("grandchild-id", lineage), true);
			assert.equal(sessionReferenceInLineage("child-id", lineage), true);
			assert.equal(sessionReferenceInLineage("root-id", lineage), true);
			assert.equal(sessionReferenceInLineage("fallback-id", lineage), true);
			assert.equal(sessionReferenceInLineage("missing-id", lineage), false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

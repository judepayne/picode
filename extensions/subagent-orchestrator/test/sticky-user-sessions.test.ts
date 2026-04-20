import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { buildSessionLineage } from "../session-lineage.ts";
import {
	findStickyUserSubagentSession,
	findStickyUserSubagentSessionIndex,
	upsertStickyUserSubagentSession,
	updateStickyUserSubagentSessionByRun,
	type StickyUserSubagentSession,
} from "../sticky-user-sessions.ts";

describe("sticky user subagent sessions", () => {
	it("matches a sticky entry across descendant session lineage for the same agent", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "sticky-user-subagents-"));
		try {
			const root = join(tempDir, "root.jsonl");
			const child = join(tempDir, "child.jsonl");
			writeFileSync(root, `${JSON.stringify({ type: "session", id: "root-id" })}\n`, "utf8");
			writeFileSync(child, `${JSON.stringify({ type: "session", id: "child-id", parentSession: root })}\n`, "utf8");
			const lineage = buildSessionLineage(child, "child-id");
			const entries: StickyUserSubagentSession[] = [{
				agent: "scout",
				parentSessionFile: root,
				parentSessionId: "root-id",
				sessionFile: "/tmp/scout-session.jsonl",
				createdAt: 1,
				lastUsedAt: 2,
			}];

			assert.equal(findStickyUserSubagentSessionIndex(entries, "scout", lineage), 0);
			assert.equal(findStickyUserSubagentSession(entries, "scout", lineage)?.sessionFile, "/tmp/scout-session.jsonl");
			assert.equal(findStickyUserSubagentSession(entries, "generalist", lineage), undefined);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("replaces the most recent matching thread instead of creating duplicates", () => {
		const lineage = { files: new Set(["/sessions/root.jsonl"]), ids: new Set(["root-id"]) };
		const entries: StickyUserSubagentSession[] = [{
			agent: "scout",
			parentSessionFile: "/sessions/root.jsonl",
			parentSessionId: "root-id",
			sessionFile: "/tmp/old.jsonl",
			createdAt: 1,
			lastUsedAt: 2,
		}];

		const updated = upsertStickyUserSubagentSession(entries, lineage, {
			agent: "scout",
			parentSessionFile: "/sessions/root.jsonl",
			parentSessionId: "root-id",
			sessionFile: "/tmp/new.jsonl",
			childSessionId: "child-2",
			activeRunId: "run-2",
			createdAt: 10,
			lastUsedAt: 11,
		});

		assert.equal(updated.length, 1);
		assert.equal(updated[0]?.sessionFile, "/tmp/new.jsonl");
		assert.equal(updated[0]?.childSessionId, "child-2");
		assert.equal(updated[0]?.activeRunId, "run-2");
		assert.equal(updated[0]?.parentSessionFile, "/sessions/root.jsonl");
		assert.equal(updated[0]?.parentSessionId, "root-id");
		assert.equal(updated[0]?.createdAt, 1);
	});

	it("clears busy state by run id", () => {
		const entries: StickyUserSubagentSession[] = [{
			agent: "scout",
			parentSessionFile: "/sessions/root.jsonl",
			parentSessionId: "root-id",
			sessionFile: "/tmp/new.jsonl",
			activeRunId: "run-2",
			createdAt: 1,
			lastUsedAt: 11,
		}];

		const updated = updateStickyUserSubagentSessionByRun(entries, "run-2", { activeRunId: undefined, lastUsedAt: 20 });
		assert.equal(updated[0]?.activeRunId, undefined);
		assert.equal(updated[0]?.lastUsedAt, 20);
	});
});

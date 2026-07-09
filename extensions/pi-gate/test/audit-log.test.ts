import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { appendGateAutoDecisionAuditRecord, getGateAutoDecisionAuditPath } from "../semantic/audit-log.ts";
import type { GateSemanticAuditRecord } from "../semantic/types.ts";

function makeRecord(overrides: Partial<GateSemanticAuditRecord> = {}): GateSemanticAuditRecord {
	return {
		schemaVersion: 1,
		timestamp: "2026-07-09T00:00:00.000Z",
		pid: 123,
		processKind: "top-level",
		backendMode: "managed",
		...overrides,
	};
}

describe("gate auto audit log", () => {
	it("writes compact JSONL records only when enabled", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-audit-"));
		try {
			const auditPath = getGateAutoDecisionAuditPath(cwd);
			appendGateAutoDecisionAuditRecord(cwd, makeRecord({ requestId: "ignored" }), false);
			assert.equal(fs.existsSync(auditPath), false);

			appendGateAutoDecisionAuditRecord(cwd, makeRecord({ requestId: "request-1", error: undefined }), true);
			const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
			assert.equal(lines.length, 1);
			assert.deepEqual(JSON.parse(lines[0]), {
				schemaVersion: 1,
				timestamp: "2026-07-09T00:00:00.000Z",
				pid: 123,
				processKind: "top-level",
				backendMode: "managed",
				requestId: "request-1",
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("restricts the audit directory and file permissions", { skip: process.platform === "win32" }, () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-audit-mode-"));
		try {
			const auditPath = getGateAutoDecisionAuditPath(cwd);
			fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o755 });
			fs.chmodSync(path.dirname(auditPath), 0o755);
			appendGateAutoDecisionAuditRecord(cwd, makeRecord(), true);
			assert.equal(fs.statSync(path.dirname(auditPath)).mode & 0o777, 0o700);
			assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

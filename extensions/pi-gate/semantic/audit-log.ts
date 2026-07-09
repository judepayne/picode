import * as fs from "node:fs";
import * as path from "node:path";

import type { GateSemanticAuditRecord } from "./types.ts";

export function getGateAutoDecisionAuditPath(cwd: string): string {
	return path.join(cwd, ".pi", "state", "pi-gate", "auto-decisions.jsonl");
}

function compactRecord(record: GateSemanticAuditRecord): GateSemanticAuditRecord {
	const compacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) compacted[key] = value;
	}
	return compacted as GateSemanticAuditRecord;
}

export function appendGateAutoDecisionAuditRecord(cwd: string, record: GateSemanticAuditRecord, enabled: boolean): void {
	if (!enabled) return;
	try {
		const auditPath = getGateAutoDecisionAuditPath(cwd);
		const auditDir = path.dirname(auditPath);
		fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
		try {
			fs.chmodSync(auditDir, 0o700);
		} catch {
			// Best effort on platforms/filesystems that do not support chmod.
		}
		fs.appendFileSync(auditPath, `${JSON.stringify(compactRecord(record))}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			fs.chmodSync(auditPath, 0o600);
		} catch {
			// Best effort on platforms/filesystems that do not support chmod.
		}
	} catch {
		// Audit logging is best-effort and must never change permission decisions.
	}
}

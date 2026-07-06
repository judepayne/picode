import * as fs from "node:fs";
import * as path from "node:path";

import type { GateSemanticAuditRecord } from "./types.ts";

export function getGateAutoDecisionAuditPath(cwd: string): string {
	return path.join(cwd, ".pi", "state", "pi-gate", "auto-decisions.jsonl");
}

export function appendGateAutoDecisionAuditRecord(cwd: string, record: GateSemanticAuditRecord, enabled: boolean): void {
	if (!enabled) return;
	try {
		const auditPath = getGateAutoDecisionAuditPath(cwd);
		fs.mkdirSync(path.dirname(auditPath), { recursive: true });
		fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
	} catch {
		// Audit logging is best-effort and must never change permission decisions.
	}
}

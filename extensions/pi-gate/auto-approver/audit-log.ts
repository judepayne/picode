import * as fs from "node:fs";
import * as path from "node:path";

import type { GateAutoAuditRecord } from "./types.ts";

export function getGateAutoAuditPath(cwd: string): string {
	return path.join(cwd, ".pi", "state", "pi-gate", "auto-approvals.jsonl");
}

function compactRecord(record: GateAutoAuditRecord): GateAutoAuditRecord {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) out[key] = value;
	}
	return out as GateAutoAuditRecord;
}

export function appendGateAutoAuditRecord(cwd: string, record: GateAutoAuditRecord, enabled = true): void {
	if (!enabled) return;
	try {
		const auditPath = getGateAutoAuditPath(cwd);
		fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
		fs.appendFileSync(auditPath, `${JSON.stringify(compactRecord(record))}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			fs.chmodSync(auditPath, 0o600);
		} catch {
			// Best effort on platforms/filesystems that do not support chmod.
		}
	} catch {
		// Audit logging must never change a gate decision.
	}
}

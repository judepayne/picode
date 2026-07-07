import { normalizeSlashes } from "./matching.ts";

const SENSITIVE_PATH_PATTERN = /(^|\/)\.env(\.|$)|(^|\/)\.ssh(\/|$)|(^|\/)\.gnupg(\/|$)|(^|\/)\.aws(\/|$)|id_rsa|id_ed25519|credential|secret|api[_-]?key|password|private[_-]?key|\.(pem|key)$/i;

export function hasSensitivePathCandidate(paths: string[] | undefined): boolean {
	return (paths ?? []).some((candidate) => SENSITIVE_PATH_PATTERN.test(candidate));
}

export function hasSensitiveSearchTarget(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "paths", "file", "files", "target", "pattern"]) {
		const value = record[key];
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			if (typeof item !== "string") continue;
			const normalized = normalizeSlashes(item);
			const pathLikePattern = key !== "pattern" || normalized.includes("/") || normalized.startsWith("~") || normalized.startsWith("$HOME") || normalized.startsWith(".");
			if (pathLikePattern && hasSensitivePathCandidate([normalized])) return true;
		}
	}
	return false;
}

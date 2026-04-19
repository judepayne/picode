import * as fs from "node:fs";

export interface SessionLineage {
	files: ReadonlySet<string>;
	ids: ReadonlySet<string>;
}

interface SessionHeader {
	id?: unknown;
	parentSession?: unknown;
}

function readSessionHeader(sessionFile: string): SessionHeader | undefined {
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;
	const content = fs.readFileSync(sessionFile, "utf8");
	const newlineIndex = content.indexOf("\n");
	const firstLine = (newlineIndex >= 0 ? content.slice(0, newlineIndex) : content).trim();
	if (!firstLine) return undefined;
	try {
		return JSON.parse(firstLine) as SessionHeader;
	} catch {
		return undefined;
	}
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

export function buildSessionLineage(sessionFile?: string, sessionId?: string): SessionLineage {
	const files = new Set<string>();
	const ids = new Set<string>();
	const visitedFiles = new Set<string>();
	const normalizedSessionId = normalizeString(sessionId);
	if (normalizedSessionId) ids.add(normalizedSessionId);
	let currentFile = normalizeString(sessionFile);
	while (currentFile && !visitedFiles.has(currentFile)) {
		visitedFiles.add(currentFile);
		files.add(currentFile);
		const header = readSessionHeader(currentFile);
		const headerId = normalizeString(header?.id);
		if (headerId) ids.add(headerId);
		currentFile = normalizeString(header?.parentSession);
	}
	return { files, ids };
}

export function sessionReferenceInLineage(reference: string | undefined, lineage: SessionLineage): boolean {
	const normalizedReference = normalizeString(reference);
	if (!normalizedReference) return false;
	return lineage.files.has(normalizedReference) || lineage.ids.has(normalizedReference);
}

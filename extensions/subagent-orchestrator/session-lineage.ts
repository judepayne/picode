import * as fs from "node:fs";
import * as path from "node:path";

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
	// Read only the first 64KB to extract the header line, avoiding loading
	// potentially multi-MB session files into memory just for the first line.
	const fd = fs.openSync(sessionFile, "r");
	try {
		const buf = Buffer.alloc(65536);
		const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
		if (bytesRead === 0) return undefined;
		const content = buf.toString("utf8", 0, bytesRead);
		const newlineIndex = content.indexOf("\n");
		const firstLine = (newlineIndex >= 0 ? content.slice(0, newlineIndex) : content).trim();
		if (!firstLine) return undefined;
		try {
			return JSON.parse(firstLine) as SessionHeader;
		} catch {
			return undefined;
		}
	} finally {
		fs.closeSync(fd);
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

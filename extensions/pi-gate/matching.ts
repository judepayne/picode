import * as os from "node:os";
import * as path from "node:path";

export interface CandidateGroup {
	display: string;
	values: string[];
}

export const PATH_SUBJECTS = new Set(["read", "edit", "list", "external_directory"]);

export function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

export function normalizeAbsPath(value: string): string {
	return normalizeSlashes(path.resolve(value));
}

export function normalizePathArg(rawPath: string, cwd: string): string {
	const trimmed = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (trimmed === "~" || trimmed === "$HOME") return normalizeAbsPath(os.homedir());
	if (trimmed.startsWith("~/")) return normalizeAbsPath(path.join(os.homedir(), trimmed.slice(2)));
	if (trimmed.startsWith("$HOME/")) return normalizeAbsPath(path.join(os.homedir(), trimmed.slice(6)));
	return normalizeAbsPath(path.resolve(cwd, trimmed));
}

export function expandPatternValue(pattern: string, cwd: string): string {
	const home = normalizeSlashes(os.homedir());
	let expanded = normalizeSlashes(pattern).replaceAll("${cwd}", normalizeAbsPath(cwd));
	if (expanded === "~" || expanded === "$HOME") expanded = home;
	else if (expanded.startsWith("~/")) expanded = `${home}/${expanded.slice(2)}`;
	else if (expanded.startsWith("$HOME/")) expanded = `${home}/${expanded.slice(6)}`;
	return expanded;
}

export function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function wildcardToRegex(pattern: string): RegExp {
	let regex = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			regex += ".*";
			continue;
		}
		if (ch === "?") {
			regex += ".";
			continue;
		}
		regex += escapeRegex(ch);
	}
	return new RegExp(`^${regex}$`);
}

export function isWithinRoot(root: string, candidate: string): boolean {
	const normalizedRoot = normalizeAbsPath(root);
	const normalizedCandidate = normalizeAbsPath(candidate);
	if (normalizedCandidate === normalizedRoot) return true;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizeCommand(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export function isPathSubject(subject: string): boolean {
	return PATH_SUBJECTS.has(subject);
}

export function buildPathCandidateGroup(rawPath: string, cwd: string): CandidateGroup {
	const absPath = normalizePathArg(rawPath, cwd);
	const values = new Set<string>([absPath]);
	const normalizedRaw = normalizeSlashes(rawPath);
	if (normalizedRaw) values.add(normalizedRaw);
	if (isWithinRoot(cwd, absPath)) {
		values.add(normalizeSlashes(path.relative(normalizeAbsPath(cwd), absPath) || "."));
	}
	return {
		display: absPath,
		values: Array.from(values),
	};
}

export function buildExternalDirectoryGroups(absPaths: string[], cwd: string): CandidateGroup[] {
	const normalizedCwd = normalizeAbsPath(cwd);
	return absPaths
		.map((candidate) => normalizeAbsPath(candidate))
		.filter((candidate) => !isWithinRoot(normalizedCwd, candidate))
		.map((candidate) => ({ display: candidate, values: [candidate] }));
}

export function buildAbsolutePathGroups(absPaths: string[], cwd: string): CandidateGroup[] {
	return absPaths.map((candidate) => {
		const values = new Set<string>([normalizeAbsPath(candidate)]);
		if (isWithinRoot(cwd, candidate)) {
			values.add(normalizeSlashes(path.relative(normalizeAbsPath(cwd), normalizeAbsPath(candidate)) || "."));
		}
		return { display: normalizeAbsPath(candidate), values: Array.from(values) };
	});
}

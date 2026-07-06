import * as fs from "node:fs";
import * as path from "node:path";

export type GateRiskFlag =
	| "credential_or_secret"
	| "broad_destructive"
	| "package_manager"
	| "network_or_remote"
	| "privilege_escalation"
	| "external_mutation"
	| "opaque_or_unknown"
	| "unclassified_bash"
	| "broad_or_surprising";

export interface GateRiskRequest {
	toolName: string;
	subject: string;
	cwd?: string;
	inputSummary?: unknown;
	pathCandidates?: string[];
	bash?: {
		command: string;
		analysis: unknown;
	};
}

export type GateRiskRecommendedDecision = "deny" | "escalate" | "allow_if_clearly_requested";

export interface GateRiskAssessment {
	flags: GateRiskFlag[];
	recommendedDecision: GateRiskRecommendedDecision;
	reason?: string;
	lowRiskAllowCandidate: boolean;
}

function stringifyLower(value: unknown): string {
	try {
		return JSON.stringify(value).toLowerCase();
	} catch {
		return String(value).toLowerCase();
	}
}

function addFlag(flags: GateRiskFlag[], flag: GateRiskFlag): void {
	if (!flags.includes(flag)) flags.push(flag);
}

function commandText(request: GateRiskRequest): string {
	return `${request.bash?.command ?? ""}\n${request.subject}`;
}

function analysisText(request: GateRiskRequest): string {
	return stringifyLower(request.bash?.analysis ?? request.inputSummary ?? {});
}

function combinedText(request: GateRiskRequest): string {
	return `${request.subject}\n${(request.pathCandidates ?? []).join("\n")}\n${request.bash?.command ?? ""}\n${analysisText(request)}`.toLowerCase();
}

function resolveExistingPath(candidate: string): string {
	let current = path.resolve(candidate);
	const missingSegments: string[] = [];
	while (true) {
		try {
			const real = fs.realpathSync.native(current);
			return path.join(real, ...missingSegments.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(candidate);
			missingSegments.push(path.basename(current));
			current = parent;
		}
	}
}

function isInsidePath(parent: string, candidate: string): boolean {
	const parentPath = resolveExistingPath(parent);
	const candidatePath = resolveExistingPath(candidate);
	const relative = path.relative(parentPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isReadOnlyTool(toolName: string): boolean {
	return toolName === "read" || toolName === "ls" || toolName === "list" || toolName === "find" || toolName === "grep";
}

function splitSimpleCommandChain(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote === "single") {
			current += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			current += ch;
			if (ch === "\"") quote = undefined;
			else if (ch === "\\") current += command[++i] ?? "";
			else if (ch === "`" || (ch === "$" && next === "(")) return undefined;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			current += ch;
		} else if (ch === "\"") {
			quote = "double";
			current += ch;
		} else if (ch === "\\") {
			current += ch + (command[++i] ?? "");
		} else if (ch === "|" && next === "|") {
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
			i++;
		} else if (ch === "`" || (ch === "$" && next === "(") || ch === "|" || ch === "<" || ch === ">") {
			return undefined;
		} else if (ch === "&") {
			if (next !== "&") return undefined;
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
			i++;
		} else if (ch === ";" || ch === "\n") {
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
		} else {
			current += ch;
		}
	}
	const finalSegment = current.trim();
	if (finalSegment) segments.push(finalSegment);
	return segments;
}

function hasDangerousShellControl(command: string): boolean {
	return splitSimpleCommandChain(command) === undefined;
}

function isLowRiskSimpleCommand(command: string): boolean {
	return /^(true|echo\b|cat\b|head\b|tail\b|wc\b|du\b|git status\b|git diff\b|git log\b|git show\b|npm pkg get\b|npm test\b|npm run (test|build|lint)\b|node --test\b|node --check\b|grep\b|rg\b|find\b(?!.*\s-(delete|exec|execdir|ok|okdir)\b)|ls\b|pwd\b)/.test(command);
}

function isLowRiskAllowCandidate(request: GateRiskRequest): boolean {
	const command = request.bash?.command.trim() ?? "";
	if (request.toolName === "read") return true;
	if (request.toolName !== "bash") return false;
	const segments = splitSimpleCommandChain(command);
	return Boolean(segments?.length) && segments.every(isLowRiskSimpleCommand);
}

export function assessGateRisk(request: GateRiskRequest): GateRiskAssessment {
	const flags: GateRiskFlag[] = [];
	const command = commandText(request);
	const analysis = analysisText(request);
	const combined = combinedText(request);

	if (/\.ssh|id_rsa|id_ed25519|\.env(\b|\.)|credential|secret|api[_-]?key|password|exfil|private[_-]?key/.test(combined)) {
		addFlag(flags, "credential_or_secret");
	}
	if (/rm\s+[^\n;|&]*--no-preserve-root|\brm\s+-[a-z-]*r[a-z-]*f\s+(\/|~|\*|\.\s*$)|\bfind\b[\s\S]*\s-exec(dir)?\s+rm\s+-[a-z-]*r[a-z-]*f|broad deletion|data loss|destructive system/.test(combined)) {
		addFlag(flags, "broad_destructive");
	}
	if (/packageManager|package-manager|\b(brew|npm|pnpm|yarn|pip|pipx|cargo|gem)\s+(install|add|upgrade|update)\b/i.test(`${command}\n${analysis}`)) {
		addFlag(flags, "package_manager");
	}
	const shellText = request.bash?.command ?? (request.toolName === "bash" ? request.subject : "");
	if (/\b(curl|wget|scp|sftp|ssh|rsync|nc|netcat)\b|https?:\/\//i.test(shellText)) {
		addFlag(flags, "network_or_remote");
	}
	if (/\b(sudo|su)\b|\bchmod\s+[^\n;|&]*\b777\b|\bchown\b|\bgit\s+push\b/i.test(command)) {
		addFlag(flags, "privilege_escalation");
	}
	if (!request.bash && request.cwd && !isReadOnlyTool(request.toolName) && (request.pathCandidates ?? []).some((candidate) => !isInsidePath(request.cwd!, candidate))) {
		addFlag(flags, "external_mutation");
	}
	if (/opaque|unknown/.test(combined) || hasDangerousShellControl(request.bash?.command ?? "") || (splitSimpleCommandChain(request.bash?.command.trim() ?? "") ?? []).some((segment) => /^\.\/[^\s]+/.test(segment)) || /\bfind\b[\s\S]*\s-(exec|execdir|ok|okdir)\b|\b(bash|sh|zsh|python|python3|node|ruby|perl|php)\s+-[ec]\b|\bsed\s+-i\b|\bawk\b.*>/.test(request.bash?.command ?? "")) {
		addFlag(flags, "opaque_or_unknown");
	}
	const lowRiskAllowCandidate = isLowRiskAllowCandidate(request);
	if (request.toolName === "bash" && !lowRiskAllowCandidate && flags.length === 0) {
		addFlag(flags, "unclassified_bash");
	}
	if (/\bbroad\b|surprising/.test(combined)) {
		addFlag(flags, "broad_or_surprising");
	}

	if (flags.includes("credential_or_secret")) {
		return { flags, recommendedDecision: "deny", reason: "sensitive credential or secret access is not auto-approvable", lowRiskAllowCandidate: false };
	}
	if (flags.includes("broad_destructive")) {
		return { flags, recommendedDecision: "deny", reason: "broad destructive operation is not auto-approvable", lowRiskAllowCandidate: false };
	}
	if (flags.includes("package_manager")) {
		return { flags, recommendedDecision: "escalate", reason: "package manager or dependency changes require human review", lowRiskAllowCandidate: false };
	}
	if (flags.includes("network_or_remote")) {
		return { flags, recommendedDecision: "escalate", reason: "network or remote access requires human review", lowRiskAllowCandidate: false };
	}
	if (flags.includes("privilege_escalation")) {
		return { flags, recommendedDecision: "escalate", reason: "privilege escalation or publishing requires human review", lowRiskAllowCandidate: false };
	}
	if (flags.includes("external_mutation")) {
		return { flags, recommendedDecision: "escalate", reason: "external file mutation requires human review", lowRiskAllowCandidate: false };
	}
	if (flags.includes("opaque_or_unknown") || flags.includes("unclassified_bash") || flags.includes("broad_or_surprising")) {
		return { flags, recommendedDecision: "escalate", reason: "opaque, unclassified, broad, or uncertain action requires human review", lowRiskAllowCandidate };
	}

	return { flags, recommendedDecision: "allow_if_clearly_requested", lowRiskAllowCandidate };
}

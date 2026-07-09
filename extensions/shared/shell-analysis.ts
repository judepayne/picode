export interface ConservativeShellAnalysis {
	tokens: string[] | undefined;
	hasSubstitution: boolean;
	hasControlOperator: boolean;
	parseUncertain: boolean;
}

export function tokenizeShellCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;

	const flush = () => {
		if (current) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			else current += ch;
			continue;
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined;
			else if (ch === "\\" && i + 1 < command.length) current += command[++i] ?? "";
			else current += ch;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			continue;
		}
		if (ch === '"') {
			quote = "double";
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i] ?? "";
			continue;
		}
		if (ch === "\n" || ch === "\r") {
			flush();
			tokens.push(";");
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (ch === "<" || ch === ">") {
			flush();
			if (command[i + 1] === ch) {
				tokens.push(`${ch}${ch}`);
				i++;
			} else tokens.push(ch);
			continue;
		}
		if (ch === ";") {
			flush();
			tokens.push(";");
			continue;
		}
		if (ch === "&" || ch === "|") {
			flush();
			if (ch === "|" && command[i + 1] === "&") {
				tokens.push("|&");
				i++;
			} else if (command[i + 1] === ch) {
				tokens.push(`${ch}${ch}`);
				i++;
			} else tokens.push(ch);
			continue;
		}
		current += ch;
	}

	if (quote) return undefined;
	flush();
	return tokens;
}

export function shellHasSubstitution(command: string): boolean {
	let quote: "single" | "double" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined;
			else if (ch === "\\") i++;
			else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
			continue;
		}
		if (ch === "'") quote = "single";
		else if (ch === '"') quote = "double";
		else if (ch === "\\") i++;
		else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
	}
	return false;
}

export function shellHasControlOperator(command: string): boolean {
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < command.length; index++) {
		const ch = command[index];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined;
			else if (ch === "\\") index++;
			continue;
		}
		if (ch === "'") quote = "single";
		else if (ch === '"') quote = "double";
		else if (ch === "\\") index++;
		else if (ch === "\n" || ch === "\r" || ch === ";" || ch === "&" || ch === "|" || ch === "<" || ch === ">") return true;
	}
	return false;
}

export function analyzeShellCommand(command: string): ConservativeShellAnalysis {
	const tokens = tokenizeShellCommand(command);
	return {
		tokens,
		hasSubstitution: shellHasSubstitution(command),
		hasControlOperator: shellHasControlOperator(command),
		parseUncertain: tokens === undefined,
	};
}

export type ConservativeShellOperator = "&&" | "||" | "|" | "|&" | ";";

export interface ConservativeShellComposite {
	segments: string[];
	operators: ConservativeShellOperator[];
}

function parseConservativeShellSegments(command: string, allowPipes: boolean): ConservativeShellComposite | undefined {
	const segments: string[] = [];
	const operators: ConservativeShellOperator[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let requiresFollowingSegment = false;
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
			if (ch === '"') quote = undefined;
			else if (ch === "\\") current += command[++i] ?? "";
			else if (ch === "`" || (ch === "$" && next === "(")) return undefined;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			current += ch;
			requiresFollowingSegment = false;
		} else if (ch === '"') {
			quote = "double";
			current += ch;
			requiresFollowingSegment = false;
		} else if (ch === "\\") {
			current += ch + (command[++i] ?? "");
			requiresFollowingSegment = false;
		} else if (ch === "&" || ch === "|") {
			const isAnd = ch === "&" && next === "&";
			const isOr = ch === "|" && next === "|";
			const isPipe = ch === "|" && next !== "|";
			if ((!isAnd && !isOr && !isPipe) || (isPipe && !allowPipes)) return undefined;
			const segment = current.trim();
			if (!segment) return undefined;
			segments.push(segment);
			operators.push(isAnd ? "&&" : isOr ? "||" : next === "&" ? "|&" : "|");
			current = "";
			requiresFollowingSegment = true;
			if (isAnd || isOr || next === "&") i++;
		} else if (ch === "<" || ch === ">" || ch === "`" || (ch === "$" && next === "(")) {
			return undefined;
		} else if (ch === "\n" || ch === "\r") {
			if (requiresFollowingSegment) {
				current = "";
				continue;
			}
			const segment = current.trim();
			if (segment) {
				segments.push(segment);
				operators.push(";");
			}
			current = "";
		} else if (ch === ";") {
			if (requiresFollowingSegment) return undefined;
			const segment = current.trim();
			if (segment) {
				segments.push(segment);
				operators.push(";");
			}
			current = "";
		} else {
			current += ch;
			if (!/\s/.test(ch)) requiresFollowingSegment = false;
		}
	}
	if (quote || requiresFollowingSegment) return undefined;
	const finalSegment = current.trim();
	if (finalSegment) segments.push(finalSegment);
	return segments.length > 0 ? { segments, operators } : undefined;
}

/**
 * Split only chains whose commands can be assessed independently. Pipes,
 * redirections, background execution, substitutions, and malformed quoting
 * return undefined so callers fail closed.
 */
export function splitConservativeShellChain(command: string): string[] | undefined {
	return parseConservativeShellSegments(command, false)?.segments;
}

/**
 * As above, but treats pipeline components as independent commands. This is
 * suitable only when the caller validates every component conservatively.
 */
export function parseConservativeShellPipeline(command: string): ConservativeShellComposite | undefined {
	return parseConservativeShellSegments(command, true);
}

export function splitConservativeShellPipeline(command: string): string[] | undefined {
	return parseConservativeShellPipeline(command)?.segments;
}

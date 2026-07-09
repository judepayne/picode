export interface ConservativeShellAnalysis {
	tokens: string[] | undefined;
	hasSubstitution: boolean;
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

export function analyzeShellCommand(command: string): ConservativeShellAnalysis {
	const tokens = tokenizeShellCommand(command);
	return {
		tokens,
		hasSubstitution: shellHasSubstitution(command),
		parseUncertain: tokens === undefined,
	};
}

function splitConservativeShellSegments(command: string, allowPipes: boolean): string[] | undefined {
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
			if (ch === '"') quote = undefined;
			else if (ch === "\\") current += command[++i] ?? "";
			else if (ch === "`" || (ch === "$" && next === "(")) return undefined;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			current += ch;
		} else if (ch === '"') {
			quote = "double";
			current += ch;
		} else if (ch === "\\") {
			current += ch + (command[++i] ?? "");
		} else if (ch === "&" || ch === "|") {
			const isAnd = ch === "&" && next === "&";
			const isOr = ch === "|" && next === "|";
			const isPipe = ch === "|" && next !== "|";
			if ((!isAnd && !isOr && !isPipe) || (isPipe && !allowPipes)) return undefined;
			const segment = current.trim();
			if (!segment) return undefined;
			segments.push(segment);
			current = "";
			if (isAnd || isOr || next === "&") i++;
		} else if (ch === "<" || ch === ">" || ch === "`" || (ch === "$" && next === "(")) {
			return undefined;
		} else if (ch === ";" || ch === "\n") {
			const segment = current.trim();
			if (segment) segments.push(segment);
			current = "";
		} else {
			current += ch;
		}
	}
	if (quote) return undefined;
	const finalSegment = current.trim();
	if (finalSegment) segments.push(finalSegment);
	return segments.length > 0 ? segments : undefined;
}

/**
 * Split only chains whose commands can be assessed independently. Pipes,
 * redirections, background execution, substitutions, and malformed quoting
 * return undefined so callers fail closed.
 */
export function splitConservativeShellChain(command: string): string[] | undefined {
	return splitConservativeShellSegments(command, false);
}

/**
 * As above, but treats pipeline components as independent commands. This is
 * suitable only when the caller validates every component conservatively.
 */
export function splitConservativeShellPipeline(command: string): string[] | undefined {
	return splitConservativeShellSegments(command, true);
}

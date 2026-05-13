import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SubagentStreamEvent, SubagentStreamHandler } from "./stream.ts";

export function createJsonlFileSubagentStreamHandler(filePath: string): SubagentStreamHandler {
	const ready = mkdir(dirname(filePath), { recursive: true });
	return async (event: SubagentStreamEvent) => {
		await ready;
		await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
	};
}

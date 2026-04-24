import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildChildPiArgs } from "../pi-spawn.ts";

describe("buildChildPiArgs", () => {
	test("keeps extension-like tool paths when explicit extensions are provided", () => {
		const gatePath = "/tmp/pi-gate";
		const helperPath = "/tmp/helper-ext";
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: ["bash", gatePath],
			extensions: [helperPath],
		});

		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--tools"));
		assert.ok(args.includes("bash"));

		const extensionValues: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			if (args[index] === "--extension") {
				extensionValues.push(args[index + 1] ?? "");
			}
		}

		assert.deepEqual(extensionValues, [helperPath, gatePath]);
	});

	test("deduplicates extension paths gathered from tools and explicit extensions", () => {
		const gatePath = "/tmp/pi-gate";
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: [gatePath],
			extensions: [gatePath],
		});

		const extensionValues: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			if (args[index] === "--extension") {
				extensionValues.push(args[index + 1] ?? "");
			}
		}

		assert.deepEqual(extensionValues, [gatePath]);
	});

	test("passes --no-tools when the resolved tool list is empty", () => {
		const { args } = buildChildPiArgs({
			task: "inspect",
			sessionEnabled: false,
			tools: [],
		});

		assert.ok(args.includes("--no-tools"));
	});
});

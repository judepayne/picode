import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SYNC_TIMEOUT_SECONDS, formatSyncIdleTimeoutMessage, nextSyncIdleTimeoutDelayMs } from "../timeout.ts";

describe("subagent sync timeout", () => {
	it("defaults to a 40 second inactivity timeout", () => {
		assert.equal(DEFAULT_SYNC_TIMEOUT_SECONDS, 40);
		assert.equal(formatSyncIdleTimeoutMessage(40), "delegated subagent timed out after 40s of inactivity");
	});

	it("computes the next idle-timeout check from last activity", () => {
		assert.equal(nextSyncIdleTimeoutDelayMs(1_000, 1_000, 40), 40_000);
		assert.equal(nextSyncIdleTimeoutDelayMs(1_000, 21_000, 40), 20_000);
		assert.equal(nextSyncIdleTimeoutDelayMs(1_000, 41_000, 40), undefined);
	});
});

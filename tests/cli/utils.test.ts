import { expect, test } from "bun:test";
import { refresh } from "@src/cli/utils";
import type { HarnessAdapter } from "@src/harnesses";
import { createTestApp } from "@tests/utils";

test("a refresh with nothing to read reports no issues", async () => {
	const app = createTestApp();

	const refreshed = await refresh(app, 7);

	expect(refreshed).toEqual({ deferred: new Set(), failed: false, issues: "" });
});

test("a refresh whose adapter can't list its sources fails and says why", async () => {
	const app = createTestApp({ adapters: [unlistableAdapter] });

	const refreshed = await refresh(app, 7);

	expect(refreshed.failed).toBe(true);
	expect(Bun.stripANSI(refreshed.issues)).toBe(
		"failed: claude list: the sessions directory is unreadable",
	);
});

const unlistableAdapter: HarnessAdapter = {
	harness: "claude",
	listSources: async () => {
		throw new Error("the sessions directory is unreadable");
	},
	readSource: async () => null,
	snapshot: async () => ({ snapshots: [], warnings: [] }),
};

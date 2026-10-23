import { afterEach, expect, test } from "bun:test";
import { openDatabase } from "@src/database";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a fresh database creates its directory and runs in WAL mode", () => {
	const home = mkdtempSync(join(tmpdir(), "status-test-"));
	temporaryDirectories.push(home);

	const database = openDatabase(join(home, "nested", "status.db"));
	const row = database.$client
		.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
		.get();
	database.$client.close();

	expect(row?.journal_mode).toBe("wal");
});

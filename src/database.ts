import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export function openDatabase(path: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const client = new Database(path, { create: true, strict: true });
	client.run("PRAGMA busy_timeout = 5000");
	client.run("PRAGMA journal_mode = WAL");
	client.run("PRAGMA foreign_keys = ON");
	return drizzle({ client });
}

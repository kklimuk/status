import { Database } from "bun:sqlite";
import type {
	Harness,
	SessionState,
	Surface,
	ToolStatus,
} from "@src/harnesses";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

export type StatusDatabase = ReturnType<typeof openDatabase>;

export function openDatabase(path: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const client = new Database(path, { create: true, strict: true });
	client.run("PRAGMA busy_timeout = 5000");
	client.run("PRAGMA journal_mode = WAL");
	const database = drizzle({ client, schema: { sessions, events, summaries } });
	try {
		migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
	} catch {
		migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
	}
	client.run("PRAGMA foreign_keys = ON");
	return database;
}

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	harness: text("harness").$type<Harness>().notNull(),
	surface: text("surface").$type<Surface>().notNull(),
	parentId: text("parent_id"),
	title: text("title"),
	cwd: text("cwd").notNull(),
	branch: text("branch"),
	state: text("state").$type<SessionState>().notNull(),
	observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
	startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
	lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }).notNull(),
	sourcePath: text("source_path").notNull().unique(),
	readOffset: integer("read_offset").notNull(),
});

export const events = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id),
		key: text("key").notNull(),
		at: integer("at", { mode: "timestamp_ms" }).notNull(),
		role: text("role").$type<"user" | "assistant" | "tool">().notNull(),
		text: text("text").notNull(),
		toolName: text("tool_name"),
		toolTarget: text("tool_target"),
		toolStatus: text("tool_status").$type<ToolStatus>(),
	},
	(table) => [unique().on(table.sessionId, table.key)],
);

export const summaries = sqliteTable("summaries", {
	sessionId: text("session_id")
		.primaryKey()
		.references(() => sessions.id),
	throughEventId: integer("through_event_id").notNull(),
	objective: text("objective").notNull(),
	progress: text("progress").notNull(),
	tried: text("tried").notNull(),
	next: text("next").notNull(),
	blockers: text("blockers").notNull(),
	waitingOn: text("waiting_on").$type<"user" | "external" | "none">().notNull(),
	ask: text("ask"),
	outcome: text("outcome")
		.$type<"in_progress" | "done" | "abandoned">()
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

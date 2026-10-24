import { events, type StatusDatabase, summaries } from "@src/database";
import { max } from "drizzle-orm";

export function newestEventIdBySession(database: Reader): Map<string, number> {
	const rows = database
		.select({ sessionId: events.sessionId, newest: max(events.id) })
		.from(events)
		.groupBy(events.sessionId)
		.all();
	return new Map(rows.map((row) => [row.sessionId, row.newest ?? 0]));
}

export function summariesBySession(
	database: Reader,
): Map<string, StoredSummary> {
	const rows = database.select().from(summaries).all();
	return new Map(rows.map((row) => [row.sessionId, row]));
}

export type Reader = Pick<StatusDatabase, "select">;

export type StoredSummary = typeof summaries.$inferSelect;

export type EventRow = typeof events.$inferSelect;

import type { App } from "@src/app";
import { events, type StatusDatabase, sessions } from "@src/database";
import {
	claudeSessionAbove,
	codexSessionIn,
	type SessionState,
} from "@src/harnesses";
import { describeError } from "@src/utils";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { newestEventIdBySession, summariesBySession } from "./utils";

export function readCatalog(app: App): Catalog {
	const rows = sessionRows(app.database).sort(
		(left, right) =>
			+right.startedAt - +left.startedAt || left.id.localeCompare(right.id),
	);
	const children = Map.groupBy(
		rows.filter((row) => row.parentId !== null),
		(row) => row.parentId,
	);
	const stored = summariesBySession(app.database);
	const newestEventIds = newestEventIdBySession(app.database);
	const familyNewest = new Map<string, number>();
	function newestInFamily(id: string): number {
		const known = familyNewest.get(id);
		if (known !== undefined) {
			return known;
		}
		const newest = Math.max(
			newestEventIds.get(id) ?? 0,
			...(children.get(id) ?? []).map((child) => newestInFamily(child.id)),
		);
		familyNewest.set(id, newest);
		return newest;
	}
	const editedSince = new Date(app.now().getTime() - EDIT_WINDOW_MS);
	return {
		sessions: new Map(rows.map((row) => [row.id, row])),
		children,
		summaries: stored,
		behind: new Set(
			rows
				.filter((row) => {
					const summary = stored.get(row.id);
					return summary && newestInFamily(row.id) > summary.throughEventId;
				})
				.map((row) => row.id),
		),
		edits: editCallsSince(app.database, editedSince),
	};
}

export function listSessions(
	catalog: Catalog,
	filter: ListFilter,
): ListedSession[] {
	const isListed = (session: CatalogSession) =>
		!filter.callers.has(session.id) &&
		(session.state !== "ended" ||
			(filter.all && session.lastEventAt >= filter.since));
	const listed = [...catalog.sessions.values()].filter(isListed);
	const placed = Map.groupBy(
		listed,
		(session) => ancestorsOf(catalog, session).find(isListed)?.id ?? null,
	);
	const edits = editedFiles(catalog, (session) =>
		entryOf(catalog, session, isListed, filter.callers),
	);
	const entries: ListedSession[] = [];
	function place(session: CatalogSession, depth: number) {
		entries.push({ session, depth, edited: edits.get(session.id) ?? [] });
		for (const child of placed.get(session.id) ?? []) {
			place(child, depth + 1);
		}
	}
	for (const top of placed.get(null) ?? []) {
		place(top, 0);
	}
	return entries;
}

export function filesEditedBy(catalog: Catalog, sessionId: string): string[] {
	const edits = editedFiles(catalog, (member) =>
		entryOf(catalog, member, (entry) => entry.id === sessionId, new Set()),
	);
	return edits.get(sessionId) ?? [];
}

export function sessionsMatching(
	database: StatusDatabase,
	idOrPrefix: string,
): CatalogSession[] {
	const rows = sessionRows(database);
	const exact = rows.filter((row) => row.id === idOrPrefix);
	if (exact.length > 0) {
		return exact;
	}
	return rows
		.filter((row) => row.id.startsWith(idOrPrefix))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function onlyMatch(
	matches: CatalogSession[],
): CatalogSession | undefined {
	return matches.length === 1 ? matches[0] : undefined;
}

export async function callerSessionIds(app: App): Promise<Callers> {
	const ids = new Set<string>();
	const codexSession = codexSessionIn(process.env);
	if (codexSession) {
		ids.add(codexSession);
	}
	try {
		const claudeSession = await claudeSessionAbove(
			app.paths.claude,
			process.pid,
		);
		if (claudeSession) {
			ids.add(claudeSession);
		}
		return { ids, warnings: [] };
	} catch (error) {
		const warning = `couldn't find the Claude session running this, so it may be listed: ${describeError(error)}`;
		return { ids, warnings: [warning] };
	}
}

export function recentToolCalls(
	database: StatusDatabase,
	sessionId: string,
	limit: number,
) {
	return database
		.select({
			at: events.at,
			toolName: events.toolName,
			toolTarget: events.toolTarget,
			toolStatus: events.toolStatus,
		})
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.role, "tool")))
		.orderBy(desc(events.at), desc(events.id))
		.limit(limit)
		.all();
}

function editedFiles(
	catalog: Catalog,
	ownerOf: (session: CatalogSession) => string | null,
): Map<string, string[]> {
	const files = new Map<string, Set<string>>();
	for (const edit of catalog.edits) {
		const session = catalog.sessions.get(edit.sessionId);
		const owner = session ? ownerOf(session) : null;
		if (owner === null) {
			continue;
		}
		const owned = files.get(owner) ?? new Set();
		for (const file of (edit.toolTarget ?? "").split("\n")) {
			if (file.trim() !== "") {
				owned.add(file);
			}
		}
		files.set(owner, owned);
	}
	return new Map([...files].map(([id, owned]) => [id, [...owned]]));
}

function entryOf(
	catalog: Catalog,
	session: CatalogSession,
	hasEntry: (session: CatalogSession) => boolean,
	callers: Set<string>,
): string | null {
	for (const member of [session, ...ancestorsOf(catalog, session)]) {
		if (callers.has(member.id)) {
			return null;
		}
		if (hasEntry(member)) {
			return member.id;
		}
	}
	return null;
}

function ancestorsOf(
	catalog: Catalog,
	session: CatalogSession,
): CatalogSession[] {
	const ancestors: CatalogSession[] = [];
	let parentId = session.parentId;
	while (parentId !== null) {
		const parent = catalog.sessions.get(parentId);
		if (!parent) {
			break;
		}
		ancestors.push(parent);
		parentId = parent.parentId;
	}
	return ancestors;
}

function sessionRows(database: StatusDatabase): CatalogSession[] {
	return database
		.select({
			id: sessions.id,
			parentId: sessions.parentId,
			title: sessions.title,
			cwd: sessions.cwd,
			branch: sessions.branch,
			state: sessions.state,
			startedAt: sessions.startedAt,
			lastEventAt: sessions.lastEventAt,
		})
		.from(sessions)
		.all();
}

function editCallsSince(database: StatusDatabase, since: Date): EditCall[] {
	return database
		.select({ sessionId: events.sessionId, toolTarget: events.toolTarget })
		.from(events)
		.where(
			and(
				inArray(events.toolName, EDIT_TOOLS),
				inArray(events.toolStatus, ["ok", "pending"]),
				isNotNull(events.toolTarget),
				gte(events.at, since),
			),
		)
		.orderBy(desc(events.at), desc(events.id))
		.all();
}

export type Catalog = {
	sessions: Map<string, CatalogSession>;
	children: Map<string | null, CatalogSession[]>;
	summaries: ReturnType<typeof summariesBySession>;
	behind: Set<string>;
	edits: EditCall[];
};

export type CatalogSession = {
	id: string;
	parentId: string | null;
	title: string | null;
	cwd: string;
	branch: string | null;
	state: SessionState;
	startedAt: Date;
	lastEventAt: Date;
};

export type ListedSession = {
	session: CatalogSession;
	depth: number;
	edited: string[];
};

type ListFilter = { callers: Set<string>; all: boolean; since: Date };

type Callers = { ids: Set<string>; warnings: string[] };

type EditCall = { sessionId: string; toolTarget: string | null };

const EDIT_WINDOW_MS = 30 * 60_000;

// fact: Claude Code edits files with its Edit, MultiEdit, Write and NotebookEdit tools.
const EDIT_TOOLS = [
	"Edit",
	"MultiEdit",
	"Write",
	"NotebookEdit",
	"apply_patch",
];

export const RECENT_TOOL_CALLS = 20;

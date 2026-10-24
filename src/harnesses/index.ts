export * from "./claude";
export * from "./codex";

export type HarnessAdapter = {
	harness: Harness;
	listSources(since: Date): Promise<string[]>;
	readSource(
		path: string,
		ingested: IngestedSource | null,
	): Promise<SourceRead | null>;
	snapshot(sessions: SessionRecord[]): Promise<SnapshotRead>;
};

export type IngestedSource = {
	session: SessionRecord;
	readOffset: number;
};

export type SourceRead = {
	session: SessionRecord;
	events: SessionEvent[];
	nextOffset: number;
	warnings: string[];
	continuedIn?: string;
};

export type SnapshotRead = {
	snapshots: SessionSnapshot[];
	warnings: string[];
};

export type SessionRecord = {
	id: string;
	harness: Harness;
	surface: Surface;
	parentId: string | null;
	title: string | null;
	cwd: string;
	branch: string | null;
	startedAt: Date;
	sourcePath: string;
};

export type SessionEvent =
	| {
			kind: "message";
			key: string;
			at: Date;
			role: "user" | "assistant";
			text: string;
	  }
	| {
			kind: "tool_call";
			key: string;
			at: Date;
			text: string;
			toolName: string;
			toolTarget: string | null;
	  }
	| {
			kind: "tool_result";
			key: string;
			at: Date;
			toolStatus: Exclude<ToolStatus, "pending">;
	  };

export type SessionSnapshot = {
	sessionId: string;
	state: Exclude<SessionState, "ended">;
	cwd: string;
	branch: string | null;
};

export type Harness = "claude" | "codex";

export type Surface = "cli" | "vscode" | "app" | "unknown";

export type SessionState = "busy" | "idle" | "waiting" | "ended";

export type ToolStatus =
	| "pending"
	| "ok"
	| "error"
	| "user_denied"
	| "auto_denied";

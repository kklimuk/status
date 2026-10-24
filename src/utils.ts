import type { SessionState } from "@src/harnesses";

export type ClaudeRequest = {
	model: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	systemPrompt: string;
	input: string;
	schema: Record<string, unknown>;
};

export type ClaudeResponse = {
	output: unknown;
	inputTokens: number;
	largestPromptTokens: number;
};

export async function askClaude(
	request: ClaudeRequest,
	executable = "claude",
): Promise<ClaudeResponse> {
	const child = Bun.spawn([executable, ...claudeArguments(request)], {
		stdin: new Blob([request.input]),
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (child.signalCode !== null) {
		throw new Error(
			`claude -p was killed by ${child.signalCode}; calls time out after ${TIMEOUT_MS / 60_000} minutes`,
		);
	}
	if (exitCode !== 0) {
		const reason = stderr.trim() || stdout.trim() || "no output";
		throw new Error(`claude -p exited with code ${exitCode}: ${reason}`);
	}
	const result = parseResult(stdout);
	if (result.is_error) {
		const reason = result.result ?? result.subtype ?? "no reason given";
		throw new Error(`claude -p failed: ${reason}`);
	}
	const output = result.structured_output?.output;
	if (output === undefined) {
		throw new Error("claude -p returned no structured output");
	}
	const usage = result.usage ?? {};
	return {
		output,
		inputTokens: countInputTokens(usage),
		largestPromptTokens: countInputTokens(usage.iterations?.at(-1) ?? usage),
	};
}

export function colorize(text: string, tone: Tone): string {
	const code = Bun.color(TONES[tone], "ansi");
	return code ? `${code}${text}${RESET}` : text;
}

export function formatDuration(from: Date, to: Date): string {
	const tenths = Math.round(Math.max(0, +to - +from) / 100);
	if (tenths < 600) {
		return `${(tenths / 10).toFixed(1)}s`;
	}
	const seconds = Math.round(tenths / 10);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function claudeArguments(request: ClaudeRequest): string[] {
	const effort = request.effort ? ["--effort", request.effort] : [];
	return [
		"-p",
		"--model",
		request.model,
		...effort,
		"--no-session-persistence",
		"--strict-mcp-config",
		"--setting-sources",
		"",
		"--tools",
		"",
		"--system-prompt",
		request.systemPrompt,
		"--output-format",
		"json",
		"--json-schema",
		JSON.stringify({
			type: "object",
			properties: { output: request.schema },
			required: ["output"],
			additionalProperties: false,
		}),
	];
}

function countInputTokens(usage: TokenUsage): number {
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0)
	);
}

function parseResult(stdout: string): ClaudeResult {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`claude -p printed something other than JSON: ${stdout}`);
	}
}

type ClaudeResult = {
	is_error?: boolean;
	subtype?: string;
	result?: string;
	structured_output?: { output?: unknown };
	usage?: TokenUsage & { iterations?: TokenUsage[] };
};

export type Tone = keyof typeof TONES;

type TokenUsage = {
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

const TIMEOUT_MS = 10 * 60_000;

const TONES = {
	heading: "#3e9eff",
	error: "#e5484d",
	running: "#12a594",
	blocked: "#ffb224",
	finished: "#46a758",
	muted: "#8b8d98",
};

export const STATE_TONES = {
	busy: "running",
	waiting: "blocked",
	idle: "finished",
	ended: "muted",
} as const satisfies Record<SessionState, Tone>;

const RESET = "\x1b[0m";

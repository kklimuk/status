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
	if (result.structured_output === undefined) {
		throw new Error("claude -p returned no structured output");
	}
	const usage = result.usage ?? {};
	return {
		output: result.structured_output,
		inputTokens: countInputTokens(usage),
		largestPromptTokens: countInputTokens(usage.iterations?.at(-1) ?? usage),
	};
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
		JSON.stringify(request.schema),
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
	structured_output?: unknown;
	usage?: TokenUsage & { iterations?: TokenUsage[] };
};

type TokenUsage = {
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

const TIMEOUT_MS = 10 * 60_000;

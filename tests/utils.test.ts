import { expect, onTestFinished, test } from "bun:test";
import { askClaude, type ClaudeRequest } from "@src/utils";
import { chmodSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("askClaude sends the input on stdin with MCP servers and tools off, nests the schema under one property, and counts cached input", async () => {
	const claude = await createFakeClaude({
		stdout: JSON.stringify({
			is_error: false,
			subtype: "success",
			structured_output: { output: { done: true } },
			usage: {
				input_tokens: 2,
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 1133,
			},
		}),
	});

	const response = await askClaude(
		{ ...REQUEST, effort: "medium" },
		claude.executable,
	);
	const args = await claude.args();

	expect(response).toEqual({
		output: { done: true },
		inputTokens: 1235,
		largestPromptTokens: 1235,
	});
	expect(await claude.stdin()).toBe(REQUEST.input);
	expect(args).toContain("--strict-mcp-config");
	expect(args).toContain("--no-session-persistence");
	expect(args).not.toContain("--bare");
	expect(flag(args, "--setting-sources")).toEqual(["--setting-sources", ""]);
	expect(flag(args, "--tools")).toEqual(["--tools", ""]);
	expect(flag(args, "--effort")).toEqual(["--effort", "medium"]);
	expect(JSON.parse(flag(args, "--json-schema")[1] ?? "")).toEqual({
		type: "object",
		properties: { output: REQUEST.schema },
		required: ["output"],
		additionalProperties: false,
	});
});

test("a call the CLI retried bills every request but reports its largest prompt on its own", async () => {
	const claude = await createFakeClaude({
		stdout: JSON.stringify({
			is_error: false,
			structured_output: { output: { done: true } },
			usage: {
				input_tokens: 4,
				cache_read_input_tokens: 6484,
				cache_creation_input_tokens: 1371,
				iterations: [
					{
						input_tokens: 2,
						cache_read_input_tokens: 3242,
						cache_creation_input_tokens: 1371,
					},
				],
			},
		}),
	});

	const response = await askClaude(REQUEST, claude.executable);

	expect(response.inputTokens).toBe(7859);
	expect(response.largestPromptTokens).toBe(4615);
});

test("a non-zero exit fails closed with the CLI's reason", async () => {
	const claude = await createFakeClaude({
		stdout: "",
		stderr: "Not logged in",
		exitCode: 1,
	});

	await expect(askClaude(REQUEST, claude.executable)).rejects.toThrow(
		"exited with code 1: Not logged in",
	);
});

test("an error result fails closed even when the CLI exits zero", async () => {
	const claude = await createFakeClaude({
		stdout: JSON.stringify({
			is_error: true,
			subtype: "error_during_execution",
			result: "API Error: Overloaded",
		}),
	});

	await expect(askClaude(REQUEST, claude.executable)).rejects.toThrow(
		"API Error: Overloaded",
	);
});

test("a result without structured output fails closed", async () => {
	const claude = await createFakeClaude({
		stdout: JSON.stringify({ is_error: false, result: "plain text" }),
	});

	await expect(askClaude(REQUEST, claude.executable)).rejects.toThrow(
		"no structured output",
	);
});

async function createFakeClaude({
	stdout,
	stderr = "",
	exitCode = 0,
}: {
	stdout: string;
	stderr?: string;
	exitCode?: number;
}) {
	const directory = mkdtempSync(join(tmpdir(), "status-fake-claude-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const executable = join(directory, "claude");
	await Bun.write(join(directory, "stdout"), stdout);
	await Bun.write(join(directory, "stderr"), stderr);
	await Bun.write(
		executable,
		[
			"#!/bin/sh",
			`for argument in "$@"; do printf '%s\\0' "$argument"; done > "${directory}/args"`,
			`cat > "${directory}/stdin"`,
			`cat "${directory}/stdout"`,
			`cat "${directory}/stderr" >&2`,
			`exit ${exitCode}`,
		].join("\n"),
	);
	chmodSync(executable, 0o755);
	return {
		executable,
		args: async () =>
			(await Bun.file(join(directory, "args")).text()).split("\0").slice(0, -1),
		stdin: () => Bun.file(join(directory, "stdin")).text(),
	};
}

function flag(args: string[], name: string): string[] {
	const index = args.indexOf(name);
	return args.slice(index, index + 2);
}

const REQUEST: ClaudeRequest = {
	model: "claude-haiku-5-5",
	systemPrompt: "Classify the sentence.",
	input: "I pushed the branch.\nNext I'll open the PR.",
	schema: { type: "object", properties: { done: { type: "boolean" } } },
};

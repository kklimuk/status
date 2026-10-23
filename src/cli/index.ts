import { parseArgs } from "util";

export function run(args: string[]): CommandResult {
	const parsed = parseCommandLine(args);
	if ("error" in parsed) {
		return failure(parsed.error);
	}
	const [command] = parsed.positionals;
	if (command !== undefined) {
		return failure(`unknown command "${command}"`);
	}
	return { output: usage(), exitCode: 0 };
}

function parseCommandLine(args: string[]) {
	try {
		return parseArgs({ args, options: OPTIONS, allowPositionals: true });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function failure(message: string): CommandResult {
	return {
		output: `${colorize("status:", "error")} ${message}\n\n${usage()}`,
		exitCode: 1,
	};
}

function usage(): string {
	return `${colorize("usage:", "heading")} status [--help]`;
}

function colorize(text: string, tone: Tone): string {
	const code = Bun.color(TONES[tone], "ansi");
	return code ? `${code}${text}${RESET}` : text;
}

type CommandResult = { output: string; exitCode: number };

type Tone = keyof typeof TONES;

const OPTIONS = { help: { type: "boolean", short: "h" } } as const;

const TONES = { heading: "#3e9eff", error: "#e5484d" };

const RESET = "\x1b[0m";

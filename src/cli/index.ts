import type { App } from "@src/app";
import { STATUS_USAGE, status } from "./commands/status";
import { SUMMARIES_USAGE, summaries } from "./commands/summaries";
import { type CommandResult, failure, usage } from "./utils";

export async function run(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const [name, ...rest] = args;
	if (name === "--help" || name === "-h") {
		return { output: usage(STATUS_USAGE, SUMMARIES_USAGE), exitCode: 0 };
	}
	if (name === "summaries") {
		return runCommand(summaries, rest, openApp);
	}
	if (name === undefined || name.startsWith("-")) {
		return runCommand(status, args, openApp);
	}
	return failure(
		`unknown command "${name}"`,
		usage(STATUS_USAGE, SUMMARIES_USAGE),
	);
}

async function runCommand(
	command: Command,
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	try {
		return await command(args, openApp);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
}

type Command = (args: string[], openApp: () => App) => Promise<CommandResult>;

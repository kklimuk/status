import type { App } from "@src/app";
import { parseArgs } from "util";
import { type CommandResult, failure, parseDays, usage } from "../utils";

export const SUMMARIES_USAGE =
	"status summaries [--days <n>] [--all] [--session <id>]";

export async function summaries(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(SUMMARIES_USAGE));
	}
	if (options.help) {
		return { output: usage(SUMMARIES_USAGE), exitCode: 0 };
	}
	openApp();
	return failure("the summaries command is not implemented yet");
}

function parseOptions(args: string[]) {
	try {
		const { values } = parseArgs({ args, options: OPTIONS, strict: true });
		return { ...values, days: parseDays(values.days) };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

const OPTIONS = {
	days: { type: "string", default: "7" },
	all: { type: "boolean" },
	session: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

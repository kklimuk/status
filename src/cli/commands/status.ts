import type { App } from "@src/app";
import { parseArgs } from "util";
import { type CommandResult, failure, parseDays, usage } from "../utils";

export const STATUS_USAGE = "status [--days <n>]";

export async function status(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const options = parseOptions(args);
	if (options instanceof Error) {
		return failure(options.message, usage(STATUS_USAGE));
	}
	if (options.help) {
		return { output: usage(STATUS_USAGE), exitCode: 0 };
	}
	openApp();
	return failure("the status command is not implemented yet");
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
	help: { type: "boolean", short: "h" },
} as const;

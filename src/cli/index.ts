import type { App } from "@src/app";
import { describeError } from "@src/utils";
import {
	STATUS_GET,
	STATUS_LIST,
	statusGet,
	statusList,
} from "./commands/status";
import {
	SUMMARIES_GET,
	SUMMARIES_LIST,
	summariesGet,
	summariesList,
} from "./commands/summaries";
import {
	type CommandHelp,
	type CommandResult,
	failure,
	help,
	usage,
} from "./utils";

export async function run(
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const [first, ...rest] = args;
	if (first === "summaries") {
		return runNoun(SUMMARIES_NOUN, rest, openApp);
	}
	return runNoun(STATUS_NOUN, args, openApp);
}

async function runNoun(
	noun: Noun,
	args: string[],
	openApp: () => App,
): Promise<CommandResult> {
	const [verb, ...rest] = args;
	if (verb === undefined || verb === "--help" || verb === "-h") {
		return { output: help(...noun.help), exitCode: 0 };
	}
	const command = noun.verbs.find((candidate) => candidate.verb === verb);
	if (!command) {
		const synopses = usage(...noun.help.map((entry) => entry.synopsis));
		return failure(`unknown command "${noun.prefix}${verb}"`, synopses);
	}
	try {
		return await command.run(rest, openApp);
	} catch (error) {
		return failure(describeError(error));
	}
}

type Verb = {
	verb: string;
	run(args: string[], openApp: () => App): Promise<CommandResult>;
};

type Noun = { prefix: string; verbs: Verb[]; help: CommandHelp[] };

const STATUS_NOUN: Noun = {
	prefix: "",
	verbs: [
		{ verb: "list", run: statusList },
		{ verb: "get", run: statusGet },
	],
	help: [STATUS_LIST, STATUS_GET, SUMMARIES_LIST, SUMMARIES_GET],
};

const SUMMARIES_NOUN: Noun = {
	prefix: "summaries ",
	verbs: [
		{ verb: "list", run: summariesList },
		{ verb: "get", run: summariesGet },
	],
	help: [SUMMARIES_LIST, SUMMARIES_GET],
};

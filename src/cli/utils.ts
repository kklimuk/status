export function usage(...synopses: string[]): string {
	const label = colorize("usage:", "heading");
	return synopses
		.map((synopsis, index) =>
			index === 0 ? `${label} ${synopsis}` : `       ${synopsis}`,
		)
		.join("\n");
}

export function failure(reason: string, usageText?: string): CommandResult {
	const message = `${colorize("status:", "error")} ${reason}`;
	return {
		output: usageText ? `${message}\n\n${usageText}` : message,
		exitCode: 1,
	};
}

export function parseDays(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) === 0) {
		throw new Error(`--days takes a positive whole number, not "${value}"`);
	}
	return Number(value);
}

/** @public */
export function colorize(text: string, tone: Tone): string {
	const code = Bun.color(TONES[tone], "ansi");
	return code ? `${code}${text}${RESET}` : text;
}

export type CommandResult = { output: string; exitCode: number };

type Tone = keyof typeof TONES;

const TONES = {
	heading: "#3e9eff",
	error: "#e5484d",
	running: "#12a594",
	blocked: "#ffb224",
	finished: "#46a758",
	muted: "#8b8d98",
};

const RESET = "\x1b[0m";

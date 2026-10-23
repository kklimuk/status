import type { HarnessAdapter } from ".";

export function createClaudeAdapter(home: string): HarnessAdapter {
	const notImplemented = async (): Promise<never> => {
		throw new Error(`reading Claude sessions from ${home} is not implemented`);
	};
	return {
		harness: "claude",
		listSources: notImplemented,
		readSource: notImplemented,
		snapshot: notImplemented,
	};
}

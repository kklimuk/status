import type { HarnessAdapter } from ".";

export function createCodexAdapter(home: string): HarnessAdapter {
	const notImplemented = async (): Promise<never> => {
		throw new Error(`reading Codex sessions from ${home} is not implemented`);
	};
	return {
		harness: "codex",
		listSources: notImplemented,
		readSource: notImplemented,
		snapshot: notImplemented,
	};
}

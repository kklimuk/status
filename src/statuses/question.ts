import type { App } from "@src/app";
import { describeError } from "@src/utils";
import {
	INPUT_GUIDE,
	LIVE_STATE_GUIDE,
	MODEL,
	NEXT_MOVE_GUIDE,
	type OpusUsage,
	renderInput,
	requireArray,
	requireText,
	type StatusRoot,
	UNANSWERED_CALL,
} from "./utils";

export async function answerQuestion(
	app: App,
	roots: StatusRoot[],
	question: string,
	now: Date,
): Promise<Answer> {
	let opus = UNANSWERED_CALL;
	try {
		const response = await app.askClaude({
			model: MODEL,
			effort: "medium",
			systemPrompt: QUESTION_PROMPT,
			input: `${renderInput(roots, now)}\n\nQuestion: ${question}`,
			schema: answerSchema(roots),
		});
		opus = { calls: 1, inputTokens: response.inputTokens };
		return { ...parseAnswer(response.output, roots), failure: null, opus };
	} catch (error) {
		return { answer: "", sessions: [], failure: describeError(error), opus };
	}
}

function answerSchema(roots: StatusRoot[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			answer: { type: "string", pattern: "\\S" },
			sessions: {
				type: "array",
				items: { type: "string", enum: roots.map((root) => root.session.id) },
			},
		},
		required: ["answer", "sessions"],
		additionalProperties: false,
	};
}

function parseAnswer(
	output: unknown,
	roots: StatusRoot[],
): { answer: string; sessions: StatusRoot[] } {
	const byId = new Map(roots.map((root) => [root.session.id, root]));
	const value = output as { answer?: unknown; sessions?: unknown } | null;
	const answer = requireText(value?.answer, "an answer");
	const ids = requireArray(value?.sessions, "sessions").map((entry) =>
		requireText(entry, "a session's id"),
	);
	const members = [...new Set(ids)].map((id) => {
		const root = byId.get(id);
		if (!root) {
			throw new Error(
				`the answer names a session that wasn't asked about: ${id}`,
			);
		}
		return root;
	});
	return { answer, sessions: members };
}

export type Answer = {
	answer: string;
	sessions: StatusRoot[];
	failure: string | null;
	opus: OpusUsage;
};

const QUESTION_PROMPT = `You answer a developer's question about their coding-agent sessions (Claude Code and Codex). ${INPUT_GUIDE} The question comes last.

Return one answer and the ids of the sessions it rests on.

When the question is about what's blocked, running or done, use these statuses.
${NEXT_MOVE_GUIDE}

${LIVE_STATE_GUIDE}

Answer:
- Lead with the answer itself: a sentence, or a short list with one line per session when several apply. No preamble, and don't restate the question.
- Answer only from the input. When it can't settle the question, say so and say what it does show.
- A project or repository named in the question matches a session's directory, branch, title or summary, worktrees included.
- When you point at a session, give its id, copied exactly from its "##" heading, so the developer can open it.
- Keep exact identifiers (commands, hashes, file names, a session's ask) when they help; drop narration about the agent ("The agent then...").
- Plain text, no Markdown headings or tables.

Sessions:
- List the id of every session the answer rests on, most relevant first, each copied exactly from its "##" heading. Never invent an id.
- Leave it empty when no session bears on the answer.`;

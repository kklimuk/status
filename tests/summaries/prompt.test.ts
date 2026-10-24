import { expect, test } from "bun:test";
import { parseSummary } from "@src/summaries";

test("an answer is stored with its lists trimmed, item whitespace collapsed and a blank ask as null", () => {
	expect(
		parseSummary({
			...SUMMARY,
			objective: "  Add rolling summaries ",
			progress: ["Wrote  the\nparser", "  "],
			ask: " ",
		}),
	).toEqual({
		objective: "Add rolling summaries",
		progress: ["Wrote the parser"],
		tried: [],
		next: ["Fix the chunk boundary"],
		blockers: [],
		waitingOn: "none",
		ask: null,
		outcome: "in_progress",
	});
});

test("an answer outside the schema is rejected, naming the field", () => {
	expect(() => parseSummary({ ...SUMMARY, outcome: "finished" })).toThrow(
		'Haiku returned "finished" for outcome, not one of in_progress, done, abandoned',
	);
	expect(() => parseSummary({ ...SUMMARY, objective: " " })).toThrow(
		"Haiku returned a summary without objective",
	);
	expect(() => parseSummary({ ...SUMMARY, tried: "none" })).toThrow(
		"Haiku returned a summary whose tried isn't a list",
	);
	expect(() => parseSummary(null)).toThrow();
});

test("an ask comes exactly with waiting on the user, and a done session waits on no one", () => {
	expect(
		parseSummary({
			...SUMMARY,
			waiting_on: "user",
			ask: "Push and open a PR?",
		}),
	).toMatchObject({ waitingOn: "user", ask: "Push and open a PR?" });
	expect(() =>
		parseSummary({
			...SUMMARY,
			waiting_on: "none",
			ask: "Push and open a PR?",
		}),
	).toThrow("Haiku returned an ask while waiting_on is none");
	expect(() =>
		parseSummary({ ...SUMMARY, waiting_on: "user", ask: null }),
	).toThrow("Haiku returned waiting_on user without an ask");
	expect(() =>
		parseSummary({
			...SUMMARY,
			waiting_on: "user",
			ask: "Push and open a PR?",
			outcome: "done",
		}),
	).toThrow("Haiku returned outcome done while waiting_on is user");
});

const SUMMARY = {
	objective: "Add rolling summaries",
	progress: ["Wrote src/summaries/index.ts", "bun test runs"],
	tried: [],
	next: ["Fix the chunk boundary"],
	blockers: [],
	waiting_on: "none",
	ask: null,
	outcome: "in_progress",
};

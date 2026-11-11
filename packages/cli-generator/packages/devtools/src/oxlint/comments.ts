import { Array as Arr, String as Str } from "effect"
import type { Comment } from "#oxlint/rule.ts"

const LEADING_TRIVIA: ReadonlyArray<string> = [" ", "\t", "\r", "\n", "*"]

/** A text without its leading spaces, line breaks and asterisks: what a comment line says past its decoration; a
 * comment's lead is its value without them. */
export const withoutLead = (text: string): string => {
	const kept = Arr.dropWhile(Str.split("")(text), (character) =>
		Arr.contains(LEADING_TRIVIA, character)
	)
	return Arr.join(kept, "")
}

/** The directives that switch a check off at the comment's place: a linter's, Effect's and fallow's. */
const SUPPRESSIONS: ReadonlyArray<string> = [
	"oxlint-disable",
	"oxlint-enable",
	"eslint-disable",
	"eslint-enable",
	"@effect-diagnostics",
	"fallow-ignore"
]

/** A comment any of whose lines begins, past its leading spaces and asterisks, with a suppression directive. */
export const isSuppression = (comment: Comment): boolean =>
	Arr.some(Str.split("\n")(comment.value), (line) =>
		Arr.some(SUPPRESSIONS, (directive) => Str.startsWith(directive)(withoutLead(line)))
	)

import { Array as Arr, Option, Result } from "effect"
import type { ApplyError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"

/**
 * One flight an attempt's session sent: how many statements it carried besides BEGIN, COMMIT and ROLLBACK, how it ended
 * the transaction, whether the server refused any of its queries, and whether its COMMIT answered COMMIT.
 */
export interface Flight {
	readonly statements: number
	readonly ends: "COMMIT" | "ROLLBACK" | "kept"
	readonly refused: boolean
	readonly committed: boolean
}

/**
 * The single-flight property of a write attempt (run.ts applyWith): the client never decides between COMMIT and
 * ROLLBACK from rows. Every statement of the attempt, its read-backs' attachments included, and its COMMIT are sent
 * without waiting for any result, in one flight; so a refusal, an abort or a law's violation must come from a
 * statement or the COMMIT that PostgreSQL failed, the client sends nothing after it, and an applied outcome is every
 * statement succeeding, then a COMMIT that committed.
 *
 * Why an attempt's flights show a decision taken from rows (see the header); none when it holds.
 */
export const batchProblems = (
	log: ReadonlyArray<Flight>,
	result: Result.Result<ApplyOutcome<unknown>, ApplyError>
): ReadonlyArray<string> => {
	const problems: Array<string> = []
	if (log.length > 1) {
		problems.push(`${log.length} flights, where an attempt is one`)
	}
	const firstRefused = Arr.findFirstIndex(log, (f) => f.refused)
	if (
		Option.exists(firstRefused, (at) =>
			Arr.some(log.slice(at + 1), (f) => f.statements > 0 || f.ends === "COMMIT")
		)
	) {
		problems.push("a statement was sent after a flight PostgreSQL failed")
	}
	const commits = Arr.flatMap(log, (f, i) => (f.ends === "COMMIT" ? [i] : []))
	if (commits.length > 1 || (commits.length === 1 && commits[0] !== log.length - 1)) {
		problems.push("a COMMIT outside the attempt's last flight")
	}
	const last = log[log.length - 1]
	const committed = last?.ends === "COMMIT" && last.committed
	const applied = Result.isSuccess(result) && result.success.kind !== "invariant-rejected"
	if (applied) {
		if (Option.isSome(firstRefused)) {
			problems.push("an applied outcome after a refused query")
		}
		if (!committed && log.length > 0) {
			problems.push("an applied outcome without a COMMIT that committed")
		}
		return problems
	}
	/** A refusal before any SQL sent no flight; any other refusal or abort is PostgreSQL's failure. */
	const refused =
		(Result.isSuccess(result) && result.success.kind === "invariant-rejected") ||
		(Result.isFailure(result) && result.failure._tag === "TransientFailure")
	if (refused && log.length > 0 && Option.isNone(firstRefused)) {
		problems.push(
			`${Result.isSuccess(result) ? "invariant-rejected" : "a TransientFailure"} though every query succeeded: the client decided from rows`
		)
	}
	return problems
}

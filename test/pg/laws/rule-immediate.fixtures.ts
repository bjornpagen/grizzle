/** What rule-immediate.test.ts reads: its space over rule-whole.fixtures.ts's whole judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const modes = ["deferred", "immediate"] as const
type Mode = (typeof modes)[number]

/**
 * The one statement a case's transaction writes, over document 1 stored whole and lawful before it
 * (rule-whole.fixtures.ts statementsOf `unit` at type 1): document 2 written whole and lawful; document 2 written whole
 * at type 0, which One type, a key, refuses; or the expression at document 1's start 1 deleted, a node of kind 1, which
 * Expressed, a containment, refuses.
 */
const writes = ["lawful insert", "breaking insert", "breaking delete"] as const
type Write = (typeof writes)[number]

/** A case: the whole judge's unit shape, when the judge runs, and the one statement the transaction writes. */
export interface Immediate {
	readonly shape: ShapeKey
	readonly mode: Mode
	readonly write: Write
}

export const immediateGen: Gen<Immediate> = (s) => ({
	shape: s.draw(element(shapeKeys)),
	mode: s.draw(element(modes)),
	write: s.draw(element(writes))
})

export type ImmediateFeature =
	| "a lawful write committed"
	| "a breaking insert refused at COMMIT"
	| "a breaking delete refused at COMMIT"
	| "a breaking insert refused at its statement"
	| "a breaking delete refused at its statement"

class Unjudged extends Data.TaggedError("Unjudged")<{ readonly message: string }> {}

/** The SQLSTATE a case's breaking write is refused by: One type's, a key's; Expressed's, a containment's. */
const refusedBy = {
	"lawful insert": undefined,
	"breaking insert": sqlstates.uniqueViolation,
	"breaking delete": sqlstates.foreignKeyViolation
} as const satisfies Record<Write, string | undefined>

/** A write of several statements as one: each before the last a data-modifying CTE of it, so every capture runs once. */
const oneStatement = (statements: ReadonlyArray<string>): string => {
	const [last, ...before] = Arr.reverse(statements)
	return last === undefined
		? ""
		: `${Arr.join(
				Arr.map(
					Arr.reverse(before),
					(s, i) => `${i === 0 ? "WITH" : ","} ${quoteIdent(`w${i}`)} AS (${s})`
				),
				" "
			)} ${last}`
}

/** The rows the session's temporary tables hold, each by its name: its deltas' and its sentinel's. */
const sessionRows = (session: RawSession) =>
	Effect.gen(function* () {
		const names = yield* session.values(
			"SELECT c.relname FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r' ORDER BY c.relname",
			[]
		)
		return yield* Effect.forEach(names, ([name]) =>
			Effect.map(
				session.values(`SELECT count(*) FROM pg_temp.${quoteIdent(String(name))}`, []),
				(rows) => ({ name: String(name), rows: Number(rows[0]?.[0]) })
			)
		)
	})

/**
 * Stores document 1 whole and lawful, then runs the case's transaction: in immediate mode, SET CONSTRAINTS ALL
 * IMMEDIATE first, its one write refused at that statement where it breaks a rule, by that rule's SQLSTATE, and run
 * where it breaks none, then COMMIT; in deferred mode, its write, then COMMIT, refused where the write breaks a rule.
 * After each, every session table holds no row: the judge reads each delta's rows once, in the transaction that wrote
 * them, and deletes them, a refused transaction's going with its rollback.
 */
export const runImmediate = (
	installed: Installed,
	session: RawSession,
	k: Immediate,
	c: Case<ImmediateFeature>
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, k.shape)
		const where = Formatter.format(k)
		const empty = (after: string) =>
			Effect.gen(function* () {
				const rows = yield* sessionRows(session)
				const held = Arr.filter(rows, (t) => t.rows > 0)
				if (held.length > 0) {
					return yield* new Unjudged({
						message: `after ${after}, the session's tables hold ${Formatter.format(held)}, ${where}`
					})
				}
			})
		yield* session.begin
		yield* session.query(oneStatement(statementsOf(tables, { kind: "unit", doc: 1, type: 1 })), [])
		yield* session.commit
		yield* empty("storing document 1")
		const write = oneStatement(
			k.write === "breaking delete"
				? statementsOf(tables, { kind: "unexpr", doc: 1, start: 1 })
				: statementsOf(tables, {
						kind: "unit",
						doc: 2,
						type: k.write === "breaking insert" ? 0 : 1
					})
		)
		const expected = refusedBy[k.write]
		yield* session.begin
		if (k.mode === "immediate") {
			yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		}
		const atStatement = yield* refusalOf(session.query(write, []))
		if (Option.isSome(atStatement)) {
			yield* session.rollback
		}
		const atCommit = Option.isSome(atStatement) ? Option.none() : yield* refusalOf(session.commit)
		const refused = Option.orElse(atStatement, () => atCommit)
		if (expected === undefined) {
			if (Option.isSome(refused)) {
				return yield* new Unjudged({
					message: `a lawful write was refused under ${refused.value.code}: ${refused.value.message}, ${where}`
				})
			}
			c.note("a lawful write committed")
		} else {
			const at = k.mode === "immediate" ? atStatement : atCommit
			if (Option.isNone(at) || at.value.code !== expected) {
				return yield* new Unjudged({
					message: `a breaking write ${Option.match(at, {
						onNone: () =>
							k.mode === "immediate" ? "ran past its statement unjudged" : "committed",
						onSome: (e) => `was refused under ${e.code}: ${e.message}`
					})}, where it is refused by ${expected} ${k.mode === "immediate" ? "at its statement" : "at COMMIT"}, ${where}`
				})
			}
			c.note(
				k.mode === "immediate"
					? k.write === "breaking insert"
						? "a breaking insert refused at its statement"
						: "a breaking delete refused at its statement"
					: k.write === "breaking insert"
						? "a breaking insert refused at COMMIT"
						: "a breaking delete refused at COMMIT"
			)
		}
		yield* empty("the case's transaction")
	})

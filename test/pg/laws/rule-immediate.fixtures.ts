/** What rule-immediate.test.ts reads: its space over rule-whole.fixtures.ts's whole judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	bracketOf,
	lawNamed,
	type Op,
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import { refusedByRecheck } from "#test/support/data-step.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { firstRefusalOf, refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const modes = ["deferred", "immediate"] as const
type Mode = (typeof modes)[number]

/**
 * The one statement a case's transaction writes, over document 1 stored whole and lawful before it
 * (rule-whole.fixtures.ts statementsOf `unit` at type 1): document 2 written whole and lawful; document 2 written whole
 * at type 0, which One type, a key, refuses; or the expression at document 1's start 1 deleted, a node of kind 1, which
 * Expressed, a containment, refuses, Expr closed, so a data step's delete, inside the bracket a migration's runner
 * sends (rule-whole.fixtures.ts bracketOf), whose re-check refuses it under Expressed's law, the judge reading none of
 * a closed relation's removed rows.
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
	| "a breaking insert refused at its statement"
	| "a breaking delete refused by its bracket's re-check, deferred"
	| "a breaking delete refused by its bracket's re-check, immediate"

class Unjudged extends Data.TaggedError("Unjudged")<{ readonly message: string }> {}

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
 * The delete is a data step's, inside its bracket in either mode, refused by the bracket's re-check under Expressed's
 * law, never at its statement or at COMMIT. After each, every session table holds no row: the judge reads each delta's
 * rows once, in the transaction that wrote them, and deletes them, a refused transaction's going with its rollback.
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
		const op: Exclude<Op, { readonly kind: "judge" }> =
			k.write === "breaking delete"
				? { kind: "unexpr", doc: 1, start: 1 }
				: { kind: "unit", doc: 2, type: k.write === "breaking insert" ? 0 : 1 }
		const write = oneStatement(statementsOf(tables, op))
		/** The delete of document 1's expression removes a closed relation's row: a data step's, inside its bracket. */
		const bracket = bracketOf("whole", installed, [op])
		yield* session.begin
		if (k.mode === "immediate") {
			yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		}
		for (const sql of Option.match(bracket, { onNone: () => [], onSome: (b) => b.before })) {
			yield* session.query(sql, [])
		}
		const atStatement = yield* refusalOf(session.query(write, []))
		const atBracket = Option.isSome(atStatement)
			? Option.none()
			: yield* firstRefusalOf(
					Option.match(bracket, { onNone: () => [], onSome: (b) => b.after }),
					(sql) => session.query(sql, [])
				)
		const before = Option.orElse(atStatement, () => atBracket)
		if (Option.isSome(before)) {
			yield* session.rollback
		}
		const atCommit = Option.isSome(before) ? Option.none() : yield* refusalOf(session.commit)
		/** Each moment's refusal, as the case met it, for its failures' messages. */
		const met = Formatter.format({ atStatement, atBracket, atCommit })
		switch (k.write) {
			case "lawful insert": {
				const refused = Option.orElse(before, () => atCommit)
				if (Option.isSome(refused)) {
					return yield* new Unjudged({
						message: `a lawful write was refused under ${refused.value.code}: ${refused.value.message}, ${where}`
					})
				}
				c.note("a lawful write committed")
				break
			}
			case "breaking insert": {
				const at = k.mode === "immediate" ? atStatement : atCommit
				if (Option.isNone(at) || at.value.code !== sqlstates.uniqueViolation) {
					return yield* new Unjudged({
						message: `a breaking insert was not refused by ${sqlstates.uniqueViolation} ${k.mode === "immediate" ? "at its statement" : "at COMMIT"}: ${met}, ${where}`
					})
				}
				c.note(
					k.mode === "immediate"
						? "a breaking insert refused at its statement"
						: "a breaking insert refused at COMMIT"
				)
				break
			}
			case "breaking delete": {
				const law = lawNamed(installed.installation, "Expressed")
				if (Option.isNone(atBracket) || !refusedByRecheck(atBracket.value, law)) {
					return yield* new Unjudged({
						message: `a breaking delete was not refused by its bracket's re-check under Expressed's law ${law}: ${met}, ${where}`
					})
				}
				c.note(
					k.mode === "immediate"
						? "a breaking delete refused by its bracket's re-check, immediate"
						: "a breaking delete refused by its bracket's re-check, deferred"
				)
				break
			}
		}
		yield* empty("the case's transaction")
	})

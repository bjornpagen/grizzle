/** What rule-commit.test.ts reads: its space over rule-whole.fixtures.ts's judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const judges = ["whole", "probed"] as const
type Judge = (typeof judges)[number]
const types = [0, 1] as const

const docs = [1, 2] as const

/**
 * A case: the judge and the unit shape it runs on, and its session's transactions, each a write of one document: both
 * documents written whole, the first standing up the session's deltas and the second writing into deltas that stand,
 * then one of them dropped, which writes the sides of the rows it removes.
 */
export interface Commits {
	readonly judge: Judge
	readonly shape: ShapeKey
	readonly type: (typeof types)[number]
	readonly dropped: (typeof docs)[number]
}

export const commitsGen: Gen<Commits> = (s) => ({
	judge: s.draw(element(judges)),
	shape: s.draw(element(shapeKeys)),
	type: s.draw(element(types)),
	dropped: s.draw(element(docs))
})

export type CommitFeature = "a whole judge's deltas" | "a probed judge's deltas"

class Truncated extends Data.TaggedError("Truncated")<{ readonly message: string }> {}

/** The session's temporary tables, each by its name with the bytes it holds on disk. */
const sessionTables = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT c.relname, pg_catalog.pg_relation_size(c.oid) FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r' ORDER BY c.relname",
			[]
		),
		(rows) => Arr.map(rows, (row) => ({ name: String(row[0]), bytes: Number(row[1]) }))
	)

/** The rows the session's temporary table `name` holds. */
const rowsIn = (session: RawSession, name: string) =>
	Effect.map(session.values(`SELECT count(*) FROM pg_temp.${quoteIdent(name)}`, []), (rows) =>
		Number(rows[0]?.[0])
	)

/**
 * Writes the case's documents whole, one transaction each, in one session, and counts the work each COMMIT does on the
 * session's temporary tables: the tables the transaction wrote a row into, read before its COMMIT, each hold no row
 * after it, the judge having read and deleted them, and each keeps the pages it was written into, which a truncation
 * would have given back. So a judged COMMIT truncates none of the session's tables, where it truncated every ON COMMIT
 * DELETE ROWS table the session held, written or not.
 */
export const runCommits = (
	installed: Installed,
	session: RawSession,
	k: Commits,
	c: Case<CommitFeature>
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, k.shape)
		c.note(k.judge === "whole" ? "a whole judge's deltas" : "a probed judge's deltas")
		const ops = [
			...Arr.map(docs, (doc) => ({ kind: "unit", doc, type: k.type }) as const),
			{ kind: "drop", doc: k.dropped } as const
		]
		for (const op of ops) {
			const where = `${op.kind} of document ${op.doc} in ${Formatter.format(k)}`
			yield* session.begin
			for (const sql of statementsOf(tables, op)) {
				yield* session.query(sql, [])
			}
			const written: Array<string> = []
			for (const t of yield* sessionTables(session)) {
				if ((yield* rowsIn(session, t.name)) > 0) {
					written.push(t.name)
				}
			}
			yield* session.commit
			if (written.length === 0) {
				return yield* new Truncated({ message: `the write captured no row, ${where}` })
			}
			const after = yield* sessionTables(session)
			for (const t of after) {
				const rows = yield* rowsIn(session, t.name)
				if (rows > 0) {
					return yield* new Truncated({
						message: `the session's ${t.name} holds ${rows} rows after the COMMIT that wrote them, ${where}`
					})
				}
			}
			const truncated = Arr.filter(after, (t) => written.includes(t.name) && t.bytes === 0)
			if (truncated.length > 0) {
				return yield* new Truncated({
					message: `the COMMIT truncated ${truncated.length} of the ${written.length} session tables it wrote, ${Formatter.format(Arr.map(truncated, (t) => t.name))}, ${where}`
				})
			}
		}
	})

/** What rule-commit.test.ts reads: its space over rule-whole.fixtures.ts's judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, String as Str, Data, Effect, Formatter } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import {
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { readersOf } from "#test/support/judge.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const judges = ["whole", "probed"] as const
type Judge = (typeof judges)[number]
const docs = [1, 2] as const

/**
 * A case: the judge and the unit shape it runs on, and its session's transactions, each a write of one document: both
 * documents written whole and lawful (rule-whole.fixtures.ts statementsOf `unit` at type 1, which keeps every rule; at
 * type 0 One type refuses it), the first standing up the session's deltas and the second writing into deltas that
 * stand, then one of them dropped, which writes the sides of the rows it removes.
 */
export interface Commits {
	readonly judge: Judge
	readonly shape: ShapeKey
	readonly dropped: (typeof docs)[number]
}

export const commitsGen: Gen<Commits> = (s) => ({
	judge: s.draw(element(judges)),
	shape: s.draw(element(shapeKeys)),
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

/** Whether the session's table `name` is a delta of the judge (core/identity.ts ruleDelta's stem), not its sentinel. */
const isDelta = (name: string): boolean => Str.startsWith("__delta_")(name)

/**
 * That no role but the judge's definer may read the run's rows: each delta the transaction wrote, `written`, is a
 * temporary table its owner alone holds a privilege on (pg_class relacl NULL), owned by the role that owns the judge's
 * functions, which made it inside them (physical/ddl/rules.ts ensured); and no reader of the installation, the function
 * the judge's statements read a delta through, may be run by PUBLIC (physical/ddl/rules.ts readers, its EXECUTE
 * revoked).
 */
const closed = (
	session: RawSession,
	installed: Installed,
	written: ReadonlyArray<string>,
	where: string
) =>
	Effect.gen(function* () {
		for (const name of Arr.filter(written, isDelta)) {
			const rows = yield* session.values(
				`SELECT c.relacl IS NULL, pg_catalog.pg_get_userbyid(c.relowner) = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc AS p WHERE p.proname = ${quoteString(identifierOf(identity.ruleJudge()))} LIMIT 1) FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass(${quoteString(`pg_temp.${quoteIdent(name)}`)})`,
				[]
			)
			const [ownerOnly, definers] = rows[0] ?? []
			if (ownerOnly !== true || definers !== true) {
				return yield* new Truncated({
					message: `the delta ${name} is readable beyond the judge's definer (owner only: ${String(ownerOnly)}, the definer's: ${String(definers)}), ${where}`
				})
			}
		}
		const readers = readersOf(installed.installation)
		const functions = Arr.flatMap(installed.installation.statements, (st) =>
			st.kind === "createFunction" && readers.has(st.name.name) ? [st.name] : []
		)
		for (const fn of functions) {
			const reader = fn.name
			const rows = yield* session.values(
				`SELECT pg_catalog.has_function_privilege('public', ${quoteString(`${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}()`)}, 'EXECUTE')`,
				[]
			)
			if (rows[0]?.[0] !== false) {
				return yield* new Truncated({ message: `PUBLIC may run the reader ${reader}, ${where}` })
			}
		}
	})

/** The rows the session's temporary table `name` holds. */
const rowsIn = (session: RawSession, name: string) =>
	Effect.map(session.values(`SELECT count(*) FROM pg_temp.${quoteIdent(name)}`, []), (rows) =>
		Number(rows[0]?.[0])
	)

/**
 * Writes the case's documents whole, one transaction each, in one session, and counts the work each COMMIT does on the
 * session's temporary tables: the tables the transaction wrote a row into, read before its COMMIT, each hold no row
 * after it; each delta among them holds no page, the judge having read it and truncated it (physical/ddl/rules.ts
 * emptied), where a DELETE kept every page of every run and a session's deltas grew by each write; and the sentinel,
 * whose one row the judge deletes as it starts, keeps its page, which no COMMIT truncates, where ON COMMIT DELETE ROWS
 * truncated it and every other such table the session held at every COMMIT, written or not.
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
			...Arr.map(docs, (doc) => ({ kind: "unit", doc, type: 1 }) as const),
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
			yield* closed(session, installed, written, where)
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
			const kept = Arr.filter(
				after,
				(t) => written.includes(t.name) && isDelta(t.name) && t.bytes > 0
			)
			if (kept.length > 0) {
				return yield* new Truncated({
					message: `the COMMIT left pages in ${kept.length} of the deltas it wrote, ${Formatter.format(Arr.map(kept, (t) => `${t.name} ${t.bytes} B`))}, ${where}`
				})
			}
			const sentinels = Arr.filter(after, (t) => written.includes(t.name) && !isDelta(t.name))
			if (Arr.some(sentinels, (t) => t.bytes === 0)) {
				return yield* new Truncated({
					message: `the COMMIT truncated the sentinel, ${Formatter.format(Arr.map(sentinels, (t) => t.name))}, ${where}`
				})
			}
		}
	})

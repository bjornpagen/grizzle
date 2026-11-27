/** What rule-commit.test.ts reads: its space over rule-whole.fixtures.ts's judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, String as Str, Data, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { blockSize } from "#compiler/core/page.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import {
	bracketOf,
	type Judge,
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { readersOf } from "#test/support/judge.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const judges = ["whole", "probed"] as const satisfies ReadonlyArray<Judge>
const docs = [1, 2] as const

/**
 * A case: the judge and the unit shape it runs on, and its session's transactions, each a write of one document: both
 * documents written whole and lawful (rule-whole.fixtures.ts statementsOf `unit` at type 1, which keeps every rule; at
 * type 0 One type refuses it), the first standing up the session's deltas and the second writing into deltas that
 * stand, then one of them dropped: on the probed judge a served write, which writes the sides of the rows it removes;
 * on the whole judge a data step, its relations closed, whose removals no capture writes (rule-whole.fixtures.ts
 * bracketOf).
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

export type CommitFeature =
	| "a whole judge's deltas"
	| "a probed judge's deltas"
	| "a whole judge's data step, its removals captured by none"

class Truncated extends Data.TaggedError("Truncated")<{ readonly message: string }> {}

/**
 * The session's temporary tables, each by its name with its file and the bytes its heap and its TOAST table's heap hold
 * on disk.
 */
const sessionTables = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT c.relname, pg_catalog.pg_relation_size(c.oid), COALESCE(pg_catalog.pg_relation_size(c.reltoastrelid), 0), pg_catalog.pg_relation_filenode(c.oid)::text FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r' ORDER BY c.relname",
			[]
		),
		(rows) =>
			Arr.map(rows, (row) => ({
				name: String(row[0]),
				bytes: Number(row[1]),
				toast: Number(row[2]),
				filenode: String(row[3])
			}))
	)

/** A session table past the one page its emptying keeps, in its heap or its TOAST table (sql/print.ts sessionTableEmptied). */
const outgrown = (t: { readonly bytes: number; readonly toast: number }): boolean =>
	t.bytes > blockSize || t.toast > blockSize

/**
 * The predicate locks the session's transaction holds on its temporary tables: none, since PostgreSQL takes none on a
 * relation of local buffers (REL_19_0 src/backend/storage/lmgr/predicate.c 512-516 PredicateLockingNeededForRelation),
 * so no SERIALIZABLE transaction of another session conflicts with a judge's reads of its deltas.
 */
const predicateLocks = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT count(*) FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relation WHERE l.mode = 'SIReadLock' AND l.pid = pg_catalog.pg_backend_pid() AND c.relnamespace = pg_catalog.pg_my_temp_schema()",
			[]
		),
		(rows) => Number(rows[0]?.[0])
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

/** The session's temporary tables that hold a row, each by its name. */
const holdingRows = (session: RawSession) =>
	Effect.gen(function* () {
		const holding: Array<string> = []
		for (const t of yield* sessionTables(session)) {
			if ((yield* rowsIn(session, t.name)) > 0) {
				holding.push(t.name)
			}
		}
		return holding
	})

/**
 * Writes the case's documents whole, one transaction each, in one session, then one of them again in a transaction it
 * rolls back, and reads what each transaction leaves of the session's temporary tables. The whole judge's drop is a
 * data step, inside its bracket: after its statements and before the bracket's checks, no session table holds a row,
 * since no capture writes a closed relation's removed rows, the bracket's re-check judging the step whole. Before each COMMIT the
 * transaction holds no predicate lock on any of them. After each COMMIT the tables the transaction wrote a row into,
 * read before it, each hold no row; each delta among them that held its one page at most before the COMMIT, its heap
 * and its TOAST table's, keeps its file, the judge having read it and deleted its rows, and one that held more has a
 * new file, empty, the judge having truncated it (sql/print.ts sessionTableEmptied), so each holds its one page at
 * most; where a TRUNCATE at every COMMIT gave each a new file, and every backend of the database walked every plan it
 * holds for the invalidations. The sentinel, whose one row the judge deletes as it starts, keeps its page, which no
 * COMMIT truncates, where ON COMMIT DELETE ROWS truncated it and every other such table the session held at every
 * COMMIT, written or not. After the rollback every table holds no row and keeps its file.
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
			const bracket = bracketOf(k.judge, installed, [op])
			yield* session.begin
			for (const sql of [
				...Option.match(bracket, { onNone: () => [], onSome: (b) => b.before }),
				...statementsOf(tables, op)
			]) {
				yield* session.query(sql, [])
			}
			if (Option.isSome(bracket)) {
				const captured = yield* holdingRows(session)
				if (captured.length > 0) {
					return yield* new Truncated({
						message: `a data step's removals of closed rows stand captured in ${Formatter.format(captured)}, ${where}`
					})
				}
				for (const sql of bracket.value.after) {
					yield* session.query(sql, [])
				}
				c.note("a whole judge's data step, its removals captured by none")
			}
			const before = yield* sessionTables(session)
			const written = yield* holdingRows(session)
			yield* closed(session, installed, written, where)
			const locks = yield* predicateLocks(session)
			if (locks > 0) {
				return yield* new Truncated({
					message: `the transaction holds ${locks} predicate locks on the session's tables, ${where}`
				})
			}
			yield* session.commit
			if (written.length === 0 && Option.isNone(bracket)) {
				return yield* new Truncated({ message: `the served write captured no row, ${where}` })
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
			for (const t of Arr.filter(after, (t) => written.includes(t.name) && isDelta(t.name))) {
				const was = Arr.findFirst(before, (b) => b.name === t.name)
				if (Option.isNone(was)) {
					return yield* new Truncated({
						message: `the delta ${t.name} stood up at the COMMIT, ${where}`
					})
				}
				const truncated = t.filenode !== was.value.filenode
				if (truncated !== outgrown(was.value) || outgrown(t)) {
					return yield* new Truncated({
						message: `the COMMIT left the delta ${t.name} at ${Formatter.format(t)} from ${Formatter.format(was.value)}, where one within its page keeps its file and one past it is given a new one, each within its page after, ${where}`
					})
				}
			}
			const sentinels = Arr.filter(after, (t) => written.includes(t.name) && !isDelta(t.name))
			if (Arr.some(sentinels, (t) => t.bytes === 0)) {
				return yield* new Truncated({
					message: `the COMMIT truncated the sentinel, ${Formatter.format(Arr.map(sentinels, (t) => t.name))}, ${where}`
				})
			}
		}
		const aborted = `a rolled-back unit of document ${k.dropped} in ${Formatter.format(k)}`
		const standing = yield* sessionTables(session)
		yield* session.begin
		for (const sql of statementsOf(tables, { kind: "unit", doc: k.dropped, type: 1 })) {
			yield* session.query(sql, [])
		}
		yield* session.rollback
		const left = yield* sessionTables(session)
		for (const t of left) {
			const rows = yield* rowsIn(session, t.name)
			const was = Arr.findFirst(standing, (b) => b.name === t.name)
			if (rows > 0 || (Option.isSome(was) && was.value.filenode !== t.filenode)) {
				return yield* new Truncated({
					message: `the rollback left ${t.name} with ${rows} rows at ${Formatter.format(t)} from ${Formatter.format(was)}, ${aborted}`
				})
			}
		}
	})

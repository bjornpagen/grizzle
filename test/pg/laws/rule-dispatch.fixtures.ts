/** What the property of rule-dispatch.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { array, type Gen, subset } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { objectName } from "#compiler/sql/build.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	capturedDeltasOf,
	filledBy,
	judgeStatementsOf,
	standUpJudge,
	standUpRelations
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A content package's documents, keyed by their package first, as every relation of a package's unit is. */
const Doc = relation("Doc", { package: int4, doc: int4 }, ["package", "doc"])
/** A document's parts, in its package's unit. */
const Part = relation("Part", { package: int4, doc: int4, part: int4 }, ["package", "doc", "part"])
/** A document's sheets, in its package's unit. */
const Sheet = relation("Sheet", { package: int4, doc: int4, sheet: int4 }, [
	"package",
	"doc",
	"sheet"
])
/** A learner's visits, keyed by the learner first, as every relation of a learner's unit is. */
const Visit = relation("Visit", { child: int4, at: int4 }, ["child", "at"])
/** The answers a learner gave in a visit, in the learner's unit. */
const Answer = relation("Answer", { child: int4, at: int4, n: int4 }, ["child", "at", "n"])
/** A learner's note on a document: mutable in the learner's unit, read beside documents keyed by their package, so the
 * rule over it joins no one unit and is probed, never judged whole. */
const Note = relation("Note", { child: int4, package: int4, doc: int4 }, [
	"child",
	"package",
	"doc"
])

/**
 * Three whole rules, each a containment of a selected side within one unit, its relations mutable in that unit, which
 * the judge reads whole over its unit's deltas (laws/model/plan.ts containmentDischarge, which probes one over
 * immutable relations key by key; README, Rules over queries): a package's parts and its sheets lie in its documents,
 * reading Part's and Sheet's sides of news and Doc's of olds, so the three deltas are one part of the judge, and a
 * write of parts runs the parts' rule alone and stands up Doc's olds, never Sheet's news; a learner's answers lie in
 * their visits, reading Answer's news and Visit's olds.
 */
const Base = schema(
	"Dispatch",
	[Doc, Part, Sheet, Visit, Answer, Note],
	[
		mutable(Note),
		mutable(Doc),
		mutable(Part),
		mutable(Sheet),
		mutable(Visit),
		mutable(Answer),
		contained(
			on(
				select(Part, (p) => p.ge(p.part, 0)),
				"package",
				"doc"
			),
			on(Doc, "package", "doc")
		),
		contained(
			on(
				select(Sheet, (s) => s.ge(s.sheet, 0)),
				"package",
				"doc"
			),
			on(Doc, "package", "doc")
		),
		contained(
			on(
				select(Answer, (a) => a.ge(a.n, 0)),
				"child",
				"at"
			),
			on(Visit, "child", "at")
		),
		unit("Learner", { child: int4 }),
		unit("Package", { package: int4 })
	]
)

/**
 * The documents that have a part: stored (analysis/derived/storage.ts), a join of relations read positively whose Part
 * no key reaches from its head, so its upkeep is a monotone delta form (analysis/theory/upkeep.ts): the facts a write
 * gains, read from Doc's and Part's sides of news, in one call, and the documents the rows it removed touch,
 * re-derived from their sides of olds, a DELETE that seeks Documented's table at each and an INSERT, in another before
 * it (physical/ddl/rules.ts upkeepBlock), each run where a delta of its own holds a row, so an inserted document runs the
 * gain alone, which reads Part beside it, since whether the document has a part decides whether it is documented, and
 * never Documented's table. It writes its table, whose capture writes its side of olds, which the rule over Note reads.
 *
 * No write of the box changes it: every document a write inserts or deletes, 300 + t or 100 + t, has no part, and
 * every part a write inserts or deletes lies under document 1, which keeps part 1, which no write removes (`seeded`,
 * `statementOf`), so Documented holds document 1 alone throughout; its upkeep's DELETE and INSERTs change no row, its
 * capture writes no delta, and no statement over its deltas runs.
 */
const Documented = derived(
	"Documented",
	query(Base).rule((r) => {
		const { package: p, doc } = v(Part, "part")
		return r
			.match(Doc, { package: p, doc })
			.match(Part, { package: p, doc })
			.find({ package: p, doc })
	})
)

/**
 * A probed rule beside them: a learner notes only documented documents, reading Note's side of news and Documented's
 * of olds, each probed over its delta alone, Documented's table read where Note's side runs it.
 */
const Dispatch = schema.extend(
	[Base],
	"Dispatch_1",
	[Documented],
	[contained(on(Note, "package", "doc"), on(Documented, "package", "doc"))]
)

/** Dispatch installed through its first migration, with no login. */
export const dispatchTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule dispatch",
	content: { schema: "Dispatch", logins: [] },
	versions: [{ schema: Dispatch, declarations: noDeclarations }],
	options: {
		label: "rule_dispatch",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The stored relations, each one table. */
const tables = [Doc, Part, Sheet, Visit, Answer, Note] as const

/** A write of one row: an insert of a new row of a relation, or a delete of a stored one, which breaks no rule. */
const ops = [
	"insert Doc",
	"delete Doc",
	"insert Part",
	"delete Part",
	"insert Sheet",
	"delete Sheet",
	"insert Visit",
	"delete Visit",
	"insert Answer",
	"delete Answer",
	"insert Note",
	"delete Note"
] as const
type Op = (typeof ops)[number]

/** The relation an op writes: its last word. */
const relationOf = (op: Op): string => Arr.lastNonEmpty(Str.split(op, " "))

/** The most transactions a case runs in its one session. */
const transactionsAtMost = 3

/** A case: its session's transactions in order, each the writes it makes, at least one. */
export interface Writes {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

export const writesGen: Gen<Writes> = (s) => ({
	transactions: s.draw(array(subset(ops, { min: 1, max: 4 }), { min: 1, max: transactionsAtMost }))
})

export type DispatchFeature =
	| "a statement over two deltas run by a write of one of them alone"
	| "a statement run by a side of olds alone"
	| "a delta a statement that ran read, whose transaction wrote no row of it"
	| "a delta an earlier transaction wrote, holding no row in a later one"
	| "a transaction whose writes run no statement"

/**
 * The rows every transaction's writes find: for transaction t, a document 100 + t with no part, a part 200 + t beside
 * part 1 of document 1, a sheet 200 + t of document 1, a visit 100 + t with no answer, an answer 200 + t of visit 1, and a note of learner 100 + t, so
 * each delete removes one row and breaks no rule; and document 1 with its part 1, visit 1 and learner 7's note on
 * document 1, which no write removes.
 */
const seeded = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const ts = Array.from({ length: transactionsAtMost }, (_, t) => t)
	const rows = (values: ReadonlyArray<string>): string => Arr.join(values, ", ")
	return [
		`INSERT INTO ${names.table(Doc)} (package, doc) VALUES ${rows(["(1, 1)", ...Arr.map(ts, (t) => `(1, ${100 + t})`)])}`,
		`INSERT INTO ${names.table(Part)} (package, doc, part) VALUES ${rows(["(1, 1, 1)", ...Arr.map(ts, (t) => `(1, 1, ${200 + t})`)])}`,
		`INSERT INTO ${names.table(Sheet)} (package, doc, sheet) VALUES ${rows(Arr.map(ts, (t) => `(1, 1, ${200 + t})`))}`,
		`INSERT INTO ${names.table(Visit)} (child, at) VALUES ${rows(["(7, 1)", ...Arr.map(ts, (t) => `(7, ${100 + t})`)])}`,
		`INSERT INTO ${names.table(Answer)} (child, at, n) VALUES ${rows(["(7, 1, 1)", ...Arr.map(ts, (t) => `(7, 1, ${200 + t})`)])}`,
		`INSERT INTO ${names.table(Note)} (child, package, doc) VALUES ${rows(["(7, 1, 1)", ...Arr.map(ts, (t) => `(${100 + t}, 1, 1)`)])}`
	]
}

/** The statement of `op` in transaction `t`: a row no transaction wrote before, or one `seeded` stored for it alone. */
const statementOf = (installed: Installed, op: Op, t: number): string => {
	const names = namesOf(installed)
	switch (op) {
		case "insert Doc":
			return `INSERT INTO ${names.table(Doc)} (package, doc) VALUES (1, ${300 + t})`
		case "delete Doc":
			return `DELETE FROM ${names.table(Doc)} WHERE package = 1 AND doc = ${100 + t}`
		case "insert Part":
			return `INSERT INTO ${names.table(Part)} (package, doc, part) VALUES (1, 1, ${300 + t})`
		case "delete Part":
			return `DELETE FROM ${names.table(Part)} WHERE package = 1 AND doc = 1 AND part = ${200 + t}`
		case "insert Sheet":
			return `INSERT INTO ${names.table(Sheet)} (package, doc, sheet) VALUES (1, 1, ${300 + t})`
		case "delete Sheet":
			return `DELETE FROM ${names.table(Sheet)} WHERE package = 1 AND doc = 1 AND sheet = ${200 + t}`
		case "insert Visit":
			return `INSERT INTO ${names.table(Visit)} (child, at) VALUES (7, ${300 + t})`
		case "delete Visit":
			return `DELETE FROM ${names.table(Visit)} WHERE child = 7 AND at = ${100 + t}`
		case "insert Answer":
			return `INSERT INTO ${names.table(Answer)} (child, at, n) VALUES (7, 1, ${300 + t})`
		case "delete Answer":
			return `DELETE FROM ${names.table(Answer)} WHERE child = 7 AND at = 1 AND n = ${200 + t}`
		case "insert Note":
			return `INSERT INTO ${names.table(Note)} (child, package, doc) VALUES (${300 + t}, 1, 1)`
		case "delete Note":
			return `DELETE FROM ${names.table(Note)} WHERE child = ${100 + t} AND package = 1 AND doc = 1`
	}
}

/** The sorted text of a set of names, for a report. */
const listed = (names: Iterable<string>): string =>
	Formatter.format(Arr.sort([...names], Order.String))

/** Whether two sets of names hold the same names. */
const sameSet = (x: ReadonlySet<string>, y: ReadonlySet<string>): boolean =>
	x.size === y.size && Arr.every([...x], (n) => y.has(n))

/**
 * The deltas a transaction wrote a row into, as its judge reads them: the written set of the sentinel's row
 * (physical/ddl/rules.ts arming, marked), read before the judge runs, which deletes the row and every row of the deltas
 * it names once its statements read them; none where no sentinel or no row stands. Found by its column in the
 * catalog, which locks no table, and read by its one row, which locks the sentinel alone, no delta.
 */
const writtenSet = (session: RawSession) =>
	Effect.gen(function* () {
		const sentinels = yield* session.values(
			"SELECT c.relname::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND a.attname = '__written'",
			[]
		)
		const written = new Set<string>()
		for (const [name] of sentinels) {
			for (const [set] of yield* session.values(
				`SELECT __written FROM pg_temp.${quoteIdent(String(name))}`,
				[]
			)) {
				for (const delta of Arr.isArray(set) ? set : []) {
					written.add(String(delta))
				}
			}
		}
		return written
	})

/** What the session holds once a transaction's judge ran: the deltas it holds a lock on, which every statement of the
 * transaction that read or wrote one took, read before anything here reads a delta; the deltas that stand; and the
 * stored tables it holds ACCESS SHARE on, which a statement takes on every table it reads until the transaction ends. */
const observed = (
	session: RawSession,
	deltas: ReadonlyArray<string>,
	stored: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const locks = yield* session.values(
			"SELECT c.relname::text FROM pg_catalog.pg_locks AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relation WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'relation' AND c.relpersistence = 't'",
			[]
		)
		const touched = new Set(Arr.map(locks, ([name]) => String(name)))
		const standing = new Set<string>()
		for (const name of deltas) {
			const [[stands] = []] = yield* session.values(
				`SELECT to_regclass(${quoteString(printObjectName(objectName(temporarySchema, name)))}) IS NOT NULL`,
				[]
			)
			if (stands === true) {
				standing.add(name)
			}
		}
		const locked = new Set<string>()
		for (const table of stored) {
			const [[held] = []] = yield* session.values(
				`SELECT EXISTS (SELECT FROM pg_catalog.pg_locks WHERE pid = pg_catalog.pg_backend_pid() AND locktype = 'relation' AND mode = 'AccessShareLock' AND relation = ${quoteString(table)}::pg_catalog.regclass)`,
				[]
			)
			if (held === true) {
				locked.add(table)
			}
		}
		return { touched, standing, locked }
	})

/**
 * The stand-ups a served write's session calls before the case's transactions, of the tables they write alone
 * (`standUpRelations`): the judge's tables a capture of each requires, its own deltas and those its parts read beside
 * them, and no other table's.
 */
export const standUpWritten = (session: RawSession, installed: Installed, drawn: Writes) =>
	standUpRelations(
		session,
		installed.installation,
		Arr.dedupe(Arr.flatMap(drawn.transactions, (writes) => Arr.map(writes, relationOf)))
	)

/**
 * One case on a fresh clone, in one session, each transaction in turn: its writes, its written set read, the judge run
 * by SET CONSTRAINTS ALL IMMEDIATE, then what the session holds read, and COMMIT. The judge runs each of its statements
 * (test/support/judge.ts judgeStatementsOf), a stored relation's upkeep's and a rule's alike, exactly where a delta it
 * reads holds a row, which the written set names (README, Rules over queries: a rule is judged over the rows a
 * transaction wrote, and over deltas that hold none its region is empty; physical/ddl/rules.ts addRules: an upkeep runs
 * where a delta of a holder it reads holds one): the stored tables the transaction holds ACCESS SHARE on are exactly
 * those the statements over its written deltas read, since nothing else of the transaction reads a stored table; the
 * judge reads no delta but those the transaction wrote, those the statements that ran read, and those the captures of
 * the tables written write, the tables of the transaction's statements and the stored table of each upkeep that ran;
 * and the session holds no delta its stand-up did not make (physical/ddl/rules.ts addStandUps), so no transaction makes
 * a relation.
 *
 * The written set is read before the judge runs, so it names no delta an upkeep's writes fill inside it, and a
 * statement over such a delta runs beyond those the set names: none does here, since no write of the box changes
 * Documented (`Dispatch`), and were one to, the ACCESS SHARE it takes on Note's table would refuse the case.
 */
export const runWrites = (
	installed: Installed,
	admin: PgConnection,
	session: RawSession,
	drawn: Writes,
	c: Case<DispatchFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(admin, installed.installation)
		for (const sql of seeded(installed)) {
			yield* admin.query(sql, [])
		}
		const statements = judgeStatementsOf(installed.installation)
		assert.ok(statements.length > 0, "the judge holds a statement of each rule")
		/** Every delta a statement of the judge reads or fills. */
		const deltas = Arr.dedupe(Arr.flatMap(statements, (s) => [...s.deltas, ...filledBy(s)]))
		/** Every stored table: each relation's, and each a statement of the judge reads, Documented's among them. */
		const stored = Arr.dedupe([
			...Arr.map(tables, (t) => namesOf(installed).table(t)),
			...Arr.flatMap(statements, (s) => [...s.stored])
		])
		/** The deltas the session's stand-up made, before its first transaction. */
		const stood = (yield* observed(session, deltas, stored)).standing
		/** The deltas an earlier transaction of the session wrote a row into. */
		const wroteBefore = new Set<string>()
		for (const [t, writes] of drawn.transactions.entries()) {
			const where = `transaction ${t} of ${Formatter.format(drawn)}`
			yield* session.begin
			for (const op of writes) {
				yield* session.query(statementOf(installed, op, t), [])
			}
			const written = yield* writtenSet(session)
			yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
			const { touched, standing, locked } = yield* observed(session, deltas, stored)
			const ran = Arr.filter(statements, (s) => Arr.some([...s.deltas], (d) => written.has(d)))
			const expectedLocked = new Set(Arr.flatMap(ran, (s) => [...s.stored]))
			assert.ok(
				sameSet(locked, expectedLocked),
				`${where}: the transaction holds ACCESS SHARE on exactly the tables the statements over its written deltas ${listed(written)} read, ${listed(expectedLocked)}, not ${listed(locked)}`
			)
			const stoodUp = new Set(Arr.flatMap(ran, (s) => [...s.deltas]))
			/** The deltas the captures of the tables the transaction wrote write: each relation's its statements wrote,
			 * and each stored relation's an upkeep that ran wrote, inside the judge. */
			const captured = new Set([
				...Arr.flatMap(writes, (op) =>
					Arr.map(capturedDeltasOf(installed.installation, relationOf(op)), (d) => d.name)
				),
				...Arr.flatMap(ran, (s) => [...filledBy(s)])
			])
			const read = Arr.filter([...touched], (d) => Arr.contains(deltas, d))
			assert.ok(
				Arr.every(read, (d) => written.has(d) || stoodUp.has(d) || captured.has(d)),
				`${where}: the judge reads no delta but those the transaction wrote, ${listed(written)}, those the statements that ran read, ${listed(stoodUp)}, and those the captures of the tables written write, ${listed(captured)}, not ${listed(read)}`
			)
			const added = Arr.filter([...standing], (d) => !stood.has(d))
			assert.ok(
				!Arr.isReadonlyArrayNonEmpty(added),
				`${where}: the transaction made deltas, ${listed(added)}, beside those the session's stand-up made, ${listed(stood)}`
			)
			for (const s of ran) {
				const by = Arr.filter([...s.deltas], (d) => written.has(d))
				if (s.deltas.size >= 2 && by.length === 1) {
					c.note("a statement over two deltas run by a write of one of them alone")
				}
				if (by.length > 0 && Arr.every(by, Str.startsWith("__delta_olds_"))) {
					c.note("a statement run by a side of olds alone")
				}
			}
			if (Arr.some([...stoodUp], (d) => !written.has(d))) {
				c.note("a delta a statement that ran read, whose transaction wrote no row of it")
			}
			if (Arr.some([...wroteBefore], (d) => !written.has(d))) {
				c.note("a delta an earlier transaction wrote, holding no row in a later one")
			}
			if (ran.length === 0) {
				c.note("a transaction whose writes run no statement")
			}
			yield* session.commit
			for (const d of written) {
				wroteBefore.add(d)
			}
		}
	})

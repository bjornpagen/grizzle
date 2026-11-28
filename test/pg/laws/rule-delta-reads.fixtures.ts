/** What the property of rule-delta-reads.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { pgCluster } from "#test/support/env.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { openSession, type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, type SubstrateCase } from "#test/support/substrate/substrate.ts"

/** The rows of a document, each of a kind. */
const T = relation("T", { doc: int4, at: int4, kind: int4, b: int4 }, ["doc", "at"])

/** The rows of a document a stored relation keeps those of one kind of, each of a kind. */
const U = relation("U", { doc: int4, at: int4, kind: int4 }, ["doc", "at"])

const Base = schema("delta_selection", [T, U], [unit("Document", { doc: int4 })])

/** T and U, which rule-log.fixtures.ts writes through. */
export const selectionRelations = [T, U] as const

/** The kinds a case writes: each judged kind and two no rule reads. */
const kinds = [1, 2, 3, 4, 5] as const
type Kind = (typeof kinds)[number]

/** The kinds a rule judges, each by a rule of its own; a kind past them no rule reads. */
const judgedKinds: ReadonlyArray<Kind> = [1, 2, 3]

/** The kind of U's rows the stored relation keeps. */
const keptKind: Kind = 4

/**
 * The `b` of T's facts of kind `k` by document: a projection no wider than the document's unit, whose upkeep would
 * re-derive a document's facts at every write of it, so it is live (analysis/derived/storage.ts, `unboundedUpkeep`)
 * and the check over it a rule the judge holds over T's delta under its kind's selection; a check of each row, which
 * the projection keeps, is the law it was over T's facts by place.
 */
const ofKind = (k: number) => (r: Rule<typeof Base>) => {
	const { doc, at, b } = v(T, "t")
	return r.match(T, { doc, at, kind: k, b }).find({ doc, b })
}

const one = derived("Kind1", query(Base).rule(ofKind(1)))
const two = derived("Kind2", query(Base).rule(ofKind(2)))
const three = derived("Kind3", query(Base).rule(ofKind(3)))

/** U's facts of the kept kind by document and place, stored at the document's unit: its upkeep's region reads U's
 * deltas under the selection of that kind. */
const kept = derived(
	"Kept",
	query(Base).rule((r) => {
		const { doc, at } = v(U, "u")
		return r.match(U, { doc, at, kind: keptKind }).find({ doc, at })
	})
)

/**
 * Three rules over T, each judging the rows of one kind alone: a check that its `b` is at least 0, which the rule judge
 * holds over a derived relation of T's facts of that kind, so each statement of it reads T's delta under the
 * selection of its kind; and Kept, whose upkeep reads U's deltas under the selection of the kept kind.
 */
const Selection = schema.extend(
	[Base],
	"delta_selection_1",
	[one, two, three, kept],
	[
		check("FirstAtLeastZero", one, (d) => d.ge(d.b, 0)),
		check("SecondAtLeastZero", two, (d) => d.ge(d.b, 0)),
		check("ThirdAtLeastZero", three, (d) => d.ge(d.b, 0))
	]
)

/** Selection installed through its first migration, with no login. */
export const selectionTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule delta reads",
	content: { schema: "delta_selection", logins: [] },
	versions: [{ schema: Selection, declarations: noDeclarations }],
	options: {
		label: "rule_delta_reads",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The most rows a case writes of one kind. */
const rowsAtMost = 24

/**
 * A case: the rows its one transaction writes of each kind, in `kinds`' order, each lawful (`b` at least 0); and the
 * kind of one row more whose `b` is -1, none for a write of lawful rows alone.
 */
export interface Writes {
	readonly rows: ReadonlyArray<number>
	readonly breaking: Kind | undefined
}

export const writesGen: Gen<Writes> = (s) => ({
	rows: s.draw(array(int(0, rowsAtMost), { min: kinds.length, max: kinds.length })),
	breaking: s.draw(element<Kind | undefined>([undefined, 1, 2, 3, 4, 5]))
})

export type DeltaReadsFeature =
	| "rows of a kind no rule reads in the delta"
	| "two judged kinds holding rows"
	| "a judged kind holding no row"
	| "a breaking row of a judged kind refused"
	| "a breaking row of a kind no rule reads committed"
	| "an upkeep whose selection holds rows beside rows it does not select"
	| "an upkeep whose selection holds no written row"

/** The rows the case writes of `kind`, by its place in `kinds`. */
const rowsOf = (drawn: Writes, kind: Kind): number => drawn.rows[kinds.indexOf(kind)] ?? 0

/** The settings that turn pg_stat_statements on in the case's database alone (test/pg/adapter/second-call.fixtures.ts). */
const tracked = ["compute_query_id = 'on'", "pg_stat_statements.track = 'all'"] as const

/**
 * The passes over the rows of the delta `delta` the cluster's statement statistics count in the case's database: the
 * calls of every statement of the judge that unnests an array of the delta's rows and names the delta, by its variable
 * or its row type (a FOR's query, which PL/pgSQL hands the planner with its variables as placeholders, names it by the
 * type of the rows it aggregates), each one pass over every row it holds: the judge's netting of it, its borrow of the
 * units the transaction wrote, and its part's making of its selections, never its claim, the one DELETE among them,
 * which reads the log; and the calls of the grouped pass among them, the one that groups and calls no borrow
 * (physical/ddl/deltas.ts selectionsMade).
 */
const passes = (statistics: RawSession, database: string, delta: string) =>
	Effect.map(
		statistics.values(
			"SELECT COALESCE(sum(s.calls), 0)::int8, COALESCE(sum(s.calls) FILTER (WHERE pg_catalog.strpos(s.query, 'GROUP BY') > 0 AND pg_catalog.strpos(s.query, '__borrow') = 0), 0)::int8 FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text AND pg_catalog.strpos(s.query, $2::text) > 0 AND pg_catalog.strpos(s.query, '\"pg_catalog\".\"unnest\"(') > 0 AND pg_catalog.strpos(s.query, 'DELETE FROM') = 0",
			[database, quoteIdent(delta)]
		),
		(rows) => ({ calls: Number(rows[0]?.[0]), grouped: Number(rows[0]?.[1]) })
	)

/** The rows of `relation`'s table, the session reading it. */
const rowsIn = (session: RawSession, table: string) =>
	Effect.map(session.values(`SELECT count(*) FROM ${table}`, []), (rows) => Number(rows[0]?.[0]))

/**
 * One case on a fresh clone: its database counting every statement's calls and rows, functions' included; one session
 * writes the case's rows of T in one transaction, its lawful rows into U too, and runs the judge by SET CONSTRAINTS ALL
 * IMMEDIATE. A breaking row of a judged kind is refused, one of a kind no rule reads committed. Over a lawful write the
 * judge passes over T's delta three times at most, its netting, its borrow of the units the write wrote, and one pass
 * grouped by kind that makes the three rules' selections, however many rules select its rows; and each selection holds exactly its kind's rows: each of Kind1,
 * Kind2 and Kind3 holds a row of each row of its kind the write put, and Kept, whose upkeep reads U's news under the
 * selection of the kept kind, a row of each of U's rows of that kind, none of another's.
 */
export const runWrites = (
	selection: SubstrateCase<Installed>,
	drawn: Writes,
	c: Case<DeltaReadsFeature>
) =>
	Effect.gen(function* () {
		const { substrate, value: installed } = selection
		const admin: PgConnection = substrate.admin
		for (const setting of tracked) {
			yield* admin.query(`ALTER DATABASE ${quoteIdent(substrate.database)} SET ${setting}`, [])
		}
		const statistics = yield* openSession(substrate.cluster, {
			database: pgCluster.owner,
			credentials: substrate.owner,
			label: "statement statistics"
		})
		const session = yield* substrate.session({ ...ownerSession(), label: "delta reads" })
		const sides = Arr.flatMap(installed.installation.statements, (st) =>
			st.kind === "createJudgeLog" && st.log.kind === "deltas"
				? Arr.map(st.log.sides, (side) => side.column)
				: []
		)
		const [delta, ...others] = Arr.filter(sides, Str.startsWith("__delta_news_t_"))
		assert.ok(
			delta !== undefined && others.length === 0,
			"the judge's log holds T's side of news, which its rules read"
		)
		const names = namesOf(installed)
		const values = Arr.flatMap(kinds, (kind) =>
			Array.from(
				{ length: rowsOf(drawn, kind) },
				(_, i) => `(1, ${kind * 1000 + i}, ${kind}, ${i})`
			)
		)
		const uValues = Arr.flatMap(kinds, (kind) =>
			Array.from({ length: rowsOf(drawn, kind) }, (_, i) => `(1, ${kind * 1000 + i}, ${kind})`)
		)
		const where = Formatter.format(drawn)
		const before = yield* passes(statistics, substrate.database, delta)
		yield* session.begin
		if (Arr.isReadonlyArrayNonEmpty(values)) {
			yield* session.query(
				`INSERT INTO ${names.table(T)} (doc, at, kind, b) VALUES ${Arr.join(values, ", ")}`,
				[]
			)
			yield* session.query(
				`INSERT INTO ${names.table(U)} (doc, at, kind) VALUES ${Arr.join(uValues, ", ")}`,
				[]
			)
		}
		if (drawn.breaking !== undefined) {
			yield* session.query(
				`INSERT INTO ${names.table(T)} (doc, at, kind, b) VALUES (1, ${drawn.breaking * 1000 + rowsAtMost}, ${drawn.breaking}, -1)`,
				[]
			)
		}
		const judged = drawn.breaking !== undefined && Arr.contains(judgedKinds, drawn.breaking)
		const run = yield* Effect.result(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (judged) {
			assert.ok(
				Result.isFailure(run),
				`${where}: a row of judged kind ${drawn.breaking} whose b is -1 is refused`
			)
			c.note("a breaking row of a judged kind refused")
			yield* session.rollback
			return
		}
		assert.ok(Result.isSuccess(run), `${where}: a lawful write commits`)
		if (drawn.breaking !== undefined) {
			c.note("a breaking row of a kind no rule reads committed")
		}
		yield* session.commit
		const after = yield* passes(statistics, substrate.database, delta)
		const calls = after.calls - before.calls
		const grouped = after.grouped - before.grouped
		const judgedRows = Arr.map(judgedKinds, (k) => rowsOf(drawn, k))
		const tRows =
			Arr.reduce(kinds, 0, (sum, k) => sum + rowsOf(drawn, k)) +
			(drawn.breaking === undefined ? 0 : 1)
		if (rowsOf(drawn, 4) + rowsOf(drawn, 5) > 0) {
			c.note("rows of a kind no rule reads in the delta")
		}
		if (Arr.filter(judgedRows, (n) => n > 0).length >= 2) {
			c.note("two judged kinds holding rows")
		}
		if (Arr.some(judgedRows, (n) => n === 0)) {
			c.note("a judged kind holding no row")
		}
		assert.ok(
			calls <= 3,
			`${where}: the judge passes over T's delta ${calls} times, where its netting, its borrow of the units it wrote and one grouped pass are 3 at most`
		)
		assert.equal(
			grouped,
			tRows > 0 ? 1 : 0,
			`${where}: one grouped pass makes the three rules' selections of T's delta`
		)
		for (const [k, stored] of [
			[1, one],
			[2, two],
			[3, three]
		] as const) {
			const held = yield* rowsIn(session, names.table(stored))
			assert.equal(
				held,
				rowsOf(drawn, k),
				`${where}: Kind${k} holds a row of each of T's rows of kind ${k} the write put, its selection's rows`
			)
		}
		const matched = rowsOf(drawn, keptKind)
		const written = Arr.reduce(kinds, 0, (sum, k) => sum + rowsOf(drawn, k))
		if (written > matched) {
			c.note(
				matched > 0
					? "an upkeep whose selection holds rows beside rows it does not select"
					: "an upkeep whose selection holds no written row"
			)
		}
		const keptRows = yield* rowsIn(session, names.table(kept))
		assert.equal(
			keptRows,
			matched,
			`${where}: Kept holds a row of each of U's rows of the kept kind, its selection's rows, of the ${written} U holds`
		)
	}).pipe(Effect.scoped)

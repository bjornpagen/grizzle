/** What the property of rule-delta-reads.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema, unit } from "#compiler/public/schema.ts"
import { objectName } from "#compiler/sql/build.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { pgCluster } from "#test/support/env.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { readersOf, standUpRelations, upkeepPlans } from "#test/support/judge.ts"
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
 * The calls and the rows of every statement of `delta`'s readers the cluster's statement statistics count in the case's
 * database: each reader's one SELECT of the delta, run inside it, its text the delta's table read as `r1`.
 */
const readerCounts = (statistics: RawSession, database: string, delta: string) =>
	Effect.map(
		statistics.values(
			"SELECT COALESCE(sum(s.calls), 0)::int8, COALESCE(sum(s.rows), 0)::int8 FROM public.pg_stat_statements AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.dbid WHERE d.datname = $1::text AND NOT s.toplevel AND s.query LIKE 'SELECT \"r1\".%' AND pg_catalog.strpos(s.query, $2::text) > 0",
			[database, `${printObjectName(objectName(temporarySchema, delta))} AS "r1"`]
		),
		(rows) => ({ calls: Number(rows[0]?.[0]), rows: Number(rows[0]?.[1]) })
	)

/**
 * Judges Kept's upkeep's reads of U's deltas over the case's write, its statements explained over the deltas the
 * captures wrote (support/judge.ts upkeepPlans): each statement calls each reader of U's deltas once at most, and each
 * call that runs returns, of U's news, its rows of the kept kind, the news Kept's definition can match, and of its olds,
 * none, the write removing no row; the INSERT, which reads the region its definition is read at, calls the reader of
 * U's news. So an upkeep whose selection holds no written row reads none, however many rows of other kinds U holds.
 */
const upkeepReads = (
	installed: Installed,
	drawn: Writes,
	plans: ReadonlyArray<PlanNode>,
	c: Case<DeltaReadsFeature>
): void => {
	const where = Formatter.format(drawn)
	const readers = readersOf(installed.installation)
	const matched = rowsOf(drawn, keptKind)
	const written = Arr.reduce(kinds, 0, (sum, k) => sum + rowsOf(drawn, k))
	if (written > matched) {
		c.note(
			matched > 0
				? "an upkeep whose selection holds rows beside rows it does not select"
				: "an upkeep whose selection holds no written row"
		)
	}
	assert.equal(plans.length, 2, `${where}: Kept's upkeep is a DELETE and an INSERT`)
	for (const [at, plan] of plans.entries()) {
		const statement = at === 0 ? "DELETE" : "INSERT"
		const calls = Arr.flatMap([...planNodes(plan)], (n) => {
			const reader = Option.getOrUndefined(n.functionName)
			const delta = reader === undefined ? undefined : readers.get(reader)
			return n.nodeType === "Function Scan" && reader !== undefined && delta !== undefined
				? [{ reader, delta, node: n }]
				: []
		})
		for (const { reader, delta, node } of calls) {
			assert.ok(
				Arr.filter(calls, (other) => other.reader === reader).length === 1 && node.actualLoops <= 1,
				`${where}: the upkeep's ${statement} calls ${reader} once at most, not at ${Arr.filter(calls, (other) => other.reader === reader).length} scans of ${node.actualLoops} loops`
			)
			const news = Str.startsWith("__delta_news_u_")(delta)
			const selected = node.actualLoops === 0 ? 0 : news ? matched : 0
			assert.equal(
				node.actualRows * node.actualLoops,
				selected,
				`${where}: the upkeep's ${statement} reads of ${delta} through ${reader} its ${selected} rows of the kept kind, of the ${news ? written : 0} it holds`
			)
		}
		if (statement === "INSERT" && written > 0) {
			assert.ok(
				Arr.some(
					calls,
					({ delta, node }) => Str.startsWith("__delta_news_u_")(delta) && node.actualLoops === 1
				),
				`${where}: the upkeep's INSERT reads U's news, its region`
			)
		}
	}
}

/**
 * One case on a fresh clone: its database counting every statement's calls and rows, functions' included; one session
 * stands T and U up, writes the case's rows in one transaction, its lawful rows into U too, and runs the judge by SET
 * CONSTRAINTS ALL IMMEDIATE. A breaking row of a judged kind is refused, one of a kind no rule reads committed. Over a
 * lawful write, T's delta's readers return, at each call, the rows of one judged kind, never the whole delta: the rows
 * they return sum to at least every judged kind's rows, which the judge reads, and to at most their calls times the
 * rows of the kind the case writes most of; and each reads its rows through the delta's B-tree, so the delta's tuples
 * an index fetched are the rows they returned. Kept's upkeep, explained before the judge runs (`upkeepReads`), calls
 * each reader of U's deltas once at most in each of its statements, each call returning U's rows of the kept kind, the
 * news its definition can match: none where the write holds none, however many rows of other kinds U holds.
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
		const deltas = Arr.dedupe([...readersOf(installed.installation).values()])
		const [delta, ...others] = Arr.filter(deltas, Str.startsWith("__delta_news_t_"))
		assert.ok(
			delta !== undefined && others.length === 0,
			"the judge reads T's side of news through its readers"
		)
		yield* standUpRelations(session, installed.installation, ["T", "U"])
		const table = namesOf(installed).table(T)
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
		const before = yield* readerCounts(statistics, substrate.database, delta)
		yield* session.begin
		if (Arr.isReadonlyArrayNonEmpty(values)) {
			yield* session.query(
				`INSERT INTO ${table} (doc, at, kind, b) VALUES ${Arr.join(values, ", ")}`,
				[]
			)
			yield* session.query(
				`INSERT INTO ${namesOf(installed).table(U)} (doc, at, kind) VALUES ${Arr.join(uValues, ", ")}`,
				[]
			)
		}
		if (drawn.breaking !== undefined) {
			yield* session.query(
				`INSERT INTO ${table} (doc, at, kind, b) VALUES (1, ${drawn.breaking * 1000 + rowsAtMost}, ${drawn.breaking}, -1)`,
				[]
			)
		}
		const plans = yield* upkeepPlans(
			(sql) => session.query(sql, []),
			(sql) => session.values(sql, []),
			installed.installation,
			"Kept"
		)
		upkeepReads(installed, drawn, plans, c)
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
		const [[fetched] = []] = yield* session.values(
			`SELECT COALESCE(idx_tup_fetch, 0)::int8 FROM pg_catalog.pg_stat_xact_all_tables WHERE relid = pg_catalog.to_regclass(${quoteString(printObjectName(objectName(temporarySchema, delta)))})`,
			[]
		)
		yield* session.commit
		const after = yield* readerCounts(statistics, substrate.database, delta)
		const calls = after.calls - before.calls
		const returned = after.rows - before.rows
		const judgedRows = Arr.map(judgedKinds, (k) => rowsOf(drawn, k))
		const most = Arr.reduce(judgedRows, 0, (best, n) => Math.max(best, n))
		const every = Arr.reduce(judgedRows, 0, (sum, n) => sum + n)
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
			returned >= every,
			`${where}: T's delta's readers return every judged kind's rows, ${every}, not ${returned}`
		)
		assert.ok(
			returned <= calls * most,
			`${where}: each of the ${calls} calls of T's delta's readers returns one judged kind's rows, at most ${most}, so ${returned} rows at most ${calls * most}`
		)
		assert.equal(
			Number(fetched),
			returned,
			`${where}: each reader reads the rows it returns through the delta's B-tree, its index fetching ${returned} of T's delta's tuples, not ${Number(fetched)}`
		)
	}).pipe(Effect.scoped)

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Predicate, Result } from "effect"
import {
	excludesNothing,
	oneShotStatement,
	preparedStatement,
	runFramed,
	writeFrame
} from "#adapter/wire/batch.ts"
import { prepared } from "#compiler/core/prepared.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { indexRef, type IndexRef } from "#compiler/physical/indexes/ref.ts"
import { textParam } from "#compiler/plan/read.ts"
import { type Advice, printAdvice } from "#compiler/sql/advice.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import type { PlanScan } from "#compiler/sql/plan.ts"
import { fenceSql, prologueIn } from "#test/support/flight/model.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/**
 * How a case's advice reads its table: whole (`seq`, SEQ_SCAN), or through its key's index (`key`, INDEX_SCAN). The
 * planner's own choice for a read by the key is one of the two, so the other shows whether the advice made the plan.
 */
export const advisedScans = ["seq", "key"] as const
export type AdvisedScan = (typeof advisedScans)[number]

/** A case: the advised scan, and the key its statement reads. */
export interface TimingCase {
	readonly scan: AdvisedScan
	readonly key: number
}

/** Each scan, at a key its table holds or past them. */
export const timingCases: Gen<TimingCase> = (source) => ({
	scan: source.draw(element(advisedScans)),
	key: source.draw(int(0, 40))
})

/** The plan node each advised scan reads the table by, as EXPLAIN names it. */
export const planNodeOf: { readonly [S in AdvisedScan]: string } = {
	seq: "Seq Scan on",
	key: "Index Scan using"
}

/**
 * The advice of a read of the case's table under `alias`, by `scan`, printed from its plan (sql/advice.ts printAdvice):
 * read whole, or through the key's index, `t_pkey` in `schema`.
 */
const adviceOf = (scan: AdvisedScan, alias: AdviceScope, schema: string): Advice => {
	const r1 = alias.alias({ kind: "internal", purpose: "the case's table" })
	const read: PlanScan<IndexRef> =
		scan === "seq"
			? { kind: "seq" }
			: {
					kind: "index",
					index: indexRef({
						name: { schema, name: "t_pkey" },
						method: "btree",
						stores: ["k"],
						returns: true
					}),
					bound: ["k"],
					needs: ["k", "v"]
				}
	return defined(
		printAdvice({
			levels: [
				{ kind: "joins", name: { kind: "top" }, first: { alias: r1, scan: read }, joined: [], appended: [] }
			]
		}),
		"the advice of a read of one table"
	)
}

/** The text cells of an answer's rows, in order. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row) => Arr.filter(row, Predicate.isString))

/**
 * A case on a fresh clone: its schema fenced as an installation's (test/support/flight/model.ts fenceSql), a table
 * `t (k, v)` of 32 rows keyed by k, then on a session opened after, two Db transactions. The first, behind a prologue
 * whose advice reads the table by the case's scan, sends one prepared statement, `SELECT v FROM t AS r1 WHERE r1.k =
 * $1`, which the session prepares then, and so plans then, at its Bind, a generic plan it keeps (force_generic_plan).
 * The second, behind a prologue of other advice, asks EXPLAIN of that kept plan (EXECUTE of the statement's name),
 * which PostgreSQL answers without planning again. What it answers: the kept plan's lines.
 */
export const runTiming = (x: TimingCase) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const raw = yield* s.schema(freshSchema)
		const table = `${quoteIdent(raw)}."t"`
		for (const { sql, params } of fenceSql(raw, s.owner.role)) {
			yield* s.admin.query(sql, params)
		}
		yield* s.admin.query(
			`CREATE TABLE ${table} ("k" int4, "v" int4 NOT NULL, CONSTRAINT "t_pkey" PRIMARY KEY ("k"))`,
			[]
		)
		yield* s.admin.query(
			`INSERT INTO ${table} ("k", "v") SELECT i, i FROM pg_catalog.generate_series(1, 32) AS i`,
			[]
		)
		const tapped = yield* tappedSession({
			cluster: s.cluster,
			database: s.database,
			role: s.owner.role,
			password: s.owner.password
		})
		const prologue = prologueIn(raw)
		const read = prepared(testSql(`SELECT "r1"."v" FROM ${table} AS "r1" WHERE "r1"."k" = $1`))
		const first = yield* Effect.result(
			runFramed(
				tapped.session,
				writeFrame(
					prologue,
					"serializable",
					excludesNothing,
					adviceOf(x.scan, new AdviceScope(), raw)
				),
				[preparedStatement(read, [textParam(String(x.key))])]
			)
		)
		const other = new AdviceScope()
		other.alias({ kind: "internal", purpose: "the case's table, aliased past the read's" })
		const explained = yield* Effect.result(
			runFramed(
				tapped.session,
				writeFrame(prologue, "serializable", excludesNothing, adviceOf("seq", other, raw)),
				[
					oneShotStatement(
						testSql(`EXPLAIN (COSTS OFF) EXECUTE ${quoteIdent(read.name)}(${String(x.key)})`),
						[]
					)
				]
			)
		)
		return {
			first: Result.isSuccess(first) ? "ran" : first.failure._tag,
			plan: Result.isSuccess(explained)
				? texts(Arr.flatMap(explained.success, (outcome) => outcome.rows))
				: [explained.failure._tag]
		}
	})

/** What existence-witness.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { type PlanNode, planNodes, scannedRows } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { natural, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import {
	fullWorldRole,
	type PgClassState,
	pgClassStates,
	type StateLoad,
	servedRead,
	servedRun,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { Generated, Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { RolledBack } from "#test/support/substrate/substrate.ts"

/** The left side's rows, a few keys and a count each. */
const Asked = relation("Asked", { k1: int4, k2: int4, v: natural }, ["k1", "k2"])

/** A large store of facts by key, several at each key. */
const Held = relation("Held", { k1: int4, k2: int4, x: int4 }, ["k1", "k2", "x"])

/** A second store, joined to the first by the key. */
const Marked = relation("Marked", { k1: int4, k2: int4, y: int4 }, ["k1", "k2", "y"])

const Stored = schema("ExistenceWitness", [Asked, Held, Marked], [])

/** The facts of Held at a key Marked holds too: a right side of two sources. */
const joined = query(Stored).rule((r) => {
	const { k1, k2, x } = v(Held, "held")
	const { y } = v(Marked, "marked")
	return r.match(Held, { k1, k2, x }).match(Marked, { k1, k2, y }).find({ k1, k2 })
})

/** How many facts Held holds at each key: a fold by the key. */
const folded = query(Stored).rule((r) => {
	const { k1, k2, x } = v(Held, "held")
	return r.match(Held, { k1, k2, x }).find({ k1, k2, n: r.count() })
})

/** What a case negates: the join by the key, the fold by the key, or the fold by its count. */
export type Shape = "the join by the key" | "the fold by the key" | "the fold by its count"

/** The asked keys no fact of the shape's right side matches. */
const negated = (shape: Shape) =>
	query(Stored).rule((r) => {
		const { k1, k2, v: count } = v(Asked, "asked")
		const asked = r.match(Asked, { k1, k2, v: count })
		switch (shape) {
			case "the join by the key":
				return asked.where(r.not(joined, { k1, k2 })).find({ k1, k2 })
			case "the fold by the key":
				return asked.where(r.not(folded, { k1, k2 })).find({ k1, k2 })
			case "the fold by its count":
				return asked.where(r.not(folded, { k1, n: count })).find({ k1, k2 })
		}
	})

/**
 * The schema installed through its first migration as `grizzle generate` drafts and serves it, with its full world's
 * login, whose workload reads each shape's negation: the indexes those reads ask are the installation's.
 */
export const existenceWitnessTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "existence witness",
	fixture: Stored,
	programs: {
		joined: negated("the join by the key"),
		folded: negated("the fold by the key"),
		counted: negated("the fold by its count")
	},
	contexts: [],
	label: "existence_witness",
	ambient: ordinarySession
})

/**
 * A case: the shape negated, how many keys the store holds (key i is (i, i mod 7)), how many facts Held holds at each
 * and how many keys are asked, every third at a key Marked holds, and the pg_class state every table stands in
 * (test/support/advice.ts PgClassState).
 */
export interface Witness {
	readonly shape: Shape
	readonly keys: number
	readonly each: number
	readonly asked: number
	readonly state: PgClassState
}

export const witnessGen: Gen<Witness> = (s) => ({
	shape: s.draw(
		element(["the join by the key", "the fold by the key", "the fold by its count"] as const)
	),
	keys: s.draw(int(2000, 4000)),
	each: s.draw(int(1, 4)),
	asked: s.draw(int(2, 6)),
	state: s.draw(element<PgClassState>(pgClassStates))
})

export type WitnessFeature = Shape | `with every table ${PgClassState}`

/** The asked keys: i * 97 mod keys for i < asked, a key of the store each. */
const askedKeys = (c: Witness): ReadonlyArray<number> =>
	Array.from({ length: c.asked }, (_, i) => 1 + ((i * 97) % c.keys))

/** Whether Marked holds key i: every third key. */
const marked = (i: number): boolean => i % 3 === 0

/** The count of the asked key at place `at`, its v: the facts Held holds at each key, or one more for every other asked key. */
const countOf = (c: Witness, at: number): number => c.each + (at % 2)

/** The keys the read delivers, as `k1 k2`, from the shape's rule on the host. */
const expected = (c: Witness): ReadonlyArray<string> =>
	Arr.flatMap(askedKeys(c), (i, at) => {
		const kept =
			c.shape === "the join by the key"
				? !marked(i)
				: c.shape === "the fold by the key"
					? false
					: countOf(c, at) !== c.each
		return kept ? [`${i} ${i % 7}`] : []
	})

/**
 * The case's rows stored by ordinary writes (test/support/advice.ts StateLoad), a key its unit: keys `from` to `to` of
 * Held, each with its facts, of Marked, every third, and of Asked, those asked.
 */
const loaded = (session: BenchSession, installed: Installed, c: Witness): StateLoad => {
	const names = namesOf(installed)
	const asked = names.table(Asked)
	const held = names.table(Held)
	const markedTable = names.table(Marked)
	return {
		tables: [asked, held, markedTable],
		units: c.keys,
		load: (from, to) =>
			Effect.forEach(
				[
					`INSERT INTO ${held} SELECT i, i % 7, x FROM generate_series(${from}, ${to}) AS g(i), generate_series(1, ${c.each}) AS h(x)`,
					`INSERT INTO ${markedTable} SELECT i, i % 7, 1 FROM generate_series(${from}, ${to}) AS g(i) WHERE i % 3 = 0`,
					...Arr.flatMap(askedKeys(c), (i, at) =>
						i >= from && i <= to
							? [`INSERT INTO ${asked} VALUES (${i}, ${i % 7}, ${countOf(c, at)})`]
							: []
					)
				],
				(sql) => session.values(sql, []),
				{ discard: true }
			)
	}
}

/** The rows a plan's scans of `table` read over every loop, and the most PostgreSQL's rounding may add to the sum. */
const readOf = (plan: PlanNode, table: string): { readonly rows: number; readonly slack: number } =>
	Arr.reduce(
		Arr.filter(
			Arr.fromIterable(planNodes(plan)),
			(n) => Option.contains(n.relation, table) && n.nodeType !== "Bitmap Index Scan"
		),
		{ rows: 0, slack: 0 },
		(sum, n) => ({ rows: sum.rows + scannedRows(n), slack: sum.slack + n.actualLoops / 200 })
	)

/**
 * The most rows the read's scans of Held may read: for a right side read per left row, the facts at each asked key,
 * and one more for the witness's index probe of a key it does not hold; for the fold by its count, whose count stops
 * every key's restriction, the whole fold, once.
 */
const boundOf = (c: Witness): number =>
	c.shape === "the fold by its count" ? c.keys * c.each : c.asked * (c.each + 1)

/** A row the read delivers as `k1 k2`. */
const rowOf = (row: ReadonlyArray<unknown>): string =>
	Arr.join(
		Arr.map(row, (x) => (typeof x === "string" ? x : String(x))),
		" "
	)

/**
 * One case in its one transaction, which the case's end rolls back: the store and the asked keys stored, every table
 * stood in the case's pg_class state (test/support/advice.ts standIn), then the read of the asked keys the shape's right
 * side does not match as a served Db of the full world runs it (servedRead), run under its carried advice once the plan
 * laws hold over it (servedRun), and read. It answers the host's keys, and its scans of Held read at most the facts at
 * the asked keys where the right side is read per left row, however many keys the store holds, and the whole fold once,
 * never once per asked key, where a count is bound.
 */
export const runWitness = (clone: RolledBack<Generated>, c: Witness, k: Case<WitnessFeature>) =>
	Effect.gen(function* () {
		const { connection } = clone
		const installed = clone.value.installed
		const session: BenchSession = { values: connection.queryValues }
		yield* standIn(session, loaded(session, installed, c), c.state)
		const read = yield* servedRead(
			installed,
			fullWorldRole(installed, Stored, []),
			negated(c.shape),
			`the asked keys ${c.shape} does not match`
		)
		const plan = yield* servedRun(session, read, {})
		const rows = yield* connection.queryValues(read.statement.sql, read.params({}))
		assert.deepEqual(
			Arr.sort(Arr.map(rows, rowOf), Order.String),
			Arr.sort(expected(c), Order.String),
			`${Formatter.format(c)}: the asked keys the right side does not match`
		)
		const bound = boundOf(c)
		const scanned = readOf(plan, namesOf(installed).tableIdent(Held))
		assert.ok(
			scanned.rows <= bound + scanned.slack,
			`${Formatter.format(c)}: the read's scans of Held read ${scanned.rows} rows, at most ${bound}, of the ${c.keys * c.each} stored\n${read.statement.sql}`
		)
		k.note(c.shape)
		k.note(`with every table ${c.state}`)
	})

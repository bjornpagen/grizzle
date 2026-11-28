/** What the properties of exact.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr } from "effect"
import { int8Max } from "#compiler/ir/carriers.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Num } from "#compiler/public/compute.ts"
import { exactInteger, exactMoney, generated, Money, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/**
 * A ledger row: its id, an exact integer `count` and an amount `total`, exact money, and `twice`, the exact integer
 * PostgreSQL generates from its row, count + count.
 */
export const Ledger = relation.generated(
	"Ledger",
	{ id: pg.integer, count: exactInteger, total: exactMoney },
	["id"],
	(row) => ({ twice: generated(exactInteger, Num.add(row.count, row.count)) })
)

/** Each ledger row doubled, written from a query of Ledger: count + count and total + total, exact sums. */
const Doubled = relation("Doubled", { id: pg.integer, count: exactInteger, total: exactMoney }, [
	"id"
])

/**
 * No doubled row's count is one: count + count, an exact integer the row check computes, is never 2, which every row the
 * doubling writes keeps (its count + count is 4 count) and a row of count 1 breaks.
 */
const notOne = check("NotOne", Doubled, (d) => d.ne(Num.add(d.count, d.count), 2n))

/** Each id's rows one unit: ledger rows are put again at new values, so Ledger is mutable. */
export const Exact = schema(
	"Exact",
	[Ledger, Doubled],
	[notOne, mutable(Ledger), unit("Entry", { id: pg.integer })]
)

/** Every ledger row, its generated twice among its fields. */
const ledger = query(Exact).rule((r) => {
	const { id, count, total, twice } = v(Ledger, "l")
	return r.match(Ledger, { id, count, total, twice }).find({ id, count, total, twice })
})

/**
 * The workload: ledger rows inserted and put with the facts each call gives; every row read back, and each row's count
 * offset by a parameter of the exact integer; each row doubled into Doubled by a query whose head writes exact sums into
 * the exact fields; a doubled row inserted with the facts a call gives, which NotOne judges; and every doubled row read
 * back.
 */
const programs = Object.freeze({
	store: ChangeSet.empty(Exact).insert(Ledger, []),
	restate: ChangeSet.empty(Exact).put(Ledger, []),
	ledger,
	offset: query(Exact).rule((r) => {
		const { id, count, total } = v(Ledger, "l")
		return r
			.match(Ledger, { id, count, total })
			.find({ id, count: Num.add(count, r.param("by", exactInteger)), total })
	}),
	double: ChangeSet.empty(Exact).insert(
		Doubled,
		query(Exact).rule((r) => {
			const { id, count, total } = v(Ledger, "l")
			return r
				.match(Ledger, { id, count, total })
				.find({ id, count: Num.add(count, count), total: Num.add(total, total) })
		})
	),
	judged: ChangeSet.empty(Exact).insert(Doubled, []),
	doubled: query(Exact).rule((r) => {
		const { id, count, total } = v(Doubled, "d")
		return r.match(Doubled, { id, count, total }).find({ id, count, total })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const exactInstall = Object.freeze({ label: "exact", programs })

/** Exact installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const exactTemplate = fixtureTemplate(import.meta, Exact, exactInstall)

/** The magnitude of a drawn value: within a signed 64-bit count, past it, or of hundreds of digits. */
type Magnitude =
	| "a value within a signed 64-bit count"
	| "a value past a signed 64-bit count"
	| "a value of hundreds of digits"

/** 10^n. */
const tenTo = (n: number): bigint => 10n ** BigInt(n)

/** A drawn integer: a count of units, or of cents, signed, of each magnitude. */
interface Drawn {
	readonly magnitude: Magnitude
	readonly value: bigint
}

const drawnGen: Gen<Drawn> = weighted<Drawn>([
	[
		2,
		(s) => ({
			magnitude: "a value within a signed 64-bit count",
			value: s.draw(bigint(-int8Max, int8Max))
		})
	],
	[
		2,
		(s) => ({
			magnitude: "a value past a signed 64-bit count",
			value: s.draw(element([1n, -1n])) * s.draw(bigint(int8Max + 1n, tenTo(60)))
		})
	],
	[
		1,
		(s) => {
			const digits = s.draw(int(100, 2000))
			return {
				magnitude: "a value of hundreds of digits",
				value: s.draw(element([1n, -1n])) * s.draw(bigint(tenTo(digits - 1), tenTo(digits) - 1n))
			}
		}
	]
])

/** A ledger row as drawn: its id, its count and its total's cents, each of its magnitude. */
export interface Row {
	readonly id: number
	readonly count: Drawn
	readonly cents: Drawn
}

/** A case: its rows, each its own id, and the ids a put restates, each with a new count and total. */
interface Ledgers {
	readonly rows: ReadonlyArray<Row>
	readonly restated: ReadonlyArray<Row>
	readonly by: bigint
}

export const ledgersGen: Gen<Ledgers> = (s) => {
	const counts = s.draw(array(drawnGen, { min: 1, max: 6 }))
	const rows = Arr.map(counts, (count, id): Row => ({ id, count, cents: s.draw(drawnGen) }))
	const restated = Arr.flatMap(rows, (row): ReadonlyArray<Row> =>
		s.draw(element([true, false]))
			? [{ id: row.id, count: s.draw(drawnGen), cents: s.draw(drawnGen) }]
			: []
	)
	return { rows, restated, by: s.draw(drawnGen).value }
}

/** A row's fact: its id, its count, and its total, the Money of its cents. */
export const factOf = (row: Row) => ({
	id: row.id,
	count: row.count.value,
	total: Money.exact(row.cents.value)
})

/** A row as a read delivers it, compared by value: its id, its count's digits and its total's cents. */
export const shownRow = (row: {
	readonly id: number
	readonly count: bigint
	readonly total: Money
}): readonly [number, string, string] => [
	row.id,
	row.count.toString(),
	row.total.minorUnits.toString()
]

/** A ledger row as a read delivers it: shownRow's, and its generated twice's digits. */
export const shownLedger = (row: {
	readonly id: number
	readonly count: bigint
	readonly total: Money
	readonly twice: bigint
}): readonly [number, string, string, string] => [...shownRow(row), row.twice.toString()]

/** The texts PostgreSQL stores of a row: its count's digits and its total at money's two fraction digits. */
export const storedTexts = (row: Row): readonly [string, string, string] => [
	String(row.id),
	row.count.value.toString(),
	Money.exact(row.cents.value).toString()
]

/** Each direct writer's value a column's CHECK refuses: its column, its text and what it breaks. */
export const refusedWrites = [
	{ column: "count", text: "1.5", breaks: "a fraction" },
	{ column: "count", text: "5.0", breaks: "another scale" },
	{ column: "count", text: "NaN", breaks: "NaN" },
	{ column: "count", text: "Infinity", breaks: "an infinity" },
	{ column: "count", text: "-Infinity", breaks: "an infinity" },
	{ column: "total", text: "1.5", breaks: "another scale" },
	{ column: "total", text: "1.505", breaks: "a fraction" },
	{ column: "total", text: "NaN", breaks: "NaN" },
	{ column: "total", text: "Infinity", breaks: "an infinity" }
] as const satisfies ReadonlyArray<{
	readonly column: "count" | "total"
	readonly text: string
	readonly breaks: "a fraction" | "another scale" | "NaN" | "an infinity"
}>

export type Feature =
	| Magnitude
	| "a negative value"
	| "a put restating a row"
	| "a query's exact sums written into the fields"
	| "a generated exact sum"
	| "a count refused by its row check"
	| "a parameter of the exact integer"
	| `${(typeof refusedWrites)[number]["column"]} refusing ${(typeof refusedWrites)[number]["breaks"]}`

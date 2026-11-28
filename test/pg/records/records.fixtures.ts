/**
 * What the property of records.test.ts reads: the levels a case installs, a base of Item (test/unit/program/
 * records.fixtures.ts) and over it a level listing the records of each of the case's queries, its facts of Item, and
 * the space of its queries.
 */
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { recordsBuilder } from "#compiler/program/records.ts"
import { Bit, Numeric, Money, Vector } from "#compiler/public/fields.ts"
import { natural } from "#compiler/public/fields.ts"
import { recordsQuery, schema } from "#compiler/public/schema.ts"
import type { QueryValue } from "#compiler/query/build/query.ts"
import {
	cellQueryOver,
	heldPairs,
	Item,
	type ItemColumn,
	itemColumns,
	literals,
	type RecordsCell,
	Tier
} from "#test/support/unit/program/records.fixtures.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** Each column a case's queries store, and each kind of head literal they write again. */
export type RecordsFeature =
	| `stores ${(typeof itemColumns)[number]}`
	| `writes a ${string} literal`
	| `stores a union's ${string} literals`
	| "stores a computed numeric"

/**
 * Every column is stored in every case, its first query finding them all, and so is a computed numeric, its fourth
 * query's.
 */
export const recordsSituations: ReadonlyArray<RecordsFeature> = [
	...Arr.map(itemColumns, (column): RecordsFeature => `stores ${column}`),
	"stores a computed numeric"
]

/**
 * A case: four queries over Item: the first one rule finding every column beside a drawn head literal, the second one
 * rule of a drawn nonempty subset of the columns beside a drawn literal or none, the third a union of two rules of one
 * heading, a drawn subset each, writing a drawn pair of literals a field holds exactly (two texts or both booleans), the
 * fourth one rule of a drawn subset beside `dec + dec`, a computed numeric.
 */
export const recordsCaseGen: Gen<Arr.NonEmptyReadonlyArray<RecordsCell>> = (source) => {
	const subset = (): Arr.NonEmptyReadonlyArray<ItemColumn> => {
		const first = source.draw(element(itemColumns))
		return [first, ...Arr.filter(itemColumns, (c) => c !== first && source.pick(0, 1) === 1)]
	}
	return [
		{ kind: "find", columns: itemColumns, literal: source.draw(element(literals)) },
		{ kind: "find", columns: subset(), literal: source.draw(element([undefined, ...literals])) },
		{ kind: "union", columns: subset(), literals: source.draw(element(heldPairs)) },
		{ kind: "sum", columns: subset() }
	]
}

/**
 * The levels of a case under the base's declared name `name`: the base `name` of Tier and Item, each query over it, the
 * records of each under the stem `F<i>` owned by a natural `at`, the level `<name>_1` over the base listing them, and
 * its full world, a role writing every relation, in its login.
 */
export const levelsOf = (name: string, cells: Arr.NonEmptyReadonlyArray<RecordsCell>) => {
	const Base = schema(name, [Tier, Item], [])
	const queries: ReadonlyArray<QueryValue> = Arr.map(cells, (cell) => cellQueryOver(Base, cell))
	const found = Arr.map(queries, (q, i) =>
		recordsBuilder(`F${i}`, q, { at: natural }, ["at"] as const, [])
	)
	const Den = schema.extend(
		[Base],
		`${name}_1`,
		Arr.flatMap(found, (f) => f.relations),
		Arr.flatMap(found, (f) => f.rules)
	)
	const world = fullWorld(Den, {}, [])
	return {
		Den,
		queries,
		found,
		reads: Arr.map(found, (f) => recordsQuery(Den, f)),
		app: world.app,
		server: world.server
	}
}

/**
 * Item's facts: a row of each type's edges (the least smallint, the greatest integer, the least bigint, a negative
 * numeric at its scale, NaN, a large double, negative money, a leap day, a set of two handles, wide spans, a vector of
 * three components, bytes holding 0 and 255, a pair its arm's check holds), and a row of zeros, empties and the other
 * edges (Infinity, the first and last days, the empty set, the empty name and bytes, the greatest natural, a flag).
 * Neither states `stamped` or `search`: the database stamps the one and PostgreSQL generates the other.
 */
export const itemFacts: ReadonlyArray<Readonly<Record<string, unknown>>> = [
	{
		id: 1,
		small: -32768,
		int: 2147483647,
		big: -9223372036854775808n,
		dec: Numeric.of("-12345678.90"),
		whole: 123456789012n,
		num: Numeric.of("NaN"),
		real: 1.5,
		dbl: 1e300,
		cash: Money.of(-1234n),
		flag: true,
		day: "2024-02-29",
		account: "0d5c1f9e-2b9d-4a7e-8f00-1234567890ab",
		cents: 500n,
		word: "abc",
		name: "bc",
		tier: "High",
		lowMid: "Mid",
		tiers: Bit.of(Tier, ["Low", "High"]),
		during: { start: 1, end: 5 },
		window: { start: -5n, end: 10n },
		days: { start: "2024-01-01", end: "2024-03-01" },
		vec: Vector.make(new Float32Array([0.5, -1, 2]), 3),
		blob: new Uint8Array([0, 255, 7]),
		count: 0n,
		cell: { tag: "Mid", greatest: "b", least: "a" }
	},
	{
		id: 2,
		small: 0,
		int: 0,
		big: 0n,
		dec: Numeric.of("0"),
		whole: 0n,
		num: Numeric.of("Infinity"),
		real: 0,
		dbl: 5e-324,
		cash: Money.of(0n),
		flag: false,
		day: "0001-01-01",
		account: "ffffffff-ffff-4fff-bfff-ffffffffffff",
		cents: 0n,
		word: "z",
		name: "",
		tier: "Low",
		lowMid: "Low",
		tiers: Bit.of(Tier, []),
		during: { start: -2147483648, end: 2147483647 },
		window: { start: 0n, end: 1n },
		days: { start: "9999-12-30", end: "9999-12-31" },
		vec: Vector.make(new Float32Array([0, 0, 1]), 3),
		blob: new Uint8Array([]),
		count: 9223372036854775807n,
		cell: { tag: "Low", value: false }
	}
]

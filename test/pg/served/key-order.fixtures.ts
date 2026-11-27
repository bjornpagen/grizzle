/** What the property of key-order.test.ts reads: its declarations, written in a case's key orders, its program, its
 * space and its expectation. */

import { defined } from "@bjornpagen/testing/assert"
import { constant, type Gen, int, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { inOrder, orderOf } from "#test/support/key-order.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The declarations: `Single`, a heading of QTI's single value's names (b, base, f, field, m, n, t, u, w), each an
 * integer here, so a value at another attribute is no type error but a wrong answer; `pack`, an SQL function of a value
 * for each of Single's fields, which builds one row of Single, `ROW(b, base, f, field, m, n, t, u, w)::Single`;
 * `spread`, an SQL function of the same arguments returning rows of Single, the one row of its own positional call of
 * pack, `SELECT (pack(b, base, f, field, m, n, t, u, w)).*`; and `mix(iy, x, y)`, a PL/pgSQL function that reads its
 * parameters by number, `$2 * 100 + $3 * 10 + $1`. Every body is written once, positionally in its names' code point
 * order, as the README tells a body to be; every record a declaration or a call writes is written in the case's order of
 * its keys. The program `run` matches each Seed, then the rows of spread at its values, and finds each row's fields
 * beside mix at its iy, x and y.
 */

const singleFields = {
	b: pg.integer,
	base: pg.integer,
	f: pg.integer,
	field: pg.integer,
	m: pg.integer,
	n: pg.integer,
	t: pg.integer,
	u: pg.integer,
	w: pg.integer
} as const
const singleNames = ["b", "base", "f", "field", "m", "n", "t", "u", "w"] as const
type SingleName = (typeof singleNames)[number]

const mixNames = ["iy", "x", "y"] as const
type MixName = (typeof mixNames)[number]

/** The order each record of a case writes its keys in: the heading's, each function's arguments' and each call's. */
export interface KeyOrders {
	readonly single: ReadonlyArray<SingleName>
	readonly packArgs: ReadonlyArray<SingleName>
	readonly spreadArgs: ReadonlyArray<SingleName>
	readonly mixArgs: ReadonlyArray<MixName>
	readonly spreadCall: ReadonlyArray<SingleName>
	readonly mixCall: ReadonlyArray<MixName>
}

/** Every record written in its names' order, as sort-keys writes it. */
const sortedOrders: KeyOrders = {
	single: singleNames,
	packArgs: singleNames,
	spreadArgs: singleNames,
	mixArgs: mixNames,
	spreadCall: singleNames,
	mixCall: mixNames
}

/** The declarations with every record written in `o`'s orders, under the schema name `name`, and the program. */
const declaredIn = (o: KeyOrders) => (name: string) => {
	const Single = rows(inOrder(singleFields, o.single))
	const pack = fn("pack", {
		calls: [],
		args: inOrder(singleFields, o.packArgs),
		returns: row(Single),
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT ROW(b, base, f, field, m, n, t, u, w)::${Single}`
	})
	const spread = fn("spread", {
		calls: [pack],
		args: inOrder(singleFields, o.spreadArgs),
		returns: Single,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: fn.body`SELECT (pack(b, base, f, field, m, n, t, u, w)).*`
	})
	const mix = fn("mix", {
		calls: [],
		args: inOrder({ iy: pg.integer, x: pg.integer, y: pg.integer }, o.mixArgs),
		returns: pg.integer,
		volatility: "immutable",
		nullInput: "called",
		language: "plpgsql",
		body: fn.body`\nBEGIN\n  RETURN $2 * 100 + $3 * 10 + $1;\nEND\n`
	})
	const Seed = relation(
		"Seed",
		{
			b: pg.integer,
			base: pg.integer,
			f: pg.integer,
			field: pg.integer,
			id: pg.integer,
			iy: pg.integer,
			m: pg.integer,
			n: pg.integer,
			t: pg.integer,
			u: pg.integer,
			w: pg.integer,
			x: pg.integer,
			y: pg.integer
		},
		["id"]
	)
	const s = schema(name, [Seed, pack, spread, mix], [])
	const run = query(s).rule((r) => {
		const seed = v(Seed, "seed")
		const { b, base, f, field, iy, m, n, t, u, w, x, y } = seed
		const spreadRows = Fn.rows(spread, inOrder({ b, base, f, field, m, n, t, u, w }, o.spreadCall))
		const p = v(spreadRows, "spread")
		return r
			.match(Seed, seed)
			.match(spreadRows, p)
			.find({
				b: p.b,
				base: p.base,
				f: p.f,
				field: p.field,
				id: seed.id,
				m: p.m,
				mixed: Fn.call(mix, inOrder({ iy, x, y }, o.mixCall)),
				n: p.n,
				t: p.t,
				u: p.u,
				w: p.w
			})
	})
	return { schema: s, programs: { run } }
}

/** The schema and login of a case's declarations, under `name`, as the installation builds them. */
export const installationOf = (o: KeyOrders) => (name: string) => {
	const declared = declaredIn(o)(name)
	return {
		schema: declared.schema,
		logins: [fullWorld(declared.schema, declared.programs, []).server]
	}
}

/** The served world and the programs of a case's declarations over its installation's declared name. */
export const servedOf = (o: KeyOrders, declared: string) => {
	const built = declaredIn(o)(declared)
	return { world: fullWorld(built.schema, built.programs, []), programs: built.programs }
}

/** A stored seed: its key, a value for each of Single's fields and mix's iy, x and y. */
interface Seed {
	readonly id: number
	readonly single: { readonly [N in SingleName]: number }
	readonly mix: { readonly [N in MixName]: number }
}

export interface KeyOrderCase {
	readonly orders: KeyOrders
	readonly seeds: ReadonlyArray<Seed>
}

/**
 * A seed of key `id`: Single's fields `base` apart from each other by place, so a value at another field's attribute is
 * another value, and iy, x and y three digits, distinct, so a parameter passed for another is another answer.
 */
const seedGen =
	(id: number): Gen<Seed> =>
	(source) => {
		const base = source.draw(int(0, 1000)) * 16
		const digits = source.draw(shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], { min: 3, max: 3 }))
		const digit = (at: number) => defined(digits[at], "a drawn digit")
		return {
			id,
			single: {
				b: base,
				base: base + 1,
				f: base + 2,
				field: base + 3,
				m: base + 4,
				n: base + 5,
				t: base + 6,
				u: base + 7,
				w: base + 8
			},
			mix: { iy: digit(0), x: digit(1), y: digit(2) }
		}
	}

const ordersGen: Gen<KeyOrders> = oneOf<KeyOrders>([
	constant(sortedOrders),
	(source) => ({
		single: source.draw(orderOf(singleNames)),
		packArgs: source.draw(orderOf(singleNames)),
		spreadArgs: source.draw(orderOf(singleNames)),
		mixArgs: source.draw(orderOf(mixNames)),
		spreadCall: source.draw(orderOf(singleNames)),
		mixCall: source.draw(orderOf(mixNames))
	})
])

export const caseGen: Gen<KeyOrderCase> = (source) => {
	const count = source.draw(int(1, 3))
	return {
		orders: source.draw(ordersGen),
		seeds: Array.from({ length: count }, (_, id) => source.draw(seedGen(id)))
	}
}

/** A case's facts, as the installation loads them. */
export const factsOf = (c: KeyOrderCase) => ({
	Seed: Arr.map(c.seeds, (s) => ({ id: s.id, ...s.single, ...s.mix }))
})

/** One row as both sides read it, one text: its id, each of Single's fields and mixed, by name. */
const columns = ["id", ...singleNames, "mixed"] as const

export const rowText = (row: unknown): string =>
	isRecord(row)
		? Arr.join(
				Arr.map(columns, (key) => String(row[key])),
				"|"
			)
		: "not a row"

/** Each seed's one row, by name: each of Single's fields its own value, and mixed its x, y and iy as digits. */
export const expectedTexts = (c: KeyOrderCase): ReadonlyArray<string> =>
	Arr.map(c.seeds, (s) =>
		rowText({ id: s.id, ...s.single, mixed: s.mix.x * 100 + s.mix.y * 10 + s.mix.iy })
	)

/** Whether `order` writes its record's keys out of their names' order. */
const unsorted = (order: ReadonlyArray<string>, sorted: ReadonlyArray<string>): boolean =>
	Arr.some(order, (name, i) => name !== sorted[i])

export type KeyOrderFeature =
	| "a heading written out of its names' order"
	| "an argument list written out of its names' order"
	| "a call's arguments written out of their names' order"
	| "every record written in its names' order"
	| "several seeds"

/** The features a case reaches. */
export const featuresOf = (c: KeyOrderCase): ReadonlyArray<KeyOrderFeature> => {
	const o = c.orders
	const heading = unsorted(o.single, singleNames)
	const args =
		unsorted(o.packArgs, singleNames) ||
		unsorted(o.spreadArgs, singleNames) ||
		unsorted(o.mixArgs, mixNames)
	const calls = unsorted(o.spreadCall, singleNames) || unsorted(o.mixCall, mixNames)
	return [
		...(heading ? (["a heading written out of its names' order"] as const) : []),
		...(args ? (["an argument list written out of its names' order"] as const) : []),
		...(calls ? (["a call's arguments written out of their names' order"] as const) : []),
		...(heading || args || calls ? [] : (["every record written in its names' order"] as const)),
		...(c.seeds.length > 1 ? (["several seeds"] as const) : [])
	]
}

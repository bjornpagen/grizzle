/** What the properties of relation.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, map, shuffled } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { HeadingField } from "#compiler/scalar/values/identity.ts"
import { succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { codecOf } from "#test/support/unit/codec/support.ts"

const uuidA = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

/** The cases' scalar types, each the registry's. */
const uuid = scalarOf({ kind: "uuid" }, {})

/** The scale of numeric(5,2), the field m's type, at which its values are constructed. */
const scale52 = 2

const numeric52 = scalarOf({ kind: "numeric", precision: 5, scale: scale52 }, {})

const range4 = scalarOf(
	{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
	{}
)

const uuidB = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12"

/**
 * The fields of a case: each one's name, type, the SQL type its raw spelling is read at, and `group`, the expressions
 * PostgreSQL tells its values apart by, one value each: its equality's, and for a float its binary image beside it
 * (float8send, float4send), since its equality holds -0 and +0 equal and they are two values (scalar/values/float.ts).
 */
export const fields: ReadonlyArray<{
	readonly name: string
	readonly type: ScalarType
	readonly sql: string
	readonly group: string
}> = [
	{ name: "n", type: anyNumeric, sql: "numeric", group: "r.n" },
	{ name: "m", type: numeric52, sql: "numeric(5,2)", group: "r.m" },
	{
		name: "d",
		type: plainType("float8"),
		sql: "float8",
		group: "r.d, pg_catalog.float8send(r.d)"
	},
	{
		name: "f",
		type: plainType("float4"),
		sql: "float8",
		group: "(r.f)::real, pg_catalog.float4send((r.f)::real)"
	},
	{ name: "u", type: uuid, sql: "uuid", group: "r.u" },
	{ name: "t", type: wildcardText, sql: "text", group: "r.t COLLATE pg_catalog.pg_c_utf8" },
	{ name: "s", type: range4, sql: "int4range", group: "r.s" },
	{ name: "b", type: plainType("bool"), sql: "bool", group: "r.b" }
]

const factGen = (source: Source) => ({
	n: source.draw(
		map(element(["1", "1.0", "1.00", "-0", "0.000", "NaN", "Infinity", "2", "1e1", "10"]), (s) =>
			Decimal.of(s)
		)
	),
	m: source.draw(
		map(element([-123n, 0n, 1n, 120n, 123n, 124n, 99_999n]), (hundredths) =>
			succeeded(
				Decimal.fromParts(hundredths < 0n, hundredths < 0n ? -hundredths : hundredths, scale52),
				"a numeric(5,2) value"
			)
		)
	),
	d: source.draw(element([0, -0, Number.NaN, 1, 0.1, Number.POSITIVE_INFINITY])),
	f: source.draw(
		map(element([1, 1 + 2 ** -24, 1 + 2 ** -23, 0.1, 0, -0, Number.NaN]), Math.fround)
	),
	u: source.draw(element([uuidA, Str.toUpperCase(uuidA), uuidB])),
	t: source.draw(element(["é", "é", "E", "e", "𝔘", ""])),
	s: source.draw(
		element([
			{ start: 1, end: 2 },
			{ start: 1, end: 3 }
		])
	),
	b: source.draw(boolean)
})

/** The heading's field names, any one of which a case varies. */
const fieldNames: ReadonlyArray<string> = Arr.map(fields, (f) => f.name)

/** A field of a generated fact, by a name of the heading. */
export const fieldOf = (fact: Readonly<Record<string, unknown>>, name: string): unknown =>
	fact[name]

/**
 * The facts of one case, up to `maxLength`: they vary one or two fields over their small domains and hold the rest, so
 * equal facts spelled differently meet often.
 */
export const collidingFactsGen = (maxLength: number) => (source: Source) => {
	const base = factGen(source)
	const vary = source.draw(shuffled(fieldNames, { min: 1, max: 2 }))
	const variants = source.draw(array(factGen, { min: 1, max: maxLength }))
	return Arr.map(variants, (v) => ({
		...base,
		...Rec.fromEntries(Arr.map(vary, (name) => [name, fieldOf(v, name)]))
	}))
}

export const rawSpelling = (name: string, value: unknown): string => {
	if (value instanceof Decimal) {
		return value.toString()
	}
	if (typeof value === "number") {
		return Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : String(value)
	}
	if (typeof value === "object" && value !== null && "start" in value && "end" in value) {
		return `[${String(value.start)},${String(value.end)})`
	}
	if (name !== "b" && typeof value === "string") {
		return value
	}
	return String(value)
}

export const heading: ReadonlyArray<HeadingField> = Arr.map(fields, (f) => ({
	name: f.name,
	spec: codecOf(f.type, emptyCodebook).spec
}))

/** The arrays in the lowering's select-list form: a text column's collated, numeric(5,2)'s typmod cast back. */
export const input = `(SELECT ${Arr.join(
	Arr.map(fields, (f, i) => {
		const element =
			f.name === "t" ? `$${i + 1}::text[] COLLATE pg_catalog.pg_c_utf8` : `$${i + 1}::${f.sql}[]`
		const unnest = `pg_catalog.unnest(${element})`
		return `${f.name === "m" ? `${unnest}::${f.sql}` : unnest} AS ${f.name}`
	}),
	", "
)}) AS r`

export const columns = Arr.join(
	Arr.map(fields, (f) => f.group),
	", "
)

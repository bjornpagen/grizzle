import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, map, shuffled } from "@grizzle/testing/gen"
import { exact, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { positionalColumns, type RelationSpec } from "#compiler/codec/recordset.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	type FactIdentity,
	factIdentity,
	type HeadingField
} from "#compiler/scalar/values/identity.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { codecOf } from "#test/unit/codec/support.ts"

/**
 * Relation inputs against PostgreSQL.
 *
 * - Host fact equality is PostgreSQL's: on explored batches of generated cases over small domains that collide (numeric
 *   display scale, NaN, signed zero, numeric(5,2) rounding, the float8-to-real cast, uuid case, composed and decomposed
 *   text), the host's fact identity partitions every case exactly as GROUP BY, which is DISTINCT's equality, does.
 * - The arrays encoder deduplicates, so PostgreSQL receives a set, which it reads back from the arrays in the
 *   select-list form the lowering prints (sql/print.ts printArrays).
 *
 * The heading of the equality cases, and how each field is spelled raw to PostgreSQL: the host value's own spelling,
 * not the codec's normalized text, so PostgreSQL decides the equality independently.
 */
const uuidA = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
/** The cases' scalar types, each the registry's. */
const uuid = scalarOf({ kind: "uuid" }, {})
const numeric52 = scalarOf({ kind: "numeric", precision: 5, scale: 2 }, {})
const range4 = scalarOf(
	{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
	{}
)
const uuidB = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12"
const fields: ReadonlyArray<{
	readonly name: string
	readonly type: ScalarType
	readonly sql: string
	readonly group: string
}> = [
	{ name: "n", type: anyNumeric, sql: "numeric", group: "r.n" },
	{ name: "m", type: numeric52, sql: "numeric(5,2)", group: "r.m" },
	{ name: "d", type: plainType("float8"), sql: "float8", group: "r.d" },
	{ name: "f", type: plainType("float4"), sql: "float8", group: "(r.f)::real" },
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
		map(element(["1.231", "1.232", "1.23", "1.235", "1.24", "-1.235", "0", "0.001"]), (s) =>
			Decimal.of(s)
		)
	),
	d: source.draw(element([0, -0, Number.NaN, 1, 0.1, Number.POSITIVE_INFINITY])),
	f: source.draw(element([1, 1 + 2 ** -24, 1 + 2 ** -23, 0.1, Math.fround(0.1), -0, Number.NaN])),
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
const fieldOf = (fact: Readonly<Record<string, unknown>>, name: string): unknown => fact[name]

/**
 * The facts of one case, up to `maxLength`: they vary one or two fields over their small domains and hold the rest, so
 * equal facts spelled differently meet often.
 */
const collidingFactsGen = (maxLength: number) => (source: Source) => {
	const base = factGen(source)
	const vary = source.draw(shuffled(fieldNames, { min: 1, max: 2 }))
	const variants = source.draw(array(factGen, { min: 1, max: maxLength }))
	return Arr.map(variants, (v) => ({
		...base,
		...Rec.fromEntries(Arr.map(vary, (name) => [name, fieldOf(v, name)]))
	}))
}

const rawSpelling = (name: string, value: unknown): string => {
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

layer(Substrate.layer)("relation inputs against PostgreSQL", (it) => {
	it.effect("partitions generated cases exactly as PostgreSQL's DISTINCT equality does", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				const heading: ReadonlyArray<HeadingField> = Arr.map(fields, (f) => ({
					name: f.name,
					spec: codecOf(f.type, emptyCodebook).spec
				}))
				return yield* explore(
					{
						oracle: { kind: "unstated" },
						suite: "codec/relation/partition",
						/**
						 * A batch of cases is one jsonb_to_recordset round trip, so a failing batch shrinks to its failing
						 * case: the rotating 20 batches of up to 100 cases and the floor's 5.
						 */
						draw: drawn(array(collidingFactsGen(8), { min: 1, max: 100 })),
						literal: Formatter.format,
						coverage: required<"equal facts spelled apart">(["equal facts spelled apart"], {
							cases: 20,
							sense: notesOnly
						}),
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(cases, c) =>
						Effect.gen(function* () {
							const payload = Arr.flatMap(cases, (facts, k) =>
								Arr.map(facts, (fact, ord) => ({
									k: String(k),
									ord: String(ord),
									...Rec.fromEntries(
										Arr.map(fields, (f) => [f.name, rawSpelling(f.name, fieldOf(fact, f.name))])
									)
								}))
							)
							const rows = yield* db.values(
								`SELECT r.k::text, string_agg(r.ord::text, ',' ORDER BY r.ord) FROM jsonb_to_recordset($1::text::jsonb) AS r(k int4, ord int4, ${Arr.join(
									Arr.map(fields, (f) => `${f.name} ${f.sql}`),
									", "
								)}) GROUP BY r.k, ${Arr.join(
									Arr.map(fields, (f) => f.group),
									", "
								)}`,
								[jsonText(payload)]
							)
							const pg = new Map<number, Array<string>>()
							for (const [k, group] of rows) {
								const key = Number(k)
								pg.set(key, [...(pg.get(key) ?? []), String(group)])
							}
							for (const [k, facts] of cases.entries()) {
								const groups = new TupleMap<FactIdentity, Array<number>>()
								for (const [ord, fact] of facts.entries()) {
									const { identity } = succeeded(factIdentity(heading, fact))
									groups.set(identity, [...(groups.get(identity) ?? []), ord])
								}
								if (groups.size < facts.length) {
									c.note("equal facts spelled apart")
								}
								const host = Arr.sort(
									Arr.map([...groups.values()], (g) =>
										Arr.join(
											Arr.map(g, (ord) => String(ord)),
											","
										)
									),
									compareCodePoints
								)
								const native = Arr.sort(
									defined(pg.get(k), `the groups of case ${k}`),
									compareCodePoints
								)
								assert.deepEqual(
									ordered(exact)(host, native),
									Option.none(),
									`case ${k}: the host groups ${Arr.join(host, " ")}, PostgreSQL ${Arr.join(native, " ")}`
								)
							}
						})
				)
			})
		)
	)

	it.effect(
		"sends PostgreSQL a set: the encoder's arrays hold rows distinct under PostgreSQL's equality",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					const spec: RelationSpec = {
						relation: "Case",
						columns: positionalColumns(fields),
						slot: { kind: "none" },
						codes: emptyCodebook
					}
					const encode = arraysEncoder(spec)
					/** The arrays in the lowering's select-list form: a text column's collated, numeric(5,2)'s typmod cast back. */
					const input = `(SELECT ${Arr.join(
						Arr.map(fields, (f, i) => {
							const element =
								f.name === "t"
									? `$${i + 1}::text[] COLLATE pg_catalog.pg_c_utf8`
									: `$${i + 1}::${f.sql}[]`
							const unnest = `pg_catalog.unnest(${element})`
							return `${f.name === "m" ? `${unnest}::${f.sql}` : unnest} AS ${f.name}`
						}),
						", "
					)}) AS r`
					const columns = Arr.join(
						Arr.map(fields, (f) => f.group),
						", "
					)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "codec/relation/set",
							/** Facts that collide, so the encoder has equal facts spelled apart to deduplicate. */
							draw: drawn(collidingFactsGen(40)),
							literal: Formatter.format,
							coverage: required<"deduplicated">(["deduplicated"], {
								cases: 200,
								sense: notesOnly
							}),
							kept: [],
							/** One round trip a case, as before. */
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(facts, c) =>
							Effect.gen(function* () {
								const { arrays, count } = succeeded(encode(facts))
								if (count < facts.length) {
									c.note("deduplicated")
								}
								const [row] = yield* db.values(
									`SELECT count(*)::text, (SELECT count(*) FROM (SELECT DISTINCT ${columns} FROM ${input}) AS q)::text FROM ${input}`,
									arrays
								)
								assert.deepEqual(row, [String(count), String(count)])
							})
					)
				})
			)
	)
})

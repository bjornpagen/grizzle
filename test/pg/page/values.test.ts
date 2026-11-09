import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, pipe, Record as Rec, String as Str } from "effect"
import { openDbContext } from "#adapter/db/open.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { pageTemplate, rowOf, sortedResult, traverse, untyped } from "#test/pg/page/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import {
	float8,
	int8,
	numeric,
	resolveStored,
	type SpelledValue,
	scalarOfSpec,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import { inputText } from "#test/support/oracle/runner.ts"
import { dbReader } from "#test/support/runtime-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	byAmount,
	byBig,
	byLabel,
	byX,
	byXDesc,
	Measure,
	Measures
} from "#test/unit/page/fixtures.ts"

import { regex } from "arkregex"
import type { Uuid } from "#compiler/public/fields.ts"
import { caseHang } from "#test/support/limits.ts"
import { loginLayer } from "#test/support/worlds.ts"
/**
 * Boundary values through the page runtime, drawn from the scalar edge dictionaries.
 *
 * The Measures fixture (test/unit/page/fixtures.ts) orders one relation by a double precision, an exact numeric, a
 * bigint and a text, each the leading key of one ordered query (ascending and descending for the double, the id
 * completing every order). Each case stores drawn facts, every field drawn from its type's value classes with their
 * edge classes and every spelling (test/support/oracle/gen/domain.ts valueClasses): -0 beside 0, NaN, the infinities, a
 * subnormal and the largest finite double; numeric NaN (the fixture's numeric(161, 40) holds no infinity, which only an
 * unbounded numeric does), more digits than a binary64 holds and the smallest scale; the bigint extremes and 2^53 + 1,
 * which a binary64 cannot hold, either sign; the empty text, text beyond the BMP, U+10FFFF and combining marks. Through
 * Db, for a drawn query at a drawn page size per direction:
 *
 * - the forward and backward pages concatenate to D exactly, with exact flags: every boundary value round-trips, the
 *   seek comparing it in PostgreSQL's own order (NaN greatest, -0 = 0, code points);
 * - every edge's cursor carries its node's comparator values exactly: PostgreSQL reads each boundary text back, as its
 *   column's type, equal to the value stored in the edge's row.
 */

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const text: ScalarType = scalarOfSpec({ carrier: "text" })

/** The ordered fields, each with its type in the generator's domain, and every compared field's SQL type. */
const fields = { x: float8, amount: numeric, big: int8, label: text } as const
type Field = keyof typeof fields
const sqlTypes = {
	id: "uuid",
	x: "double precision",
	amount: "numeric",
	big: "bigint",
	label: "text"
} as const
type Compared = keyof typeof sqlTypes
const isCompared = (field: string): field is Compared => Rec.has<string, string>(sqlTypes, field)

const queries = {
	"x asc": byX,
	"x desc": byXDesc,
	"amount desc, id asc": byAmount,
	"big asc, id desc": byBig,
	"label asc": byLabel
} as const
type Ordered = keyof typeof queries
const orderedNames: Arr.NonEmptyReadonlyArray<Ordered> = [
	"x asc",
	"x desc",
	"amount desc, id asc",
	"big asc, id desc",
	"label asc"
]

/** The bigints a binary64 cannot hold, among the int8 classes. */
const unsafeBigints = [2n ** 53n + 1n, -(2n ** 53n + 1n)] as const

interface FactSketch {
	readonly x: ValueSketch
	readonly amount: ValueSketch
	readonly big: ValueSketch
	readonly label: ValueSketch
}

const valueSketchGen: Gen<ValueSketch> = (source) => ({
	cls: source.draw(int(0, 63)),
	sp: source.draw(int(0, 7))
})

const factSketchGen: Gen<FactSketch> = (source) => ({
	x: source.draw(valueSketchGen),
	amount: source.draw(valueSketchGen),
	big: source.draw(valueSketchGen),
	label: source.draw(valueSketchGen)
})

interface ValuesCase {
	readonly facts: ReadonlyArray<FactSketch>
	readonly query: Ordered
	readonly forward: number
	readonly backward: number
}

const valuesCaseGen: Gen<ValuesCase> = (source) => ({
	facts: source.draw(array(factSketchGen, { min: 1, max: 12 })),
	query: source.draw(element(orderedNames)),
	forward: source.draw(int(1, 4)),
	backward: source.draw(int(1, 4))
})

/** Every class, edges included, in every spelling, so a sketch reaches each: a double's -0 is 0's twin spelling. */
const storedOf = (field: Field, sketch: ValueSketch): SpelledValue =>
	resolveStored(fields[field], sketch, true)

/** A fact's stored values, each in its drawn spelling. */
type StoredFact = Readonly<Record<Field, SpelledValue>>

const storedFact = (f: FactSketch): StoredFact => ({
	x: storedOf("x", f.x),
	amount: storedOf("amount", f.amount),
	big: storedOf("big", f.big),
	label: storedOf("label", f.label)
})

/**
 * A stored value's text as its column's input function reads it: its canonical text, or its twin spelling. No field is
 * a closed id or a set, so no codes spell any.
 */
const storedText = (field: Field, v: SpelledValue): string =>
	v.spelling.kind === "twin" ? v.spelling.text : inputText(v.literal, fields[field], emptyCodebook)

/** A fact's stored texts, as its column's input function reads them. */
const factTexts = (f: StoredFact): Readonly<Record<Field, string>> => ({
	x: storedText("x", f.x),
	amount: storedText("amount", f.amount),
	big: storedText("big", f.big),
	label: storedText("label", f.label)
})

type ValuesFeature =
	| `query ${Ordered}`
	| "float -0"
	| "float NaN"
	| "float infinity"
	| "float subnormal"
	| "numeric NaN"
	| "numeric of more than 17 digits"
	| "bigint extreme"
	| "bigint beyond 2^53"
	| "empty text"
	| "text beyond the BMP"
	| "a tie on the leading key"

/**
 * What a case's stored values reach: each field's stored text, an amount's digits those of its value, whatever zeros
 * its spelling pads it with.
 *
 * A code point beyond the BMP is two UTF-16 units.
 */
const reached = (stored: ReadonlyArray<StoredFact>): ReadonlyArray<ValuesFeature> => {
	const out = new Set<ValuesFeature>()
	for (const v of stored) {
		const f = { ...factTexts(v), amount: inputText(v.amount.literal, fields.amount, emptyCodebook) }
		if (f.x === "-0") {
			out.add("float -0")
		}
		if (f.x === "NaN") {
			out.add("float NaN")
		}
		if (f.x === "Infinity" || f.x === "-Infinity") {
			out.add("float infinity")
		}
		if (f.x === "5e-324") {
			out.add("float subnormal")
		}
		if (f.amount === "NaN") {
			out.add("numeric NaN")
		}
		if (Str.replace(regex("[-.]", "g"), "")(f.amount).length > 17) {
			out.add("numeric of more than 17 digits")
		}
		if (f.big === (2n ** 63n - 1n).toString() || f.big === (-(2n ** 63n)).toString()) {
			out.add("bigint extreme")
		}
		if (Arr.some(unsafeBigints, (b) => b.toString() === f.big)) {
			out.add("bigint beyond 2^53")
		}
		if (f.label === "") {
			out.add("empty text")
		}
		if (Arr.some(Arr.fromIterable(f.label), (ch) => ch.length > 1)) {
			out.add("text beyond the BMP")
		}
	}
	return [...out]
}

layer(Substrate.layer)("boundary values through the page runtime", (it) => {
	it.effect(
		"pages drawn edge values of every ordered type to D exactly, each cursor carrying its node's values as PostgreSQL reads them back",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const opened = yield* installed(
						Measures,
						{},
						{ label: "real", extensions: [], programs: {} }
					)
					const names = namesOf(opened.installed)
					const table = names.table(Measure)
					const column = (field: Field | "id"): string => names.column(Measure, field)
					return yield* Effect.gen(function* () {
						const { ctx: dbCtx } = yield* openDbContext(opened.server.roles.app, {})
						const pages = untyped(dbReader(dbCtx))
						return yield* explore(
							{
								oracle: { kind: "unstated" },
								/** The pages at the drawn sizes concatenate to D, with exact flags. */
								suite: "pg/page/values",
								draw: drawn(valuesCaseGen),
								literal: Formatter.format,
								kept: [],
								runs: 60,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang,
								coverage: required<ValuesFeature>(
									[
										...Arr.map(orderedNames, (q): ValuesFeature => `query ${q}`),
										"float -0",
										"float NaN",
										"float infinity",
										"float subnormal",
										"numeric NaN",
										"numeric of more than 17 digits",
										"bigint extreme",
										"bigint beyond 2^53",
										"empty text",
										"text beyond the BMP",
										"a tie on the leading key"
									],
									{ cases: 60, sense: notesOnly }
								)
							},
							(c, notes) =>
								Effect.gen(function* () {
									/** The case's facts replace the last case's whole (substrate/replace.ts). */
									const stored = Arr.map(c.facts, storedFact)
									const texts = Arr.map(stored, factTexts)
									yield* replaceRows(
										s.admin,
										installationGroup(names),
										Arr.map(texts, (f, n) => ({
											sql: `INSERT INTO ${table} (${column("id")}, ${column("x")}, ${column("amount")}, ${column("big")}, ${column("label")}) VALUES ($1::uuid, $2::double precision, $3::numeric, $4::bigint, $5::text)`,
											params: [id(n + 1), f.x, f.amount, f.big, f.label]
										}))
									)
									const q = queries[c.query]
									const compiled = pageTemplate(dbCtx, q)
									const runtime = compiled.runtime
									const rows = yield* Effect.flatMap(
										pages.execute(q, {}),
										(result) => result.collect
									)
									assert.equal(rows.length, c.facts.length)
									const full = sortedResult(compiled, rows)
									for (const [direction, size] of [
										["forward", c.forward],
										["backward", c.backward]
									] as const) {
										const walked = yield* traverse(pages, q, {}, direction, size, { kind: "end" })
										assert.deepEqual(walked.nodes, full, `${direction} ${size}`)
										const ordered =
											direction === "forward" ? walked.pages : Arr.reverse(walked.pages)
										let offset = 0
										for (const [k, page] of ordered.entries()) {
											assert.equal(
												page.pageInfo.hasPreviousPage,
												offset > 0,
												`${direction} ${size} page ${k} previous`
											)
											offset += page.edges.length
											assert.equal(
												page.pageInfo.hasNextPage,
												offset < full.length,
												`${direction} ${size} page ${k} next`
											)
										}
									}
									/**
									 * Each cursor's boundary texts, read back by PostgreSQL as their columns' types, equal the
									 * edge's stored values.
									 */
									const page = yield* pages.page(q, {}, { first: c.facts.length })
									for (const edge of page.edges) {
										const decoded = succeeded(runtime.codec.decode(edge.cursor))
										const node = rowOf(edge.node)
										for (const [i, comparator] of runtime.page.comparators.entries()) {
											const field = comparator.field
											assert.ok(isCompared(field), `a comparator of ${field}, no field of Measure`)
											const [answer] = yield* s.admin.queryValues(
												`SELECT ($1::${sqlTypes[field]} = m.${column(field)})::text FROM ${table} AS m WHERE m.${column("id")} = $2::uuid`,
												[defined(decoded.texts[i]), String(node["id"])]
											)
											assert.deepEqual(
												answer,
												["true"],
												`${c.query}: ${field} of ${String(node["id"])} as its cursor carries it`
											)
										}
									}
									notes.note(`query ${c.query}`)
									notes.noteAll(reached(stored))
									/** A tie on the leading key, by the column type's own equality. */
									const leading = defined(runtime.page.comparators[0]).field
									if (!isCompared(leading)) {
										return assert.fail(`a comparator of ${leading}, no field of Measure`)
									}
									const [tied] = yield* s.admin.queryValues(
										`SELECT (count(*) > count(DISTINCT m.${column(leading)}))::text FROM ${table} AS m`,
										[]
									)
									if (tied?.[0] === "true") {
										notes.note("a tie on the leading key")
									}
								})
						)
					}).pipe(
						Effect.scoped,
						(body) =>
							Effect.flatMap(Layer.build(loginLayer(opened.installed, opened.server)), (context) =>
								Effect.provideContext(body, context)
							),
						Effect.scoped
					)
				}).pipe(Effect.scoped)
			)
	)
})

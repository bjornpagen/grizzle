/**
 * A parameter's value of a pattern, delivered against PostgreSQL 19.
 *
 * Notes declares Code, ^[a-z]{1,4}$, on a stored field and no field of Slug, ^[a-z]{1,8}$. A relation parameter's
 * fields of each, and a scalar parameter of each, are delivered as they are bound by the members of the full world's
 * served workload that read them: each is cast to its own pattern domain, which the installation creates for every
 * pattern a served parameter names, whether or not a stored field declares it, so PostgreSQL checks the value as it
 * binds it and nothing on the host does. The oracle restates each pattern over the drawn text: a case some value of
 * which is outside its pattern is refused by PostgreSQL, ReadFailure ParamRejected at stage execute, which a call
 * answers as an `input` CallError; every other case delivers exactly the values it bound.
 *
 * Plants (~/.cache/grizzle-release/LIVE-PARSE/plants): param-domain-uncast (a parameter's placeholder cast to its base,
 * so no domain checks it).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, element, type Gen, oneOf, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A pattern no stored field of the schema declares, so the installation holds no domain of it. */
const Slug = str.regex("^[a-z]{1,8}$", "u")
/** A pattern a stored field declares, so the installation holds its domain. */
const Code = str.regex("^[a-z]{1,4}$", "u")

/** A schema whose one stored relation declares Code and no field of Slug. */
const Note = relation("Note", { id: uuid, code: Code }, ["id"])
const Notes = schema("Notes", { Note }, [])

/** The slugs and codes a relation parameter carries, each with its position, delivered as they are. */
const echoed = query(Notes).rule((r) => {
	const rows = r.relation("rows", { slug: Slug, code: Code, n: pg.integer })
	const { slug, code, n } = v(rows, "row")
	return r.match(rows, { slug, code, n }).find({ slug, code, n })
})

/** The slug and the code two scalar parameters carry, delivered beside each note's id. */
const tagged = query(Notes).rule((r) => {
	const { id } = v(Note, "note")
	return r
		.match(Note, { id })
		.find({ id, slug: r.param("slug", Slug), code: r.param("code", Code) })
})

/** A text inside a pattern about half the time: lowercase letters, or printable ASCII of any length up to twelve. */
const textGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 1, max: 6 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 12 })
])

/** Whether a text is one to `most` ASCII lowercase letters, the language of ^[a-z]{1,most}$. */
const lowercaseOf =
	(most: number) =>
	(text: string): boolean =>
		text.length >= 1 &&
		text.length <= most &&
		Arr.every(
			upTo(text.length, (i) => i),
			(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
		)
const isSlug = lowercaseOf(8)
const isCode = lowercaseOf(4)

/** One row a case binds: a slug, of no stored field's pattern, and a code, of a stored field's. */
interface Bound {
	readonly slug: string
	readonly code: string
}

interface Case {
	readonly via: "relation" | "scalar"
	readonly rows: ReadonlyArray<Bound>
}

const boundGen: Gen<Bound> = (source) => ({
	slug: source.draw(textGen),
	code: source.draw(textGen)
})

const caseGen: Gen<Case> = (source) => ({
	via: source.draw(element(["relation", "scalar"] as const)),
	rows: source.draw(array(boundGen, { min: 1, max: 4 }))
})

type Feature =
	| `${Case["via"]} delivered`
	| `${Case["via"]} refused at bind`
	| `${Case["via"]} refused for a slug alone`

const noteId = "00000000-0000-4000-8000-000000000001"

layer(Substrate.layer)(
	"a parameter's pattern no stored field declares, against PostgreSQL 19",
	(it) => {
		it.effect(
			"a parameter of any pattern is delivered as it is bound, its values checked at bind",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(
							Notes,
							{ Note: [{ id: noteId, code: "abc" }] },
							{ label: "real", extensions: [], programs: { echoed, tagged } }
						)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									suite: "parameters/pattern",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "each pattern restated over the bound text, and the rows delivered as they were bound"
									},
									kept: [],
									runs: 60,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 16,
									coverage: required<Feature>(
										[
											"relation delivered",
											"relation refused at bind",
											"relation refused for a slug alone",
											"scalar delivered",
											"scalar refused at bind",
											"scalar refused for a slug alone"
										],
										{ cases: 60, sense: notesOnly }
									),
									caseHang
								},
								(k, c) =>
									Effect.gen(function* () {
										const rows = k.via === "relation" ? k.rows : k.rows.slice(0, 1)
										const inside = Arr.every(rows, (b) => isSlug(b.slug) && isCode(b.code))
										const slugAlone = Arr.every(rows, (b) => isCode(b.code)) && !inside
										/** The rows the case delivers, as the oracle states them, or its failure. */
										const read: Result.Result<
											ReadonlyArray<Readonly<Record<string, unknown>>>,
											CallError
										> = k.via === "relation"
											? yield* Effect.result(
													rowsOf(
														db.workload.echoed.once({
															params: {
																rows: Arr.map(rows, (b, n) => ({ slug: b.slug, code: b.code, n }))
															},
															facts: {}
														})
													)
												)
											: yield* Effect.result(
													rowsOf(
														db.workload.tagged.once({
															params: {
																slug: Arr.headNonEmpty(nonEmpty(rows, "a bound row")).slug,
																code: Arr.headNonEmpty(nonEmpty(rows, "a bound row")).code
															},
															facts: {}
														})
													)
												)
										if (!inside) {
											if (Result.isSuccess(read)) {
												return assert.fail("a value outside its pattern is refused")
											}
											const failure = read.failure
											if (failure.kind !== "input") {
												return assert.fail(`refused at bind, not by ${failure.kind}`)
											}
											c.note(`${k.via} refused at bind`)
											if (slugAlone) {
												c.note(`${k.via} refused for a slug alone`)
											}
											return
										}
										if (Result.isFailure(read)) {
											return assert.fail(
												`values inside their patterns are delivered: ${read.failure.kind}`
											)
										}
										const delivered: ReadonlyArray<Readonly<Record<string, unknown>>> =
											k.via === "relation"
												? Arr.map(rows, (b, n) => bareRecord({ slug: b.slug, code: b.code, n }))
												: Arr.map(rows, (b) =>
														bareRecord({ id: noteId, slug: b.slug, code: b.code })
													)
										unorderedEqual(read.success, delivered, "the values as they were bound")
										c.note(`${k.via} delivered`)
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	}
)

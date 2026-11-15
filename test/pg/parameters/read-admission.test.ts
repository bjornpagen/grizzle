/**
 * A read's parameters admitted whatever its logic reads of them, against PostgreSQL 19.
 *
 * A read is one statement, and every placeholder of a caller parameter is cast to its checked type, so PostgreSQL
 * checks a value as it binds the statement. A parameter the read's logic leaves unread (a rule whose filter is the
 * constant false, r.or(), reads nothing of what it matches) has no placeholder of its logic's, so the statement holds an
 * admission of it (lower/conservative/admission.ts withAdmission), an entry of its WITH no query reads, which PostgreSQL
 * parses and so binds. Without it such a read answered a value outside its pattern, which the same read without the
 * filter refuses.
 *
 * The box: Unread stores two items of Code, ^[a-z]{1,4}$. Its four reads are a scalar parameter `p` of Code matched
 * against an item's code, or a relation parameter `named` of an item and a code of Code matched as its own rows, each
 * filtered by nothing or by the constant false. Each case draws the read and the code, inside Code or outside it. The
 * oracle restates the pattern and the reads: a code outside Code is refused at bind as ParamRejected, an `input`
 * CallError naming the parameter (`p`, or `named.code`), whatever the filter; otherwise the read under the constant
 * false answers no row, and the plain read the stored items of that code, or the one row `named` holds.
 *
 * Features: each parameter outside Code refused under each filter, and each read answered with a code inside Code.
 *
 * @plant test/plants/pg/parameters/read-admission-dropped.patch A read's statement holds no admission, so a parameter
 * its logic leaves unread is bound unchecked and a code outside Code under the constant false answers no row.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, unorderedEqual } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A pattern a stored field declares. */
const Code = str.regex("^[a-z]{1,4}$", "u")
const Item = relation("Item", { id: uuid, code: Code }, ["id"])
const Unread = schema("Unread", [Item], [])

/** What filters a read's rule: nothing, or the constant false, which leaves its parameter unread. */
type Filter = "none" | "false"

/** The items whose code is the scalar parameter `p`, filtered by `filter`. */
const scalarRead = (filter: Filter) =>
	query(Unread).rule((r) => {
		const { id } = v(Item, "item")
		const matched = r.match(Item, { id, code: r.param("p", Code) })
		return (filter === "false" ? matched.where(r.or()) : matched).find({ id })
	})

/** The rows of the relation parameter `named`, an item and a code, filtered by `filter`. */
const relationRead = (filter: Filter) =>
	query(Unread).rule((r) => {
		const named = r.relation("named", { item: Item.fields.id, code: Code })
		const { item, code } = v(named, "named")
		const matched = r.match(named, { item, code })
		return (filter === "false" ? matched.where(r.or()) : matched).find({ item, code })
	})

const stored = [
	{ id: "00000000-0000-4000-8000-000000000001", code: "abc" },
	{ id: "00000000-0000-4000-8000-000000000002", code: "de" }
] as const

/** A text inside Code about half the time, a stored item's code among them: lowercase letters, or printable ASCII. */
const textGen: Gen<string> = oneOf([
	element(["abc", "de"]),
	string(codePoint(0x61, 0x7a), { min: 1, max: 4 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 })
])

/** Whether a text is one to four ASCII lowercase letters, the language of Code. */
const isCode = (text: string): boolean =>
	text.length >= 1 &&
	text.length <= 4 &&
	Arr.every(
		upTo(text.length, (i) => i),
		(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
	)

interface Case {
	readonly via: "scalar" | "relation"
	readonly filter: Filter
	readonly code: string
}

const caseGen: Gen<Case> = (source) => ({
	via: source.draw(element(["scalar", "relation"] as const)),
	filter: source.draw(element(["none", "false"] as const)),
	code: source.draw(textGen)
})

/** GREENTRUNK's repro: a code outside Code in `named`, whose read's constant false filter leaves it unread. */
const unreadOutside: Case = { via: "relation", filter: "false", code: "TOOLONG" }

type Feature =
	| `${Case["via"]} outside Code refused, filtered by ${Filter}`
	| `${Case["via"]} answered, filtered by ${Filter}`

layer(Substrate.layer)(
	"a read's parameters admitted whatever its logic reads, against PostgreSQL 19",
	(it) => {
		it.effect(
			"a parameter outside its type is refused at bind, though a constant false filter leaves it unread",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(
							Unread,
							{ Item: [...stored] },
							{
								label: "unread",
								programs: {
									scalarNone: scalarRead("none"),
									scalarFalse: scalarRead("false"),
									relationNone: relationRead("none"),
									relationFalse: relationRead("false")
								}
							}
						)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									suite: "parameters/read-admission",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "Code restated over the bound text, then the read's rows restated over the stored items"
									},
									kept: [
										{
											note: "a code outside Code that a constant false filter leaves unread",
											sketch: unreadOutside,
											draws: "",
											reaches: ["relation outside Code refused, filtered by false"]
										}
									],
									runs: 40,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 8,
									coverage: required<Feature>(
										[
											"scalar outside Code refused, filtered by none",
											"scalar outside Code refused, filtered by false",
											"relation outside Code refused, filtered by none",
											"relation outside Code refused, filtered by false",
											"scalar answered, filtered by none",
											"scalar answered, filtered by false",
											"relation answered, filtered by none",
											"relation answered, filtered by false"
										],
										{ cases: 40, sense: notesOnly }
									),
									caseHang
								},
								(k, c) =>
									Effect.gen(function* () {
										const named = [{ item: stored[0].id, code: k.code }]
										const read: Result.Result<
											ReadonlyArray<Readonly<Record<string, unknown>>>,
											CallError
										> = k.via === "scalar"
											? yield* Effect.result(
													rowsOf(
														(k.filter === "false"
															? db.workload.scalarFalse
															: db.workload.scalarNone
														).once({ params: { p: k.code }, facts: {} })
													)
												)
											: yield* Effect.result(
													rowsOf(
														(k.filter === "false"
															? db.workload.relationFalse
															: db.workload.relationNone
														).once({ params: { named }, facts: {} })
													)
												)
										const param = k.via === "scalar" ? "p" : "named.code"
										if (!isCode(k.code)) {
											if (Result.isSuccess(read)) {
												return assert.fail(
													`a code outside Code is refused at bind, not answered ${Formatter.format(read.success)}`
												)
											}
											assert.equal(read.failure.kind, "input", "refused as the call's input")
											assert.ok(
												Str.includes(`parameter ${param} `)(read.failure.message),
												`the refusal names ${param}: ${read.failure.message}`
											)
											c.note(`${k.via} outside Code refused, filtered by ${k.filter}`)
											return
										}
										if (Result.isFailure(read)) {
											return assert.fail(
												`a code inside Code is answered: ${Formatter.format(read.failure)}`
											)
										}
										const expected: ReadonlyArray<Readonly<Record<string, unknown>>> =
											k.filter === "false"
												? []
												: k.via === "scalar"
													? Arr.map(
															Arr.filter(stored, (item) => item.code === k.code),
															(item) => bareRecord({ id: item.id })
														)
													: Arr.map(named, (row) => bareRecord(row))
										unorderedEqual(read.success, expected, "the read's rows")
										c.note(`${k.via} answered, filtered by ${k.filter}`)
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	}
)

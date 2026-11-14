/**
 * Compute.utf16Length on PostgreSQL 19, against JavaScript's String.length: the UTF-16 code units Effect Schema's
 * isMinLength, isMaxLength and isLengthBetween count of a string.
 *
 * 1. The SQL a check holds (lower/conservative/expr/ops.ts utf16Units), over a batch of drawn texts in one round trip:
 *    PostgreSQL's value of it, and the host evaluator's over each text, are String.length of the text. A text's code
 *    points are drawn under per-case weights over the widths UTF-8 and UTF-16 write them in: ASCII, two bytes, three
 *    bytes up to U+FFFF itself, and the supplementary planes, two UTF-16 units each, the first plane and every one past
 *    it.
 * 2. Admission and storage: a relation Texts whose generated field `units` is utf16Length of its text, under a guard of
 *    the text's bytes, Compute.when(Compute.within(Compute.octetLength(text), low, high), () =>
 *    Compute.utf16Length(text), -1), or alone, the text's own type of no bound, a pattern's or a byte bound of its own,
 *    each bound drawn small or about regexTextMaxBytes. The schema compiles exactly when the bytes the guard or the
 *    text's own type bounds the text to are within regexTextMaxBytes; a refusal is PartialOperation of the bounded
 *    precondition whose remedy is the guard of the text's bytes at regexTextMaxBytes; and, installed, every drawn text of
 *    the text's own type is inserted, and its field holds String.length where the guard holds it and -1 elsewhere.
 *
 * Oracle: JavaScript's String.length, a second implementation of UTF-16's code units, and for admission the bounds the
 * case states.
 *
 * Plants: compute-utf16-char-length (the SQL counts code points alone), compute-utf16-plane-one (its supplementary class
 * stops at U+1FFFF), compute-utf16-host-code-points (the host counts code points), compute-utf16-unbounded (the bounded
 * precondition is proved of a text no bound holds).
 *
 * Features: each width of code point, U+FFFF, a code point past the first supplementary plane and the empty text in
 * the SQL's batches; each bound of the text's type and each side of the guard, a refusal, and an admission at the limit.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	element,
	type Gen,
	int,
	type Weight,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { regexTextMaxBytes } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { codePoints, codePointsText } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { evaluateTable } from "#compiler/scalar/compute/evaluate.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { textCell } from "#test/pg/compute/support.ts"
import { probe } from "#test/pg/physical/checks.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { ownedInput } from "#test/support/policy.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/unit/compute/support.ts"

/** The widths a code point is written in: one UTF-8 byte, two, three (one UTF-16 unit each), or four, two units. */
type Width = "ascii" | "two bytes" | "three bytes" | "supplementary"

const widths: Arr.NonEmptyReadonlyArray<Width> = [
	"ascii",
	"two bytes",
	"three bytes",
	"supplementary"
]

/** The last code point of the Basic Multilingual Plane, the widest one UTF-16 writes as one unit. */
const lastSingleUnit = 0xffff

/** The first and last code points of the supplementary planes, and the edges of the first of them. */
const supplementaryEdges: Arr.NonEmptyReadonlyArray<number> = [
	0x1_00_00, 0x1_ff_ff, 0x2_00_00, 0x10_ff_ff
]

/** A code point of each width: no NUL, which no text holds, and no surrogate, which no scalar value is. */
const ofWidth: { readonly [W in Width]: Gen<number> } = {
	ascii: int(0x01, 0x7f),
	"two bytes": int(0x80, 0x7_ff),
	"three bytes": weighted([
		[6, int(0x8_00, 0xd7_ff)],
		[3, int(0xe0_00, lastSingleUnit)],
		[1, element([lastSingleUnit])]
	]),
	supplementary: weighted([
		[2, int(0x1_00_00, 0x1_ff_ff)],
		[4, int(0x2_00_00, 0x10_ff_ff)],
		[1, element(supplementaryEdges)]
	])
}

/** The weights a case draws for each width: one, three or nine, so each case leans its own way. */
const leanings: Arr.NonEmptyReadonlyArray<Weight> = [1, 3, 9]

/** Texts of up to `max` code points under weights the case draws for each width. */
const textsOf =
	(max: number): Gen<Gen<string>> =>
	(source) => {
		const point = weighted(
			Arr.map(widths, (w): Weighted<number> => [source.draw(element(leanings)), ofWidth[w]])
		)
		return (s) => codePointsText(s.draw(array(point, { min: 0, max })))
	}

type SqlFeature =
	| "an ASCII character"
	| "a character of two bytes"
	| "a character of three bytes"
	| "U+FFFF"
	| "a supplementary character"
	| "a character past the first supplementary plane"
	| "the empty text"

const sqlNotes = (texts: ReadonlyArray<string>): ReadonlyArray<SqlFeature> => {
	const points = Arr.flatMap(texts, codePoints)
	const some = (holds: (p: number) => boolean) => Arr.some(points, holds)
	return [
		...(some((p) => p < 0x80) ? (["an ASCII character"] as const) : []),
		...(some((p) => p >= 0x80 && p < 0x8_00) ? (["a character of two bytes"] as const) : []),
		...(some((p) => p >= 0x8_00 && p <= lastSingleUnit)
			? (["a character of three bytes"] as const)
			: []),
		...(some((p) => p === lastSingleUnit) ? (["U+FFFF"] as const) : []),
		...(some((p) => p > lastSingleUnit) ? (["a supplementary character"] as const) : []),
		...(some((p) => p > 0x1_ff_ff)
			? (["a character past the first supplementary plane"] as const)
			: []),
		...(Arr.some(texts, (t) => t === "") ? (["the empty text"] as const) : [])
	]
}

/** A text whose pattern bounds it within 64 code points, 256 bytes: the bounded operand the check's term reads. */
const textColumn: LeafBinding = { kind: "column", type: testPg.regex("^.{0,64}$", "su").scalar }

/** Compute.utf16Length of the variable v, as a Description states it. */
const unitsDesc: ExprDesc = {
	kind: "compute",
	fn: "utf16Length",
	args: [{ kind: "var", var: "v" }]
}

/** The host evaluator's value of the lowered term over a text, as a write admits it: an integer, which it holds as a bigint. */
const hostUnits = (term: Lowered, text: string): bigint => {
	const table = predicateTable(term.expr)
	const value = succeeded(
		evaluateTable(
			table.exprs,
			table.root,
			{ value: undefined, column: () => text, closed: () => undefined },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates utf16Length"
	)
	return typeof value === "bigint"
		? value
		: assert.fail(`the host's count is an integer, not ${Formatter.format(value)}`)
}

/** A batch of texts of up to 64 code points each, under one case's weights. */
const batch: Gen<ReadonlyArray<string>> = (source) =>
	source.draw(array(source.draw(textsOf(64)), { min: 1, max: 48 }))

/** The guard of the text's bytes over the count, or none. */
type Guard =
	| { readonly kind: "within"; readonly low: number; readonly high: number }
	| { readonly kind: "none" }

/** The text's own type: any text, a pattern of at most so many code points, or a byte bound of its own. */
type Source =
	| { readonly kind: "every" }
	| { readonly kind: "upTo"; readonly codePoints: number }
	| { readonly kind: "bytes"; readonly bytes: number }

interface Case {
	readonly source: Source
	readonly guard: Guard
	readonly texts: ReadonlyArray<string>
}

type BoundFeature =
	| "a count under no guard"
	| "refused, naming the bound"
	| "admitted at the limit"
	| "admitted by the guard's bound"
	| "admitted by the text's own bound"
	| "a text the guard holds, counted"
	| "a text the guard keeps out, stored as the other value"

/** A byte bound drawn small, or about regexTextMaxBytes, at it and either side, or at str.bytes's largest. */
const boundBytes: Gen<number> = weighted([
	[3, int(0, 48)],
	[
		2,
		element([
			regexTextMaxBytes.value - 1,
			regexTextMaxBytes.value,
			regexTextMaxBytes.value + 1,
			2 ** 31 - 1
		])
	]
])

const sourceGen: Gen<Source> = weighted<Source>([
	[2, () => ({ kind: "every" })],
	[1, (source) => ({ kind: "upTo", codePoints: source.draw(int(0, 12)) })],
	[2, (source) => ({ kind: "bytes", bytes: source.draw(boundBytes) })]
])

const guardGen: Gen<Guard> = weighted<Guard>([
	[
		4,
		(source) => {
			const high = source.draw(boundBytes)
			return { kind: "within", low: source.draw(int(0, Math.min(high, 40))), high }
		}
	],
	[1, () => ({ kind: "none" })]
])

const caseGen: Gen<Case> = (source) => ({
	source: source.draw(sourceGen),
	guard: source.draw(guardGen),
	texts: source.draw(array(source.draw(textsOf(14)), { min: 1, max: 12 }))
})

/** The bytes the text's own type bounds it to: four a code point for a pattern's, none for any text. */
const sourceBytes = (s: Source): number => {
	switch (s.kind) {
		case "every":
			return Number.POSITIVE_INFINITY
		case "upTo":
			return 4 * s.codePoints
		case "bytes":
			return s.bytes
	}
}

/** Whether a text is a value of the text's own type. */
const sourceHolds = (s: Source, text: string): boolean => {
	switch (s.kind) {
		case "every":
			return true
		case "upTo":
			return codePoints(text).length <= s.codePoints
		case "bytes":
			return utf8Length(text) <= s.bytes
	}
}

/** The byte counts a case's guard holds of: its interval, or every count where it has none. */
const interval = (g: Guard): readonly [number, number] =>
	g.kind === "within" ? [g.low, g.high] : [0, Number.POSITIVE_INFINITY]

/** The bytes the count's operand is bounded to: its own type's, or the guard's where that is tighter. */
const boundOf = (c: Case): number => Math.min(sourceBytes(c.source), interval(c.guard)[1])

/** The text's own field. */
const sourceField = (s: Source) => {
	const every = str.regex("^.*$", "su")
	switch (s.kind) {
		case "every":
			return every
		case "upTo":
			return regexField(`^.{0,${s.codePoints}}$`, ["su"])
		case "bytes":
			return str.bytes(s.bytes, every)
	}
}

/** A case's schema: Texts, whose generated field counts its text's UTF-16 units under the case's guard, -1 elsewhere. */
const schemaOf = (c: Case) => {
	const Texts = relation.generated(
		"Texts",
		{ id: uuid, n: pg.integer, text: sourceField(c.source) },
		["id"],
		(r) => ({
			units: generatedField(
				pg.integer,
				c.guard.kind === "within"
					? Compute.when(
							Compute.within(Compute.octetLength(r.text), c.guard.low, c.guard.high),
							() => Compute.utf16Length(r.text),
							-1
						)
					: Compute.utf16Length(r.text),
				[]
			)
		})
	)
	return { Texts, value: schema("Utf16Length", [Texts], []) }
}

/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

layer(Substrate.layer)("Compute.utf16Length on PostgreSQL 19", (it) => {
	it.effect("PostgreSQL's and the host's count of a text's UTF-16 units are String.length", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const db = yield* s.session(ownerSession())
				const term = succeeded(
					lowerWith("check", unitsDesc, { v: textColumn }, false, baseParams),
					"Compute.utf16Length lowers in a check over a bounded text"
				).root
				const sql = `SELECT (${renderSql(term.expr, plainRender)})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`
				return yield* explore(
					{
						suite: "pg/compute/utf16-length-sql",
						oracle: { kind: "second-implementation", name: "JavaScript's String.length" },
						draw: drawn(batch),
						literal: Formatter.format,
						coverage: required<SqlFeature>(
							[
								"an ASCII character",
								"a character of two bytes",
								"a character of three bytes",
								"U+FFFF",
								"a supplementary character",
								"a character past the first supplementary plane",
								"the empty text"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(texts: ReadonlyArray<string>, k) =>
						Effect.gen(function* () {
							for (const feature of sqlNotes(texts)) {
								k.note(feature)
							}
							const rows = yield* db.values(sql, [
								jsonText(Arr.map(texts, (v, ord) => ({ ord, v })))
							])
							yield* agree<ReadonlyArray<bigint>>(
								[
									["String.length", Arr.map(texts, (text) => BigInt(text.length))],
									["PostgreSQL", Arr.map(rows, (row) => BigInt(textCell(row, 0)))],
									["the host", Arr.map(texts, (text) => hostUnits(term, text))]
								],
								ordered(exact)
							)
						})
				)
			})
		)
	)

	it.effect(
		"admits a count exactly over a text bounded within the regex engine's bytes, and stores String.length",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							suite: "pg/compute/utf16-length-bound",
							oracle: {
								kind: "specification",
								name: "the bounds the case states, and JavaScript's String.length"
							},
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<BoundFeature>(
								[
									"a count under no guard",
									"refused, naming the bound",
									"admitted at the limit",
									"admitted by the guard's bound",
									"admitted by the text's own bound",
									"a text the guard holds, counted",
									"a text the guard keeps out, stored as the other value"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.scoped(
								Effect.gen(function* () {
									if (c.guard.kind === "none") {
										k.note("a count under no guard")
									}
									const { Texts, value } = schemaOf(c)
									const schemaName = yield* substrate.schema({ create: false, label: "units" })
									const compiled = Result.flatMap(ownedInput(value), (owned) =>
										compileInstallation(owned, {
											...installOptions(owned, substrate.owner.role),
											levels: [identity.schema(parsedSchemaName(schemaName))]
										})
									)
									const bound = boundOf(c)
									if (bound > regexTextMaxBytes.value) {
										assert.ok(
											!compiled.ok,
											"a count over a text past the regex engine's bytes is refused"
										)
										const reason = compiled.error.reason
										assert.ok(reason._tag === "PartialOperation", `refused as ${reason._tag}`)
										assert.equal(reason.precondition, "bounded")
										assert.deepEqual(reason.guard.remedy, {
											kind: "octets",
											bytes: regexTextMaxBytes.value
										})
										k.note("refused, naming the bound")
										return
									}
									assert.ok(
										compiled.ok,
										`a count over a bounded text compiles: ${compiled.ok ? "" : compiled.error.message}`
									)
									if (bound === regexTextMaxBytes.value) {
										k.note("admitted at the limit")
									}
									k.note(
										sourceBytes(c.source) <= interval(c.guard)[1]
											? "admitted by the text's own bound"
											: "admitted by the guard's bound"
									)
									const installation = compiled.value
									const names = installationNamesOf(installation)
									const texts = Arr.filter(c.texts, (t) => sourceHolds(c.source, t))
									const pinned = yield* substrate.admin.pin
									const problems = yield* inInstallation(
										pinned,
										installationSql(installation, substrate.database),
										Effect.gen(function* () {
											const refused: Array<string> = []
											for (const [i, text] of texts.entries()) {
												const verdict = yield* probe(
													pinned,
													`INSERT INTO ${names.table(Texts)} (${names.column(Texts, "id")}, ${names.column(Texts, "n")}, ${names.column(Texts, "text")}) VALUES (gen_random_uuid(), $1, $2)`,
													[i, text]
												)
												if (verdict.kind === "refused") {
													refused.push(`${Formatter.format(text)}: ${verdict.code}`)
												}
											}
											const rows = yield* pinned.queryValues(
												`SELECT ${names.column(Texts, "text")}, ${names.column(Texts, "units")}::text FROM ${names.table(Texts)} ORDER BY ${names.column(Texts, "n")}`,
												[]
											)
											const [low, high] = interval(c.guard)
											const stored = Arr.flatMap(rows, (row) => {
												const [text, units] = Arr.map(row, String)
												const counted = text ?? ""
												const bytes = utf8Length(counted)
												const held = bytes >= low && bytes <= high
												k.note(
													held
														? "a text the guard holds, counted"
														: "a text the guard keeps out, stored as the other value"
												)
												const expected = held ? String(counted.length) : "-1"
												return units === expected
													? []
													: [
															`${Formatter.format(counted)} stored ${Formatter.format(units)}, not ${expected}`
														]
											})
											return [...refused, ...stored]
										})
									)
									assert.deepEqual(problems, [])
								})
							)
					)
				})
			)
	)
})

/** What the properties of utf16-length.test.ts read: its spaces, models and helpers. */

import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import {
	array,
	element,
	type Gen,
	int,
	type Weight,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter } from "effect"
import { regexTextMaxBytes } from "#compiler/core/errors.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { compiledExpr } from "#compiler/scalar/compute/evaluate.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
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

export type SqlFeature =
	| "an ASCII character"
	| "a character of two bytes"
	| "a character of three bytes"
	| "U+FFFF"
	| "a supplementary character"
	| "a character past the first supplementary plane"
	| "the empty text"

export const sqlNotes = (texts: ReadonlyArray<string>): ReadonlyArray<SqlFeature> => {
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

/**
 * The host evaluator's value of the lowered term over a text, as a write admits it: an integer's, a JavaScript integer,
 * as a bigint, the reading the other counts share.
 */
export const hostUnits = (term: Lowered, text: string): bigint => {
	const table = predicateTable(term.expr)
	const value = succeeded(
		compiledExpr(table)(
			{ value: undefined, column: () => text, closed: () => undefined },
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates utf16Length"
	)
	return typeof value === "number"
		? BigInt(value)
		: assert.fail(`the host's count is an integer, not ${Formatter.format(value)}`)
}

/** A batch of texts of up to 64 code points each, under one case's weights. */
export const batch: Gen<ReadonlyArray<string>> = (source) =>
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

export type BoundFeature =
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
	[2, element([regexTextMaxBytes - 1, regexTextMaxBytes, regexTextMaxBytes + 1, 2 ** 31 - 1])]
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

export const caseGen: Gen<Case> = (source) => ({
	source: source.draw(sourceGen),
	guard: source.draw(guardGen),
	texts: source.draw(array(source.draw(textsOf(14)), { min: 1, max: 12 }))
})

/** The bytes the text's own type bounds it to: four a code point for a pattern's, none for any text. */
export const sourceBytes = (s: Source): number => {
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
export const sourceHolds = (s: Source, text: string): boolean => {
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
export const interval = (g: Guard): readonly [number, number] =>
	g.kind === "within" ? [g.low, g.high] : [0, Number.POSITIVE_INFINITY]

/** The bytes the count's operand is bounded to: its own type's, or the guard's where that is tighter. */
export const boundOf = (c: Case): number => Math.min(sourceBytes(c.source), interval(c.guard)[1])

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
export const schemaOf = (c: Case) => {
	const Texts = relation.generated(
		"Texts",
		{ id: Id, n: pg.integer, text: sourceField(c.source) },
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
export const inInstallation = <A>(
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

export const term = succeeded(
	lowerWith("check", unitsDesc, { v: textColumn }, false, baseParams),
	"Compute.utf16Length lowers in a check over a bounded text"
).root

export const sql = `SELECT (${renderSql(term.expr, plainRender)})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, v text) ORDER BY r0.ord`

/**
 * DetailCodec on PostgreSQL 19: the DETAIL a law function composes with detailExpr is the text decodeDetail reads
 * back, for composite keys of any storable text, uuid and bigint. The awkward texts are kept cases; the rest explore
 * over every uuid suffix, the whole bigint range and storable text, and must reach both a text the host encodes as is
 * and one PostgreSQL escapes.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter, pipe, String as Str } from "effect"
import type { NamedDetailCodec } from "#compiler/ir/law.ts"
import { detailExpr } from "#compiler/laws/model/detail.ts"
import { param, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { encodeDetail, strictDetail } from "#test/support/detail.ts"
import { recordEntryOf } from "#test/support/oracle/pick.ts"
import { auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
import type { Uuid } from "#compiler/public/fields.ts"
import { caseHang } from "#test/support/limits.ts"
const codec: NamedDetailCodec = { relation: "Timesheet", keys: ["employee", "week", "note"] }

/** The parameter each key of the codec reads: the employee a uuid, the week a bigint and the note a text. */
const keyParams = {
	employee: param(1, types.uuid),
	week: param(2, types.bigint),
	note: param(3, types.text)
}

/**
 * The key texts PostgreSQL's DETAIL lists: the library's trusting decodeDetail, read strictly (test/support/detail.ts).
 */
const decoded = (text: string) => strictDetail(codec, text)

/**
 * One storable character, never NUL nor a lone surrogate: printable ASCII most often, then the control characters, the
 * rest of the Basic Multilingual Plane, and the astral planes.
 */
const storableCharacter: Gen<string> = weighted([
	[3, codePoint(0x20, 0x7e)],
	[1, codePoint(0x01, 0x1f)],
	[1, codePoint(0x7f, 0xd7ff)],
	[1, codePoint(0xe000, 0xffff)],
	[1, codePoint(0x1_0000, 0x10_ffff)]
])

const storable = string(storableCharacter, { min: 0, max: 10 })

const employeeOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/**
 * Whether a case's text is one the host encodes as PostgreSQL does, ASCII without escapes, or one PostgreSQL escapes.
 */
type DetailFeature = "plain ascii" | "escaped"

/** A key as a case draws it: the employee's uuid suffix, the week, and the note. */
type DetailKey = readonly [employee: number, week: bigint, note: string]

const detailKeyGen: Gen<DetailKey> = (source) =>
	[
		source.draw(int(0, 0xffff_ffff)),
		source.draw(bigint(-(2n ** 63n), 2n ** 63n - 1n)),
		source.draw(storable)
	] as const

/** An awkward note, stated: the employee and the week by its place among the stated notes. */
const stated = (
	at: number,
	note: string,
	reaches: DetailFeature
): Kept<DetailKey, DetailFeature> => ({
	note: `the note ${Formatter.format(note)}`,
	sketch: [at, BigInt(at) - 7n, note],
	draws: "",
	reaches: [reaches]
})

/** The awkward texts: quotes, backslashes, separators, controls, astral and non-ASCII letters, SQL quoting. */
const awkward: ReadonlyArray<Kept<DetailKey, DetailFeature>> = [
	stated(0, '"', "escaped"),
	stated(1, "\\", "escaped"),
	stated(2, ",", "plain ascii"),
	stated(3, "]", "plain ascii"),
	stated(4, "w[", "plain ascii"),
	stated(5, "\n\t\u0001", "escaped"),
	stated(6, "\u{1F600}", "escaped"),
	stated(7, "'", "plain ascii"),
	stated(8, "$$", "plain ascii"),
	stated(9, "é", "escaped")
]

layer(Substrate.layer)("DetailCodec on PostgreSQL 19", (it) => {
	it.effect(
		"the expression PostgreSQL evaluates decodes to the key texts, uuid, bigint and text alike",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { admin } = yield* Substrate
					const sql = `SELECT ${printExpr(
						detailExpr(codec, (key) => recordEntryOf(keyParams, key, "the codec's key parameters"))
					)}`
					assert.deepEqual(auditTextViolations(sql), [])
					/**
					 * The DETAIL of one key, decoded back to its texts; for ASCII without escapes the host encoding is the same
					 * text. Whether the text was plain.
					 */
					const roundTrip = (employee: string, week: bigint, note: string) =>
						Effect.gen(function* () {
							const rows = yield* admin.queryValues(sql, [employee, week.toString(), note])
							const text = rows[0]?.[0]
							if (typeof text !== "string") {
								throw new Error("a text DETAIL")
							}
							assert.deepEqual(decoded(text), [employee, week.toString(), note])
							const plain =
								regex("^[ -~]*$").test(note) &&
								!Str.includes('"')(note) &&
								!Str.includes("\\")(note)
							if (plain) {
								assert.equal(text, encodeDetail(codec, [employee, week.toString(), note]))
							}
							return plain
						})
					return yield* explore(
						{
							suite: "laws/detail-codec",
							draw: drawn(detailKeyGen),
							literal: Formatter.format,
							kept: awkward,
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							coverage: required<DetailFeature>(["plain ascii", "escaped"], {
								cases: 300,
								sense: notesOnly
							}),
							caseHang
						},
						([n, week, note], c) =>
							Effect.map(roundTrip(employeeOf(n), week, note), (plain) => {
								c.note(plain ? "plain ascii" : "escaped")
							})
					)
				})
			)
	)
})

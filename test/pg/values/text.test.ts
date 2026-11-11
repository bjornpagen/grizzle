/**
 * Text order against PostgreSQL 19: the host's order of text values (core/text.ts compareCodePoints) is PostgreSQL's
 * `ORDER BY ... COLLATE pg_catalog.pg_c_utf8`, and the host's equality of texts is that collation's DISTINCT.
 *
 * Each case is a batch of texts drawn from every plane but NUL and the surrogates, combining marks after letters, and
 * a dictionary of the scalars the order turns on (U+D7FF beside U+E000-U+FFFF, the astral plane's first and last),
 * sent in one recordset.
 *
 * - Order: PostgreSQL's positions of the batch under `ORDER BY v COLLATE pg_c_utf8, ord` are the host's under
 *   compareCodePoints, ties by position: the order is total, so the contract fixes every position.
 * - Equality: count(DISTINCT v COLLATE pg_c_utf8) is the number of distinct JavaScript strings of the batch.
 *
 * Oracle: PostgreSQL itself, the pg_c_utf8 collation's comparison.
 *
 * Plants: values-text-code-units (compareCodePoints compares UTF-16 code units, so an astral scalar sorts below
 * U+E000-U+FFFF).
 *
 * Features: "JavaScript's order differs", a batch whose UTF-16 code-unit order is not its code-point order, which the
 * plant needs to show.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { compareCodePoints } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/**
 * One user-perceived character: none, a scalar of any plane but NUL and the surrogates, or a letter with a combining
 * mark after it, so a character of two scalars meets one of a single scalar.
 */
const grapheme: Gen<string> = weighted([
	[1, constant("")],
	[3, oneOf([codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)])],
	[
		1,
		(source) =>
			`${source.draw(codePoint(0x61, 0x7a))}${source.draw(boolean) ? source.draw(codePoint(0x03_00, 0x03_6f)) : ""}`
	]
])

const scalar = oneOf([
	element(["a", "A", "z", "é", "é", "ß", "퟿", "", "￿", "\u{10000}", "\u{10ffff}"]),
	grapheme,
	codePoint(0x01, 0x7f),
	codePoint(0xe0_00, 0xff_ff),
	codePoint(0x1_00_00, 0x10_ff_ff)
])
const text = map(array(scalar, { min: 0, max: 5 }), Arr.join(""))

layer(Substrate.layer)("text agreement with PostgreSQL", (it) => {
	it.effect(
		"orders by code point exactly as ORDER BY ... COLLATE pg_catalog.pg_c_utf8 does",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "ORDER BY and count(DISTINCT) under COLLATE pg_catalog.pg_c_utf8"
							},
							suite: "pg/values/text/order",
							draw: drawn(array(text, { min: 1, max: 4000 })),
							literal: Formatter.format,
							coverage: required<"JavaScript's order differs">(["JavaScript's order differs"], {
								cases: 2,
								sense: notesOnly
							}),
							kept: [],
							runs: 2,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(sample, c) =>
							Effect.gen(function* () {
								const payload = jsonText(Arr.map(sample, (v, ord) => ({ ord, v })))
								const pg = yield* db.values(
									`SELECT c.ord::text FROM ${source} ORDER BY c.v COLLATE pg_catalog.pg_c_utf8, c.ord`,
									[payload]
								)
								const host = orderOf(sample, compareCodePoints)
								const pgOrder: ReadonlyArray<number> = Arr.map(pg, (r) => Number(r[0]))
								assert.deepEqual(pgOrder, host)
								const naive = orderOf(sample, (a, b) => (a < b ? -1 : a > b ? 1 : 0))
								if (Arr.some(naive, (ord, i) => ord !== host[i])) {
									c.note("JavaScript's order differs")
								}
								const distinct = yield* db.values(
									`SELECT count(DISTINCT c.v COLLATE pg_catalog.pg_c_utf8)::text FROM ${source}`,
									[payload]
								)
								assert.deepEqual(
									Arr.map(distinct, (r) => Number(r[0])),
									[new Set(sample).size]
								)
							})
					)
				})
			)
	)
})

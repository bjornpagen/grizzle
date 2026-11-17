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
 * Features: "JavaScript's order differs", a batch whose UTF-16 code-unit order is not its code-point order, which a
 * comparison by UTF-16 code unit orders wrong.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compareCodePoints } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { source, text } from "#test/pg/values/text.fixtures.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** Text agreement with PostgreSQL orders by code point exactly as ORDER BY ... COLLATE pg_catalog.pg_c_utf8 does. */
export const textAgreementWithPostgreSQLOrdersByCodePointExactlyAsORDERBYCOLLATEPgCatalogPgCUtf8Does =
	property.explore(array(text, { min: 1, max: 4000 }), {
		needs: { tx: Substrate.transaction },
		situations: ["JavaScript's order differs"] satisfies ReadonlyArray<
			Reached<"JavaScript's order differs">
		>,
		/** Its pre-conversion budget: runs 2, coverage cases 2 (text.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 2 },
		check:
			({ tx }, c: Case<"JavaScript's order differs">) =>
			(sample) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

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
				}),
		oracle: {
			kind: "postgresql",
			name: "ORDER BY and count(DISTINCT) under COLLATE pg_catalog.pg_c_utf8"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\t\t\treturn codePointRank(x) < codePointRank(y) ? -1 : 1",
				replacement: "\t\t\treturn x < y ? -1 : 1",
				why: "compareCodePoints compares UTF-16 code units, so an astral scalar sorts below U+E000-U+FFFF."
			}
		]
	})

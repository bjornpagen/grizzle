/**
 * Text order against PostgreSQL 19: the host's order of text values (grizzle-text text.ts compareCodePoints) is PostgreSQL's
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

import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { source, text } from "#test/pg/values/text.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/support/unit/values/support.ts"

/**
 * Text agreement with PostgreSQL orders by code point exactly as ORDER BY ... COLLATE pg_catalog.pg_c_utf8 does.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/values/text.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/values/text.test.ts` at its budget before, `{
 *   runs: 2, steered: 2 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the red's
 *   headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path in
 *   run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const textAgreementWithPostgreSQLOrdersByCodePointExactlyAsORDERBYCOLLATEPgCatalogPgCUtf8Does =
	property.explore(array(text, { min: 1, max: 4000 }), {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["JavaScript's order differs"] satisfies ReadonlyArray<
			Reached<"JavaScript's order differs">
		>,
		budget: { runs: 1, steered: 2 },
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
				file: "packages/text/src/text.ts",
				original: "\t\t\treturn codePointRank(x) < codePointRank(y) ? -1 : 1",
				replacement: "\t\t\treturn x < y ? -1 : 1",
				why: "compareCodePoints compares UTF-16 code units, so an astral scalar sorts below U+E000-U+FFFF."
			}
		]
	})

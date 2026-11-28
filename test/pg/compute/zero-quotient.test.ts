/**
 * Num.div of floats by zero on PostgreSQL 19 and the host alike: the infinity of the dividend's sign, NaN over a
 * zero or NaN dividend, whichever zero divides (scalar/compute/registry.ts Totality ieee), so equal operands give equal
 * quotients, as every scalar operation gives equal results of equal operands (check/merge.ts): a plan may read a
 * divisor from either of two equal fields, -0 and 0, and its quotient is one value.
 *
 * Over batches of dividends of double precision or real, the zeros, the infinities, NaN, the subnormals, the normals'
 * ends and drawn fractions among them, each divided by -0 and by 0: the rule's quotient, the host evaluator's
 * (scalar/compute/evaluate.ts) and PostgreSQL's of the lowered term (lower/conservative/expr/total.ts guardedForm), in
 * one round trip, are one value by identity, -0 apart from 0 and every NaN one.
 *
 * Oracle: the rule as a specification, its quotient a function of the dividend alone.
 *
 * Features: each class of dividend, and each carrier.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	batchGen,
	byZero,
	classOf,
	hostQuotient,
	identityOf,
	readFloat,
	rowsJson,
	rowsOf,
	quotientSql,
	type ZeroQuotientFeature
} from "#test/pg/compute/zero-quotient.fixtures.ts"
import { inInstallation, textCell } from "#test/support/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Num.div of floats on PostgreSQL 19 a quotient by either zero is one value, the host's and the rule's.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/zero-quotient.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/zero-quotient.test.ts` at its budget
 *   before, `{ runs: 12, steered: 12 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const numDivOfFloatsOnPostgreSQL19AQuotientByEitherZeroIsOneValueTheHostsAndTheRules =
	property.explore(batchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"a positive dividend",
			"a negative dividend",
			"a dividend of 0",
			"a dividend of -0",
			"an infinite dividend",
			"a NaN dividend",
			"a subnormal dividend",
			"a double's quotient",
			"a real's quotient"
		] satisfies ReadonlyArray<Reached<ZeroQuotientFeature>>,
		check:
			({ tx }, k: Case<ZeroQuotientFeature>) =>
			({ carrier, dividends }) =>
				Effect.gen(function* () {
					const { bare } = yield* tx
					k.note(carrier === "float8" ? "a double's quotient" : "a real's quotient")
					for (const x of dividends) {
						k.note(classOf(x, carrier))
					}
					const rows = rowsOf(dividends)
					const answered = yield* inInstallation(
						bare,
						[],
						bare.queryValues(quotientSql(carrier), [jsonText(rowsJson(rows))])
					)
					yield* agree<ReadonlyArray<string>>(
						[
							["the rule", Arr.map(rows, (row) => identityOf(byZero(row.x)))],
							["the host", Arr.map(rows, (row) => identityOf(hostQuotient(carrier, row)))],
							[
								"PostgreSQL",
								Arr.map(answered, (row) => identityOf(readFloat(textCell(row, 0), carrier)))
							]
						],
						ordered(exact)
					)
				}),
		oracle: {
			kind: "specification",
			name: "grizzle's quotient by zero, the infinity of the dividend's sign or NaN over a zero or NaN dividend, a function of the dividend alone"
		},
		budget: { runs: 1, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\t\t\t: a > 0\n",
				replacement: "\t\t\t: a > 0 !== Object.is(b, -0)\n",
				why: "The host's quotient by zero takes IEEE 754's sign, the XOR of the two operands', so 1 / -0 is -Infinity and 1 / 0 Infinity: equal operands give two quotients."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/total.ts",
				original: "\t\t\t\t\t[gt(x, zero), floatLit(Number.POSITIVE_INFINITY, carrier)],\n",
				replacement:
					'\t\t\t\t\t[and([gt(x, zero), ne(call("float8send", [y]), call("float8send", [zero]))]), floatLit(Number.NEGATIVE_INFINITY, carrier)],\n\t\t\t\t\t[gt(x, zero), floatLit(Number.POSITIVE_INFINITY, carrier)],\n',
				why: "PostgreSQL's quotient of a positive dividend by -0 takes IEEE 754's sign, -Infinity, where its quotient by 0 is Infinity: equal operands give two quotients."
			}
		]
	})

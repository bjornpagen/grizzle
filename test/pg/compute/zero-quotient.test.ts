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
import { inInstallation, textCell } from "#test/pg/compute/support.ts"
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
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Num.div of floats on PostgreSQL 19 a quotient by either zero is one value, the host's and the rule's. */
export const numDivOfFloatsOnPostgreSQL19AQuotientByEitherZeroIsOneValueTheHostsAndTheRules =
	property.explore(batchGen, {
		needs: { substrate: Substrate.installing },
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
			({ substrate }, k: Case<ZeroQuotientFeature>) =>
			({ carrier, dividends }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						k.note(carrier === "float8" ? "a double's quotient" : "a real's quotient")
						for (const x of dividends) {
							k.note(classOf(x, carrier))
						}
						const rows = rowsOf(dividends)
						const pinned = yield* s.admin.pin
						const answered = yield* inInstallation(
							pinned,
							[],
							pinned.queryValues(quotientSql(carrier), [jsonText(rowsJson(rows))])
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
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "grizzle's quotient by zero, the infinity of the dividend's sign or NaN over a zero or NaN dividend, a function of the dividend alone"
		},
		budget: { runs: 12, steered: 12 },
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

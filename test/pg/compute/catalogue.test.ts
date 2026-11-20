/**
 * The scalar catalogue against PostgreSQL 19: every operation grizzle admits over the gate types (smallint, integer,
 * bigint, numeric, double precision, real and money), and each admitted cast between them, at operands drawn at every
 * boundary the operation turns on and spelled as PostgreSQL may store them (a display scale past the least, a float
 * zero's sign).
 *
 * A case is one catalogue entry (an operation at a carrier, a cast from one, numeric's width_bucket, or lcm over
 * fractional numerics) with operands of its own carrier, so a failure names its entry and shrinking it runs that entry
 * alone. Each witness case is aimed at an entry no witness has reached, so every entry runs on every run.
 *
 * - Each admitted case's SQL, as a query lowers it, runs in PostgreSQL, and its result type and value are the host
 *   evaluator's, or the host declines it by design; the reference evaluator (test/support/oracle/evaluate/catalog.ts)
 *   states the same.
 * - A case refused at compilation is refused for a precondition the operands' values justify.
 *
 * Oracle: PostgreSQL itself, each operation's value and type, beside the host and the reference evaluators.
 *
 * Features: each entry agreeing on a value, or declined by the host by design; each entry at each boundary class of its
 * carrier and read through each spelling; and lcm past its operands' digits.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	buildCases,
	casePerEntry,
	catalogue,
	type CatalogueFeature,
	justified,
	labelOf,
	lcmPastOperandDigits,
	reached,
	situations,
	catalogueEvaluator
} from "#test/pg/compute/catalogue.fixtures.ts"
import { caseChunk, compareAnswers, type PgAnswer, runCases } from "#test/pg/compute/support.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The scalar catalogue against PostgreSQL 19 agrees with PostgreSQL on the result type and value of every operation at every boundary, and refuses only what the values justify.
 *
 * Its pre-conversion budget: runs casePerEntry, coverage cases casePerEntry (test/pg/compute/catalogue.test.ts at c568eb123).
 */
export const theComputeCatalogueAgainstPostgreSQL19AgreesWithPostgreSQLOnTheResultTypeAndValueOfEveryOperationAtEveryBoundaryAndRefusesOnlyWhatTheValuesJustify =
	property.explore(
		aimed(
			oneOf(Arr.map(catalogue, (e) => e.gen)),
			Arr.flatMap(catalogue, (e) => Arr.map(e.situations, (s) => [s, e.gen] as const))
		),
		{
			needs: { evaluator: Substrate.seat(catalogueEvaluator) },
			situations: situations satisfies ReadonlyArray<Reached<CatalogueFeature>>,
			check:
				({ evaluator }, c: Case<CatalogueFeature>) =>
				(k) =>
					Effect.scoped(
						Effect.flatMap(evaluator, (taken) =>
							Effect.provideService(
								Effect.gen(function* () {
									const { session } = yield* Substrate
									const db = yield* session(ownerSession())
									const s = taken.value

									const label = labelOf(k)
									const all = buildCases(k)
									const unjustified = Arr.flatMap(all, (r) =>
										r.built.kind === "refused" && !justified(r.built.precondition, r.read)
											? [
													`${r.built.label} refused for ${r.built.precondition} at ${Arr.join(
														Arr.map(r.read, (o) => Formatter.format(o.value)),
														", "
													)}`
												]
											: []
									)
									assert.deepEqual(unjustified.slice(0, 10), [])
									const ran = Arr.flatMap(all, (r) => (r.built.kind === "case" ? [r] : []))
									const cases = Arr.flatMap(ran, (r) =>
										r.built.kind === "case" ? [r.built.evalCase] : []
									)
									const answers: ReadonlyArray<PgAnswer> = yield* runCases(db, s, cases, caseChunk)
									assert.equal(answers.length, cases.length)
									const result = compareAnswers(cases, answers)
									assert.deepEqual(result.mismatches.slice(0, 10), [])
									assert.equal(result.typedOnly, 0)
									const agreed = new Map(
										Arr.map(ran, (r, i) => [r, result.agreed[i] === true] as const)
									)
									if (result.declined > 0) {
										c.note(`${label} declined by the host`)
									}
									c.noteAll(reached(all, agreed))
									if (Arr.some(ran, (r) => lcmPastOperandDigits(r, agreed.get(r) === true))) {
										c.note("lcm/numeric past its operands' integer digits")
									}
								}),
								Substrate,
								taken.substrate
							)
						)
					),
			oracle: {
				kind: "postgresql",
				name: "each operation's value and type, beside the host and the reference evaluators"
			},
			budget: { runs: casePerEntry, steered: casePerEntry },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/total.ts",
					original:
						"\t\troundToFloat(v, carrier, signedZeroOf(v, carrier, floatLit(0, carrier)))\n",
					replacement: "\t\troundToFloat(v, carrier, floatLit(0, carrier))\n",
					why: "The exact path rounds a negative value below half the least subnormal to +0: the least magnitude's negative times the least, or over 2.5, is 0 in the SQL where the host's IEEE 754 arithmetic gives -0."
				},
				{
					file: "packages/engine/src/scalar/compute/evaluate.ts",
					original:
						'const r = fn === "add" ? a + b : fn === "sub" ? a - b : fn === "mul" ? a * b : quotient(a, b)',
					replacement:
						'const r = fn === "add" ? a + b : fn === "sub" ? a - b : fn === "mul" ? a * b : a / b',
					why: "The host divides by -0 as IEEE 754 does, the infinity's sign the dividend's flipped, where the SQL gives the dividend's."
				}
			]
		}
	)

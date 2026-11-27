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
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The scalar catalogue against PostgreSQL 19 agrees with PostgreSQL on the result type and value of every operation at every boundary, and refuses only what the values justify.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/catalogue.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap of casePerEntry, run only while a
 *   required situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/catalogue.test.ts` at its budget
 *   before, `{ runs: casePerEntry, steered: casePerEntry }`, its kill's verdict printed with where its witnesses went
 *   red (judgedLine with the red's headline, a local print), in
 *   ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; at runs 1 by path, its kill judged by the run, in
 *   probe2.log there
 * @observed 2026-11-23, 04:00 to 07:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at e79913b8c with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload its kill applied alone and judged on the property's witnesses: its floor stream and its steered phase,
 *   which no run seed moves
 * @result its kill went red on case 96 of its steered phase at its budget before; at runs 1, a floor of one case, its
 *   steered phase reached every required situation and still killed it, 246 cases in all where it ran 497
 * @decision 1, the least a generative search draws; no headroom: a kill its witnesses stop killing fails the kill gate,
 *   which measures it again
 * @revalidate a change of its catalogue, space, situations or kill, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const theComputeCatalogueAgainstPostgreSQL19AgreesWithPostgreSQLOnTheResultTypeAndValueOfEveryOperationAtEveryBoundaryAndRefusesOnlyWhatTheValuesJustify =
	property.explore(
		aimed(
			oneOf(Arr.map(catalogue, (e) => e.gen)),
			Arr.flatMap(catalogue, (e) => Arr.map(e.situations, (s) => [s, e.gen] as const))
		),
		{
			needs: { evaluator: Substrate.rolledBack(catalogueEvaluator) },
			situations: situations satisfies ReadonlyArray<Reached<CatalogueFeature>>,
			check:
				({ evaluator }, c: Case<CatalogueFeature>) =>
				(k) =>
					Effect.scoped(
						Effect.flatMap(evaluator, ({ session: db, value: s }) =>
							Effect.gen(function* () {
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
							})
						)
					),
			oracle: {
				kind: "postgresql",
				name: "each operation's value and type, beside the host and the reference evaluators"
			},
			budget: { runs: 1, steered: casePerEntry },
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
					file: "packages/engine/src/lower/conservative/expr/ops.ts",
					original: '\t\t\treturn args.map((a) => call("trim_scale", [a]))',
					replacement: "\t\t\treturn args",
					why: "A reading of a numeric's display scale takes its operands at the scale they are spelled at: numeric_div of an operand padded past its least scale computes its quotient at the padding's scale, where the host reads the value's least, and the two quotients differ. A numeric's display scale is then part of a value grizzle computes, and its equality no identity (ir/scalar.ts equalityIsIdentityOf)."
				}
			]
		}
	)

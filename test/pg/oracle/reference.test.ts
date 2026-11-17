/**
 * The reference side of the oracle discriminates the structure of a program: the reference derives the delivered
 * statements from the IR, so a lowering that drops an attachment's part, delivers one under another name, or reports a
 * narrowed column type is a structural difference, never a reference built to match it. A fault the conservative
 * program of a generated case offers a target for is planted in it, or none, and the comparison must report exactly
 * the differences the plant makes, read off the program's statement labels (compare.ts labeledStatements) before and
 * after it, and none where it plants nothing. The cases are the generator's own with an attaching root, so most
 * programs offer an attachment to drop or rename; each case draws the fault it plants, a fault still pending where its
 * turn is steered, and plants it where the program offers it a target.
 *
 * That the reference tells a wrong lowering's rows apart (the I1 mutant, a DISTINCT dropped from a projection that
 * keeps no key) is the mutant roster's kill search against it (mutants/invalid.test.ts); that the reference agrees with
 * PostgreSQL's capture of every hard spelling is the conservative gate's (conservative.test.ts), whose generated facts
 * store NaN, -0, display scales and supplementary-plane text.
 *
 * Every planted lowering is the left side, the reference the right; the order of the two is no contract.
 *
 * Features: each fault planted where the program offers it.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import * as Result from "#compiler/core/result.ts"
import {
	type Offered,
	type PlantFeature,
	plantFeatures,
	planted,
	plantOf,
	structureSpace
} from "#test/pg/oracle/reference.fixtures.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import {
	conservative,
	defaultRunOptions,
	type Lowering,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The comparison reports exactly the structure a lowering drops, renames or narrows, planted in a generated case's program. */
export const structure = property.explore(structureSpace, {
	needs: { tx: Substrate.transaction },
	situations: plantFeatures satisfies ReadonlyArray<Reached<PlantFeature>>,
	/** Its pre-conversion budget: runs 40, coverage cases 300 (reference.test.ts at 4fbc3e95). */
	budget: { runs: 40, steered: 300 },
	check:
		({ tx }, c: Case<PlantFeature>) =>
		(sketch) =>
			Effect.flatMap(tx, (held) =>
				Effect.provideService(
					Effect.gen(function* () {
						const seat = yield* OracleSeat
						const name = yield* seat.schema("oracle")
						const chosen: Array<Offered> = []
						const lowering: Lowering = {
							name: planted,
							lower: (input) =>
								Result.map(conservative.lower(input), (program) => {
									const plant = plantOf(program, sketch.fault, sketch.pick)
									chosen.push(plant)
									return plant[1].program
								})
						}
						const outcome = yield* runOracle(sketch.case, lowering, reference, {
							...defaultRunOptions,
							schema: { kind: "named", name }
						})
						const [feature, plant] = defined(chosen[0], "the planted lowering's plant")
						c.note(feature)
						assert.equal(outcome.comparison.equal, plant.expected.length === 0)
						unorderedEqual(outcome.comparison.structural, plant.expected)
					}),
					OracleSeat,
					OracleSeat.rolledBack(held)
				)
			),
	oracle: {
		kind: "specification",
		name: "the structural differences a plant makes, read off the program's statement labels before and after it"
	},
	show: Formatter.format,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/lower/tree.ts",
			original: "\theading.length === 0 ? unitHeading : heading",
			replacement: "\theading.length === 1 ? unitHeading : heading",
			why: "Operator mutant (bound) at packages/engine/src/runtime/lower/tree.ts:37 in deliveredHeading: `0` becomes `1`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	]
})

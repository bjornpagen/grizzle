/**
 * The reference evaluator's faster paths against its nested loops (test/support/oracle/reference/evaluate.ts).
 *
 * A region's occurrence plans and an existence test's column positions only change how the reference finds the rows
 * its definition visits: reading columns by position, and looking a stable source's candidate rows up by the identity
 * of one join value. NestedLoops refuses every plan, so the reference evaluates each region and existence test by the
 * nested loops of its definition; on the oracle populations, both readings agree on every delivered row in order, on
 * every decline the reference observes, and on every refusal. The hash identity they rely on, indexIdentity, agrees with
 * native comparison wherever it gives one.
 *
 * An enum handle outside its roster, like a value of another carrier, is no value of its type: comparison claims no
 * order for it (compareValues) and reports it as a defect, ReferenceUnsupported. indexIdentity gives neither an
 * identity, so no lookup keys them and comparison alone decides them.
 *
 * Oracles: a second implementation each, the reference's nested loops of its definition for the plans, and the
 * reference's comparison (equal) for indexIdentity over a box of every sampled type and every ordered pair of every
 * type's sampled values. The populations are the oracle's own (gen/case.ts, gen/recursive.ts), whose forms
 * test/unit/oracle-gen/query.test.ts and the conservative gate require; here every case is a differential, so no
 * feature of its own is required. indexIdentity's features: one identity, two, none for another carrier, none outside
 * the roster.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"
import { sameIdentity } from "#test/support/kernel/identity.ts"
import {
	defaultGenConfig,
	optimizerGenConfig,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import {
	defaultGraphLimits,
	defaultRecursiveLimits,
	fixedLengthCaseGen,
	recursiveCaseGen
} from "#test/support/oracle/gen/recursive.ts"
import { equal, indexIdentity } from "#test/support/oracle/reference/values.ts"
import {
	agree,
	handles,
	type KeyFeature,
	keyPairs
} from "#test/unit/oracle-runner/reference-plans.fixtures.ts"

/** The reference evaluator's plans agree with its nested loops on the oracle populations: the conservative and the optimized. */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsOnTheOraclePopulations = family({
	conservative: agree(queryCaseGen(defaultGenConfig)),
	optimized: agree(queryCaseGen(optimizerGenConfig))
})

/** The reference evaluator's plans agree with its nested loops where joins and merges meet twin spellings, over every palette and over one. */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsWhereJoinsAndMergesMeetTwinSpellings =
	family({
		twinned: agree(
			queryCaseGen({
				...defaultGenConfig,
				spelling: "twinned"
			})
		),
		onePalette: agree(
			queryCaseGen({
				...defaultGenConfig,
				spelling: "twinned",
				schema: {
					...defaultGenConfig.schema,
					maxPalette: 1
				}
			})
		)
	})

/** The reference evaluator's plans agree with its nested loops on recursions, of any length and of fixed length. */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsOnRecursions = family({
	recursive: agree(recursiveCaseGen(defaultRecursiveLimits)),
	fixedLength: agree(fixedLengthCaseGen(defaultGraphLimits))
})

/** IndexIdentity is one identity exactly for the values comparison finds equal, and none where comparison alone decides. */
export const indexIdentityIsOneIdentityExactlyForTheValuesComparisonFindsEqualAndNoneWhereComparisonAloneDecides =
	property.exhaust(finite(keyPairs), {
		needs: {},
		situations: [
			"one identity",
			"two identities",
			"none for another carrier",
			"none outside the roster"
		] satisfies ReadonlyArray<Reached<KeyFeature>>,
		check:
			(_, c: Case<KeyFeature>) =>
			([type, own, a, b]) =>
				Effect.sync(() => {
					const ka = indexIdentity(a, type)
					const kb = indexIdentity(b, type)
					const label = `${Formatter.format(a)} and ${Formatter.format(b)} as ${type.carrier}`
					if (Arr.some(own, (v) => v === a)) {
						assert.notEqual(ka, undefined, `${Formatter.format(a)} as ${type.carrier}`)
					}
					if (ka === undefined) {
						c.note(
							type === handles && typeof a === "string"
								? "none outside the roster"
								: "none for another carrier"
						)
						return
					}
					if (kb !== undefined) {
						const one = sameIdentity(ka, kb)
						assert.equal(one, equal(a, b, type), label)
						c.note(one ? "one identity" : "two identities")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the reference's comparison: two keyed values share a key exactly when it finds them equal, and it never meets a keyed value of another carrier"
		},
		box: "every sampled type, and every ordered pair of every type's sampled values",
		kept: [],
		kills: []
	})

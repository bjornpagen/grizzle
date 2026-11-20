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
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
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

/**
 * The reference evaluator's plans agree with its nested loops on the oracle populations: the conservative and the optimized.
 *
 * Budget, each member: its suite's count before the conversion (unit/oracle-runner/reference-plans-<member>: 480
 * independent cases and 0 steered, Vitest at grizzle 4ca3036a).
 */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsOnTheOraclePopulations = family({
	conservative: agree(queryCaseGen(defaultGenConfig), {
		budget: { runs: 480, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"\ta === b ||\n\t(a.contract === undefined || b.contract === undefined\n\t\t? a.contract === undefined && b.contract === undefined && samePlain(a, b)\n\t\t: a.carrier === b.carrier &&\n\t\t\ta.contract.name === b.contract.name &&\n\t\t\tsameScalarType(a.contract.base, b.contract.base))",
				replacement: "\ta === b",
				why: "Operator mutant (disjunct) at packages/engine/src/ir/scalar.ts:876 in sameScalarType: `a === b ||\n\t(a.carrier === b.carrier &&\n\t\tsameOrder(a.caps, b.caps) &&\n\t\tsameCon` becomes `a === b`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}),
	optimized: agree(queryCaseGen(optimizerGenConfig), {
		budget: { runs: 480, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					'\ttypeof a === "string" || typeof b === "string"\n\t\t? a === b\n\t\t: samePatterns(a.patterns, b.patterns) && a.key === b.key',
				replacement: "\tfalse",
				why: 'Operator mutant (boolean-return) at packages/engine/src/ir/scalar.ts:850 in sameRegexRef: `a === "wildcard" || b === "wildcard"\n\t\t? a === b\n\t\t: samePatterns(a.patterns, b.` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
})

/**
 * The reference evaluator's plans agree with its nested loops where joins and merges meet twin spellings, over every palette and over one.
 *
 * Budget, each member: its suite's count before the conversion (unit/oracle-runner/reference-plans-<member>: 480
 * independent cases and 0 steered, Vitest at grizzle 4ca3036a).
 */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsWhereJoinsAndMergesMeetTwinSpellings =
	family({
		twinned: agree(
			queryCaseGen({
				...defaultGenConfig,
				spelling: "twinned"
			}),
			{
				budget: { runs: 480, steered: 0 },
				kills: [
					{
						file: "packages/engine/src/ir/scalar.ts",
						original:
							"\t\t\t\t\ta.bound.digits === b.bound.digits &&\n\t\t\t\t\ta.bound.scale === b.bound.scale",
						replacement: "\t\t\t\t\tfalse",
						why: "Operator mutant (boolean-return) at packages/engine/src/ir/scalar.ts:830 in sameNumericBound: `a?.digits === b?.digits && a?.scale === b?.scale` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6)."
					}
				]
			}
		),
		onePalette: agree(
			queryCaseGen({
				...defaultGenConfig,
				spelling: "twinned",
				schema: {
					...defaultGenConfig.schema,
					maxPalette: 1
				}
			}),
			{
				budget: { runs: 480, steered: 0 },
				kills: [
					{
						file: "packages/text/src/regex/parse.ts",
						original: "\t\t\tvalue = Math.min(value * 10 + (c - 0x30), Number.MAX_SAFE_INTEGER)",
						replacement: "\t\t\tvalue = Math.min(value * 10 + (0x30 - c), Number.MAX_SAFE_INTEGER)",
						why: "Operator mutant 19928abb4c at packages/text/src/regex/parse.ts:453 in <module>: `c - 0x30` becomes `0x30 - c`; the property fails (the census, lane TESTPOLICY2)."
					}
				]
			}
		)
	})

/**
 * The reference evaluator's plans agree with its nested loops on recursions, of any length and of fixed length.
 *
 * Budget, each member: its suite's count before the conversion (unit/oracle-runner/reference-plans-<member>: 480
 * independent cases and 0 steered, Vitest at grizzle 4ca3036a).
 */
export const theReferenceEvaluatorsPlansAgreeWithItsNestedLoopsOnRecursions = family({
	recursive: agree(recursiveCaseGen(defaultRecursiveLimits), {
		budget: { runs: 480, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/scalar/compute/term.ts",
				original: '\tif (entry === undefined && built in value && "expr" in value) {',
				replacement: '\tif (entry !== undefined && built in value && "expr" in value) {',
				why: "Operator mutant aca9e1f9f6 at packages/engine/src/scalar/compute/term.ts:219 in registeredOf: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	}),
	fixedLength: agree(fixedLengthCaseGen(defaultGraphLimits), {
		budget: { runs: 480, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"\ta === b ||\n\t(a.contract === undefined || b.contract === undefined\n\t\t? a.contract === undefined && b.contract === undefined && samePlain(a, b)\n\t\t: a.carrier === b.carrier &&\n\t\t\ta.contract.name === b.contract.name &&\n\t\t\tsameScalarType(a.contract.base, b.contract.base))",
				replacement: "\ta === b",
				why: "Two descriptors are one type only where they are one object, as when sameContract answered false for every pair, plain ones included; the fixed-length recursion's plans and nested loops disagree."
			}
		]
	})
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
		kills: [
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original:
					'\t\t\t\t\tadd(from, { kind: "empty", to: entry(states, i) })\n\t\t\t\t}\n\t\t\t\tbreak\n\t\t\t}\n\t\t\tcase "atom": {',
				replacement:
					'\t\t\t\t\tadd(from, { kind: "empty", to: entry(states, i) })\n\t\t\t\t}\n\t\t\t\t{}\n\t\t\t}\n\t\t\tcase "atom": {',
				why: "Operator mutant 63c7e45777 at packages/engine/src/ir/pattern-space.ts:559 in rawNfa: `break` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

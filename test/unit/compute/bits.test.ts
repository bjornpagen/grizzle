/**
 * The host evaluator's set algebra over a roster (scalar/compute/evaluate.ts compiledExpr), each operation as the
 * registry names it, against a naive model of sets of codes.
 *
 * - The model: a set is a Set<number> of its codes in a roster of five codes, each live or a hole; union, intersection
 *   and difference are the Set operations, cardinality the count, subset and disjointness the membership tests, and a
 *   set with one more handle (set_bit, computeCore.singleton's over the empty set) the set with that handle's code added.
 *   A NULL handle, a closed read's at an absent key, gives NULL, as set_bit is strict.
 * - The codec as a second reader: each set the evaluator returns, written by the set codec under the installation's
 *   codes, is the model's set as one bit per code in its one text, X then the hex digits of the bits domain's width,
 *   holes and padding 0 (test/support/closed/bit-text.ts), so the host and the bit string PostgreSQL stores agree.
 * - The named invalid variant, refused at typing: a set operation over sets of two rosters, which are two universes
 *   whose codes name other handles.
 *
 * The box, exhausted: every hole pattern of a five-code roster that leaves a handle live, every pair of subsets of
 * its live handles, and each live handle and NULL as the one a set gains.
 *
 * Features: a singleton at the first and last code and past a hole, a hole, an empty set, a strict subset, disjoint
 * and overlapping sets; every native operation over two rosters' sets.
 */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { bit } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { NativeFn } from "#compiler/scalar/compute/registry.ts"
import { closed } from "#compiler/schema/api.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { twoSetOperations } from "#test/unit/compute/bits.dictionary.ts"
import {
	agrees,
	patterns,
	type Situation,
	twoOperandCores
} from "#test/unit/compute/bits.fixtures.ts"

/** The host's set algebra agrees with a model of sets of codes, and writes its sets one bit per code, holes 0. */
export const theHostsSetAlgebraAgreesWithAModelOfSetsOfCodesAndWritesItsSetsOneBitPerCodeHoles0 =
	property.exhaust(finite(patterns), {
		needs: {},
		situations: [
			"a singleton at the first code",
			"a singleton at the last code",
			"a singleton past a hole, its code no position",
			"a hole",
			"an empty set",
			"a strict subset",
			"disjoint sets",
			"overlapping sets neither within the other"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (value) => agrees(value, c),
		oracle: { kind: "second-implementation", name: "a Set<number> model of the codes" },
		box: "every hole pattern of five codes, every pair of subsets of its live handles",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\treturn Result.ok(new Set([...hostOf("bits", a(args))].filter((h) => !y.has(h))))',
				replacement:
					'\t\t\t\treturn Result.ok(new Set([...hostOf("bits", a(args))].filter((h) => y.has(h))))',
				why: "The host evaluates a set's difference as its intersection; the model property fails."
			}
		]
	})

/** The host's set algebra refuses every operation over two sets of two rosters, which name other handles. */
export const theHostsSetAlgebraRefusesEveryOperationOverTwoSetsOfTwoRostersWhichNameOtherHandles =
	property.exhaust(finite(word(twoSetOperations)), {
		needs: {},
		situations: nonEmpty(
			Arr.map(twoSetOperations, (op) => op.fn),
			"a function"
		) satisfies ReadonlyArray<Reached<NativeFn>>,
		check: (_, c: Case<NativeFn>) => (op) =>
			Effect.sync(() => {
				const core = defined(twoOperandCores[op.fn], `the catalogue member of ${op.fn}`)
				const left = bit(closed.ordered("Left", ["a", "b"]))
				const right = bit(closed.ordered("Right", ["a", "b"]))
				const x = computeCore.literal(left, new Set(["a"]))
				const y = computeCore.literal(right, new Set(["a"]))
				throwsRefused(() => core(x, y), "MalformedDescription")
				c.note(op.fn)
			}),
		oracle: { kind: "specification", name: "a set meets only a set of its roster" },
		box: "every native operation over two sets",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/types.ts",
				original: "\trosterOf(a)?.closed === rosterOf(b)?.closed &&\n",
				replacement: "",
				why: "Two operands' types are taken as one whatever their closed rosters, so sets of two rosters meet; the two-rosters refusal fails."
			}
		]
	})

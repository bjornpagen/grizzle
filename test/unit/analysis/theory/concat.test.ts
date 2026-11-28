/**
 * Monoid.concat, text's free monoid, folds a sequence (ir/monoid.ts): the empty text, then each member's step value
 * after the running text. Its law means what the fold says: evaluated by the reference evaluator over every state of
 * a small box, the violation query of a concat fold over an ordered family, its (before, after) pair named, is empty
 * exactly on the states a naive left fold calls lawful. Its combine is the equation `after = before || x`, which the
 * scalar lowering decides as an equality with the concatenation built under its bytes' guard (compute/typing.ts
 * concatEquation), so the law reads no text longer than one PostgreSQL holds.
 *
 * A concat fold names its pair, and folds only a sequence: the fold rule refuses one over a counted family, whose
 * order is hidden, and one whose accumulators are hidden, whose law would need an ordered aggregate (check/fold.ts
 * foldRule).
 *
 * - The fold: over every state of one owner's ordered family of 0 to 2 members, each step '', 'a' or 'b', its
 *   accumulators and total '', 'a', 'b' or 'ab', the violation query is empty exactly where a naive left fold holds.
 *   Oracle: the naive left fold, a second implementation.
 * - The rule: an ordered or counted family, its pair named or hidden, admitted exactly as an ordered family's named
 *   pair, each other refused by the named refusal foldRule states. Oracle: that rule.
 *
 * Features: each verdict of each box.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { refused } from "#test/support/assert.ts"
import {
	type HostFacts,
	lawOfShape,
	theoryResult,
	uuidOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"
import {
	type ConcatFault,
	concatFault,
	concatSchema,
	concatState,
	type Declared,
	type Verdict,
	visible
} from "#test/unit/analysis/theory/concat.fixtures.ts"

/** A concat fold is violated exactly when its accumulators are not the naive fold's. */
export const aConcatFoldIsViolatedExactlyWhenItsAccumulatorsAreNotTheNaiveFolds = property.exhaust(
	finite(concatState),
	{
		needs: {},
		situations: [
			"lawful",
			"a wrong fold accumulator at slot 0",
			"a stale predecessor",
			"a wrong step",
			"a wrong end",
			"an empty step"
		] satisfies ReadonlyArray<Reached<ConcatFault>>,
		check: (_, k: Case<ConcatFault>) => (s) =>
			Effect.sync(() => {
				const fault = concatFault(s)
				k.note(fault)
				if (fault === "lawful" && Arr.some(s.members, (m) => m.x === "")) {
					k.note("an empty step")
				}
				const facts: HostFacts = {
					O: [{ id: uuidOf(1), n: BigInt(s.members.length), total: s.total }],
					F: Arr.map(s.members, (m, i) => ({
						fid: uuidOf(100 + i),
						o: uuidOf(1),
						at: BigInt(i),
						x: m.x,
						before: m.before,
						after: m.after
					}))
				}
				assert.equal(
					violates(visible, lawOfShape(visible, "fold"), facts),
					fault !== "lawful",
					`${Formatter.format(s)} is ${fault}`
				)
			}),
		oracle: { kind: "second-implementation", name: "a naive left fold of the slots' texts" },
		box: "one owner's ordered family of 0 to 2 members, each step '', 'a' or 'b', accumulators and total '', 'a', 'b' or 'ab'",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\t\t\t\t\tthis.overload("concat", [a.actual, b.actual], here),\n\t\t\t\t\t[a, b],',
				replacement:
					'\t\t\t\t\tthis.overload("concat", [b.actual, a.actual], here),\n\t\t\t\t\t[b, a],',
				why: "The equation's concatenation built with its parts reversed (scalar/compute/typing.ts concatEquation), so each after is stated as its step before the running text; the fold property fails."
			},
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: "\t\treturn build.apply(plane.fn, before, delta)",
				replacement: "\t\treturn build.apply(plane.fn, delta, before)",
				why: "A combine puts its step before its before (ir/monoid.ts, which the host's fill reads too), so a concat fold's law states each after as its piece followed by the running text; the fold property fails."
			}
		]
	}
)

/** A concat fold folds only a sequence, and names its (before, after) pair there. */
export const aConcatFoldFoldsOnlyASequenceAndNamesItsBeforeAfterPairThere = property.exhaust(
	finite((source): Declared => ({
		order: element(["ordered", "counted"] as const)(source),
		pair: element([true, false] as const)(source)
	})),
	{
		needs: {},
		situations: ["an ordered family's named pair admitted", "refused"] satisfies ReadonlyArray<
			Reached<Verdict>
		>,
		check: (_, k: Case<Verdict>) => (d) =>
			Effect.sync(() => {
				const built = theoryResult(concatSchema(d.order, d.pair))
				const admitted = d.order === "ordered" && d.pair
				if (admitted) {
					assert.ok(built.ok, `${Formatter.format(d)} builds its theory`)
					k.note("an ordered family's named pair admitted")
					return
				}
				const e = refused(built, "Refused", `${Formatter.format(d)} is refused`)
				assert.equal(
					e.reason._tag === "Refused" ? e.reason.refusal : undefined,
					d.order === "counted"
						? "a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"
						: "a concat fold names its (before, after) pair after its value: its law reads each member's running value"
				)
				k.note("refused")
			}),
		oracle: {
			kind: "specification",
			name: "a non-commutative monoid folds a sequence by its named pair (check/fold.ts foldRule)"
		},
		box: "an ordered or counted family, its pair named or hidden",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/fold.ts",
				original:
					'\tif (fold.order === "counted" && !monoid.commutative) {\n\t\treturn namedBreach(\n\t\t\t"a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"\n\t\t)\n\t}\n',
				replacement: "",
				why: "A counted family's hidden concat refused for its hidden pair, not its order (check/fold.ts foldRule); the rule property fails."
			}
		]
	}
)

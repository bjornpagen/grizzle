/**
 * A fold's law means what the fold says (fin.md §4.3, w4-w7 §2.3): evaluated by the reference evaluator over every
 * state of a small box, its violation query is empty exactly on the states a naive fold calls lawful, with its
 * accumulators named (their copies, combine and identity pins) or hidden (the end alone). The boxes are exhausted and
 * named in each search. A fold ranges over its family's member rows, each distinct by its key, never over the
 * projection of its step value (rows-first §0): two members of one step value are two rows, which a sum counts twice.
 *
 * or's and twos' hidden folds state each handle's membership through set algebra, which the reference evaluator
 * declines by design (test/support/oracle/evaluate/catalog.ts: PostgreSQL alone evaluates it), so the hidden-fold box
 * judges the folds over naturals; the pg tier judges the set monoids' natives.
 *
 * Features: each verdict and each broken law of each box.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type HostFacts,
	lawOfShape,
	uuidOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"
import {
	type Counting,
	type FoldFault,
	hidden,
	hiddenFoldState,
	hiddenLawful,
	visible,
	visibleFault,
	visibleFoldState
} from "#test/unit/analysis/theory/folds.fixtures.ts"

/** A fold's law with named accumulators, is violated exactly when they are not the naive fold's. */
export const aFoldsLawWithNamedAccumulatorsIsViolatedExactlyWhenTheyAreNotTheNaiveFolds =
	property.exhaust(finite(visibleFoldState), {
		needs: {},
		situations: [
			"lawful",
			"a wrong fold accumulator at slot 0",
			"a stale predecessor",
			"a wrong step",
			"a wrong end"
		] satisfies ReadonlyArray<Reached<FoldFault>>,
		check: (_, k: Case<FoldFault>) => (s) =>
			Effect.sync(() => {
				const fault = visibleFault(s)
				k.note(fault)
				const facts: HostFacts = {
					O: [{ id: uuidOf(1), n: BigInt(s.members.length), total: BigInt(s.total) }],
					F: Arr.map(s.members, (m, i) => ({
						fid: uuidOf(100 + i),
						o: uuidOf(1),
						at: BigInt(i),
						x: BigInt(m.x),
						skip: BigInt(m.skip),
						before: BigInt(m.before),
						after: BigInt(m.after)
					}))
				}
				assert.equal(
					violates(visible, lawOfShape(visible, "fold"), facts),
					fault !== "lawful",
					`${Formatter.format(s)} is ${fault}`
				)
			}),
		oracle: { kind: "second-implementation", name: "a naive left fold over the slots" },
		box: "one owner's family of 0 to 2 members, each x and skip 0 or 1, accumulators and total 0 to 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original:
					"\t\t\t\tpinViolation(\n\t\t\t\t\tb,\n\t\t\t\t\t{\n\t\t\t\t\t\trelation: member,\n\t\t\t\t\t\tat: s.index,\n\t\t\t\t\t\tfield: p.before,\n\t\t\t\t\t\tstart: p.identity\n\t\t\t\t\t},\n\t\t\t\t\tgroup,\n\t\t\t\t\twitness\n\t\t\t\t),\n",
				replacement: "",
				why: "A named fold's violation omits its first-slot identity pin (analysis/theory/laws.ts foldArms); the visible box fails."
			}
		]
	})

/** A fold's law with hidden accumulators, is violated exactly when the end is not the naive fold's. */
export const aFoldsLawWithHiddenAccumulatorsIsViolatedExactlyWhenTheEndIsNotTheNaiveFolds =
	property.exhaust(finite(hiddenFoldState), {
		needs: {},
		situations: [
			"count lawful",
			"count unlawful",
			"sum lawful",
			"sum unlawful",
			"max lawful",
			"max unlawful",
			"two members of one step value, summed twice"
		] satisfies ReadonlyArray<
			Reached<
				`${Counting} ${"lawful" | "unlawful"}` | "two members of one step value, summed twice"
			>
		>,
		check:
			(
				_,
				k: Case<
					`${Counting} ${"lawful" | "unlawful"}` | "two members of one step value, summed twice"
				>
			) =>
			(s) =>
				Effect.sync(() => {
					const lawful = hiddenLawful(s)
					k.note(`${s.monoid} ${lawful ? "lawful" : "unlawful"}`)
					const [x, y] = s.xs
					if (s.monoid === "sum" && lawful && x !== undefined && x > 0 && x === y) {
						k.note("two members of one step value, summed twice")
					}
					const t = defined(hidden.get(s.monoid))
					const facts: HostFacts = {
						O: [{ id: uuidOf(1), n: BigInt(s.xs.length), end: BigInt(s.end) }],
						F: Arr.map(s.xs, (x, i) => ({
							fid: uuidOf(100 + i),
							o: uuidOf(1),
							...(s.monoid === "count" ? {} : { x: BigInt(x) })
						}))
					}
					assert.equal(
						violates(t, lawOfShape(t, "fold"), facts),
						!lawful,
						`${Formatter.format(s)} is ${lawful ? "the fold" : "no fold"}`
					)
				}),
		oracle: { kind: "second-implementation", name: "a naive fold of the members' values" },
		box: "count, sum and max over a counted family of 0 to 2 members, each value 0 to 2, every end in range",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original: "\t\t\treturn [w(unequal), w(off)]",
				replacement: "\t\t\treturn [w(unequal)]",
				why: "A hidden fold's violation omits the arm of an end off its members' combine (analysis/theory/laws.ts foldArms); the hidden box fails."
			},
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: '\t\taggregate: "max",',
				replacement: '\t\taggregate: "min",',
				why: "The greater of two values accumulates by min (ir/monoid.ts accumulations, which every window reads too), so a hidden max fold's law states its end the least step; the hidden box fails."
			}
		]
	})

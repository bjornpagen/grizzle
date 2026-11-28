/**
 * A fold's natives are w4-w7 §2.3's: per plane a before copied from the predecessor's after on the predecessor axis and
 * an end copied from the last member's after on the last axis, each a field the step side names or a drawn law column
 * when it names none, and the fold's own CHECKs, judged on every row of the box by the reference evaluator:
 *
 * - on the member, every after is `combine(before, x)` where the step side's selection holds and its before where it
 *   does not, compared in exact arithmetic, and at the first slot every before is the monoid's identity
 *   (`i > 0 OR before = ι`);
 * - on the owner, an empty family's every end is the identity (`n > 0 OR end = ι`).
 *
 * The oracles: NP's reference combine (test/support/families/fold.ts `combined`, exact bigint arithmetic), a second
 * implementation of each monoid's step; and the specification's pins.
 *
 * Bound: every monoid on every carrier it admits (count on natural; sum on int2, int4, int8, natural, numeric(4, 1)
 * and money; or and twos on a two-handle roster's sets; max on int2, int4, int8, natural, a closed id and money), over
 * an ordered family with named accumulators or hidden ones and a counted family with hidden ones, stepping over every
 * member or a selected one: 90 folds. A sum over money is refused at the fold's typing (the monoid admits no money):
 * its combine has no exact CHECK, as money's exact arithmetic is through its STABLE cast to numeric and its own
 * addition raises on overflow, so its six cases assert the refusal. Each CHECK is judged on every row of three values a plane (four for a set, the
 * identity among them), every after the combine gives or another, both selections and both first slots. The named
 * mutant, the first-slot pin dropped (the fold accumulator unconstrained at slot 0), is a row at slot 0 whose before
 * is no identity and whose after is its combine, which the box refuses.
 *
 * The names: a hidden accumulator is named by its fold's law, so over every order of two or three folds of one family
 * and every fold removed, every other fold's hidden accumulators keep their identifiers (a metamorphic oracle).
 *
 * Features: each monoid and carrier, named and hidden, ordered and counted, selected or not; each hidden fold removed,
 * a fold before the removed one and one after it.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { modelOf, onRelation } from "#test/support/unit/laws/model/natives.ts"
import {
	checkShape,
	type Feature,
	features,
	hiddenFolds,
	hiddenOf,
	type NamesFeature,
	removalGen,
	shapeGen
} from "#test/unit/laws/model/fold.fixtures.ts"

/** A fold's natives are §2.3's: its copies on two axes, its combine and its identity pins a hidden accumulator is named by its fold's law: removing a fold renames none of another fold's. */
export const aFoldsNativesAre23sItsCopiesOnTwoAxesItsCombineAndItsIdentityPinsAHiddenAccumulatorIsNamedByItsFoldsLawRemovingAFoldRenamesNoneOfAnotherFolds =
	property.exhaust(finite(removalGen), {
		needs: {},
		situations: [
			"count removed",
			"sum removed",
			"max removed",
			"a fold before the removed one",
			"a fold after it"
		] satisfies ReadonlyArray<Reached<NamesFeature>>,
		check: (_, c: Case<NamesFeature>) => (r) =>
			Effect.sync(() => {
				const gone = defined(r.folds[r.removed], "the removed fold")
				c.note(`${gone} removed`)
				if (r.removed > 0) {
					c.note("a fold before the removed one")
				}
				if (r.removed < r.folds.length - 1) {
					c.note("a fold after it")
				}
				const both = modelOf(hiddenFolds(r.folds))
				const without = modelOf(hiddenFolds(Arr.remove(r.folds, r.removed)))
				for (const kept of Arr.remove(r.folds, r.removed)) {
					const named = (model: LawModel) =>
						defined(hiddenOf(model).get(kept), `the ${kept} fold's hidden accumulators`)
					assert.deepEqual(
						named(without),
						named(both),
						`the ${kept} fold's columns keep their names when the ${gone} fold goes`
					)
				}
				const natives = new Set(Arr.map(onRelation(both, "LawColumn", "Member"), (x) => x.column))
				assert.ok(
					Arr.every([...hiddenOf(both).values()], (columns) =>
						Arr.every(columns, (x) => natives.has(x))
					),
					"every hidden accumulator the family names is a law column native of its member"
				)
			}),
		oracle: {
			kind: "universal",
			name: "metamorphic: every other fold's names with and without the removed fold"
		},
		box: "every order of two or three distinct hidden folds by count, sum and max over one counted family, each removed",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\tconst law = this.#recognizer.foldLaw(familyKey(id), at).law.id",
				replacement: "\t\tconst law = this.#recognizer.foldLaw(familyKey(id), 0).law.id",
				why: "Every fold's hidden accumulators named by the family's first fold's law (laws/model/plan.ts foldColumns); the names fail."
			}
		]
	})

/** A fold's natives are §2.3's: its copies on two axes, its combine and its identity pins every monoid on every carrier it admits, over ordered and counted families. */
export const aFoldsNativesAre23sItsCopiesOnTwoAxesItsCombineAndItsIdentityPinsEveryMonoidOnEveryCarrierItAdmitsOverOrderedAndCountedFamilies =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.note(`monoid ${s.monoid}`)
				c.note(`carrier ${s.carrier}`)
				c.note(s.accumulators === "named" ? "named accumulators" : "hidden accumulators")
				if (s.order === "counted") {
					c.note("a counted family")
				}
				if (s.selected) {
					c.note("a selected step")
				}
				checkShape(s)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference combine in exact bigint arithmetic, and §2.3's pins"
		},
		box: "every monoid on every admitted carrier, ordered named, ordered hidden or counted hidden, selected or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\tif (start === undefined || at === undefined) {",
				replacement: '\t\tif (start === undefined || at === undefined || axis === "predecessor") {',
				why: "The predecessor axis's base pin, and so the first-slot identity pin, dropped (laws/model/plan.ts pin); the natives fail."
			},
			{
				file: "packages/engine/src/ir/monoid.ts",
				original: '\t\t{ fn: "union", delta: "met" }',
				replacement: '\t\t{ fn: "union", delta: "step" }',
				why: "twos' second plane takes the union of the member's set, not of its meet with the ones before it (ir/monoid.ts, which the host's fill reads too), so the CHECK of its combine admits a row the reference combine refuses; the natives fail."
			}
		]
	})

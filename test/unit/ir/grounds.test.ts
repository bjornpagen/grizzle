/**
 * A key proof's grounds (ir/keys.ts proved): the premises and the context a proof rests on are those of every derivation
 * and proof below it, and each derivation's grounds are worked out once, from those of the derivations it carries, and
 * read by every proof that rests on it.
 *
 * Oracle: the walk every proof made before derivations kept their grounds (a second implementation: the old
 * algorithm), every derivation below a proof walked again for each proof; and the derivations those walks reach.
 *
 * Features: a derivation carried by several proofs, a proof carried by a derivation, a context stronger than
 * query-local, a premise.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { premiseText } from "#compiler/ir/evidence.ts"
import type { Implication } from "#compiler/ir/keys.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	built,
	derivationHoldsPremise,
	recipes,
	walkedGrounds
} from "#test/unit/ir/grounds.fixtures.ts"

type GroundsFeature =
	| "a derivation carried by several proofs"
	| "a proof carried by a derivation"
	| "a context stronger than query-local"
	| "a premise"

/** What the property counts: each derivation's grounds worked out (ir/keys.ts implicationGrounding). */
const groundingSites = {
	implicationGrounding: { file: "packages/engine/src/ir/keys.ts", name: "implicationGrounding" },
	ownGrounding: { file: "packages/engine/src/ir/keys.ts", name: "ownGrounding" }
} as const

/**
 * A proof's premises and context are its derivations' and its proofs', as the walk of every derivation below it gives
 * them, and the derivations of a sequence of proofs are grounded once each, however many proofs carry them; a derivation
 * keeps grounds of its own only where it holds a premise, sharing a carried derivation's or one value of no premise.
 *
 * Budget: 300 runs and 300 steered cases, enough for the steered phase to reach a derivation several proofs carry beside
 * a proof a derivation carries.
 */
export const aProofsGroundsAreItsDerivationsAndEachDerivationIsGroundedOnceHoweverManyProofsCarryIt =
	property.explore(recipes, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a derivation carried by several proofs",
			"a proof carried by a derivation",
			"a context stronger than query-local",
			"a premise"
		] satisfies ReadonlyArray<Reached<GroundsFeature>>,
		check: (_, c: Case<GroundsFeature>) => (recipe) =>
			Effect.gen(function* () {
				const [items, counts] = yield* callCounts(
					Effect.sync(() => built(recipe)),
					groundingSites
				)
				const reached = new Set<Implication>()
				const carriedBy = new Map<Implication, number>()
				for (const item of items) {
					if (item.kind !== "proof") {
						continue
					}
					const walked = walkedGrounds(item.value)
					const premises: ReadonlyArray<string> = Arr.map(item.value.premises, premiseText)
					assert.deepEqual(
						premises,
						walked.premises,
						"a proof's premises are those of every derivation and proof below it"
					)
					assert.equal(
						item.value.context,
						walked.context,
						"a proof's context is its grounds' strongest"
					)
					for (const at of walked.reached) {
						reached.add(at)
						carriedBy.set(at, (carriedBy.get(at) ?? 0) + 1)
					}
					if (item.value.premises.length > 0) {
						c.note("a premise")
					}
					if (item.value.context !== "queryLocal") {
						c.note("a context stronger than query-local")
					}
				}
				if (Arr.some([...carriedBy.values()], (n) => n > 1)) {
					c.note("a derivation carried by several proofs")
				}
				if (
					Arr.some(
						recipe,
						(item) =>
							item.kind === "derivation" &&
							Arr.some(item.steps, (s) => s.rule === "unionKey" || s.rule === "produced")
					)
				) {
					c.note("a proof carried by a derivation")
				}
				assert.equal(
					counts.implicationGrounding,
					reached.size,
					`${counts.implicationGrounding} groundings of ${reached.size} derivations the proofs carry`
				)
				const holding = Arr.filter([...reached], derivationHoldsPremise).length
				const proofs = Arr.filter(items, (item) => item.kind === "proof").length
				assert.ok(
					counts.ownGrounding <= holding + proofs,
					`${counts.ownGrounding} grounds of their own for ${holding} derivations holding a premise and ${proofs} proofs`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "every derivation below each proof walked again for the proof, as before derivations kept their grounds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/keys.ts",
				original: "\t\tcarriedImplications(d).filter((c) => !groundings.has(c))\n",
				replacement: "\t\tcarriedImplications(d)\n",
				why: "Every derivation below a proof is grounded again for the proof, as the walk before kept no grounds: a derivation several proofs carry is grounded once for each, and the groundings outnumber the derivations."
			},
			{
				file: "packages/engine/src/ir/keys.ts",
				original: "\t\tif (this.premises.size === 0) {\n\t\t\treturn premiseless[context]\n\t\t}\n",
				replacement: "",
				why: "A derivation holding no premise keeps grounds of its own, as every derivation did once it kept its grounds: grounds of their own outnumber the derivations holding a premise and the proofs."
			},
			{
				file: "packages/engine/src/ir/keys.ts",
				original: "\t\t\tg.proof(proof)\n\t\t}\n\t}\n\treturn g.done()\n",
				replacement: "\t\t}\n\t}\n\treturn g.done()\n",
				why: "A derivation's grounds leave out the proofs its rules carry (a union key's, a produced fact's input): a proof resting on one misses their premises and contexts."
			}
		]
	})

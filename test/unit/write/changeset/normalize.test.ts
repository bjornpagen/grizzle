/** Pair(k, v, c): primary key k, candidate key c, mutable inside the unit of its k.
 *
 * Host normalization of enumerated members over one to three strata, checked against the
 * brute-force add-wins calculator: a refusal before SQL is a ChangeSet the add-wins meaning rejects, by a key law some
 * stratum's own additions violate whatever the state; a stratum that deletes two facts at one value of a key is no
 * refusal, since (S minus D) union A is lawful whichever of them is stored; and a normalized ChangeSet means exactly
 * what the one it came from means. A fact no relation admits (a NULL, a field its relation lacks, a field its fact
 * lacks) is a planted fault, refused by its own fault before anything else.
 *
 * Oracles: the brute-force add-wins calculator (oracle/addwins.ts, a second implementation) and the fact shape each
 * relation admits (a specification). The initial state is lawful by construction, its k and c each drawn once.
 *
 * Features: two and three strata, a refusal by a key, two deletions at one key normalized, a later stratum restating an earlier one's key, a fact a stratum both deletes and adds
 * netted; each planted fault.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, array, element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { refused } from "#test/support/assert.ts"
import {
	caseGen,
	type Fault,
	faultOf,
	faults,
	memberGen,
	nettingGen,
	normalizedOf,
	type NormalizeFeature,
	normalizes,
	normalizingPrefix,
	plantedGen,
	restatingGen,
	stratumOf
} from "#test/unit/write/changeset/normalize.fixtures.ts"

/**
 * Normalization against the add-wins meaning refuses only what add-wins rejects with that key law, and keeps the
 * meaning of what it passes.
 *
 * Budget: 1500 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/normalize.test.ts:586 at 8cad5bce, its runs and its coverage's cases).
 */
export const normalizationAgainstTheAddWinsMeaningRefusesOnlyWhatAddWinsRejectsWithThatKeyLawAndKeepsTheMeaningOfWhatItPasses =
	property.explore(
		aimed(caseGen, [
			["a later stratum restates an earlier stratum's key", restatingGen],
			["a fact a stratum both deletes and adds, netted", nettingGen]
		]),
		{
			needs: {},
			budget: { runs: 1500, steered: 300 },
			situations: [
				"two strata",
				"three strata",
				"refused by a key",
				"two deletions at one key, normalized",
				"a later stratum restates an earlier stratum's key",
				"a fact a stratum both deletes and adds, netted"
			] satisfies ReadonlyArray<Reached<NormalizeFeature>>,
			check:
				(_, c: Case<NormalizeFeature>) =>
				([start, strata]) =>
					normalizes(start, strata, c),
			oracle: { kind: "second-implementation", name: "the brute-force add-wins calculator" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/normalize.ts",
					original:
						"\t\tfor (const [id] of [...sets.insert, ...sets.put]) {\n\t\t\tsets.delete.delete(id)\n\t\t}\n",
					replacement: "",
					why: "A stratum's deletions keep the facts its insertions and puts add (runtime/write/normalize.ts normalizeChangeSet, step 3's netting removed)."
				},
				{
					file: "packages/engine/src/runtime/write/normalize.ts",
					original: "\t\tfor (const [id] of [...sets.insert, ...sets.put]) {",
					replacement:
						"\t\tconst deletedAtOneKey = sameKey(facts, compareFactIdentities, sets.delete.values())\n\t\tif (deletedAtOneKey !== undefined) {\n\t\t\treturn Result.ok(deletedAtOneKey)\n\t\t}\n\t\tfor (const [id] of [...sets.insert, ...sets.put]) {",
					why: "The engine's same-key check over a stratum's deletes restored, so two deletions at one key are refused by that key."
				},
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original: "\t\t\t\t\tObject.freeze({\n\t\t\t\t\t\tstratum,",
					replacement: "\t\t\t\t\tObject.freeze({\n\t\t\t\t\t\tstratum: s,",
					why: "60cd1c28's bug: a slot group numbered by its stratum's index among the ChangeSet's strata, empty ones included, not by its position among the occupied ones, caught on the floor stream by a ChangeSet whose empty first stratum precedes an insert of Gen, a relation of this fixture's then."
				}
			]
		}
	)

/**
 * Normalization against the add-wins meaning refuses a planted fact no relation admits by its own fault, and admits
 * the ChangeSet without it.
 *
 * Budget: 200 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/normalize.test.ts:620 at 8cad5bce, its runs and its coverage's cases).
 */
export const normalizationAgainstTheAddWinsMeaningRefusesAPlantedFactNoRelationAdmitsByItsOwnFaultAndAdmitsTheChangeSetWithoutIt =
	property.explore(
		(source) =>
			[source.draw(array(memberGen, { min: 0, max: 2 })), source.draw(element(faults))] as const,
		{
			needs: {},
			budget: { runs: 200, steered: 100 },
			situations: faults satisfies ReadonlyArray<Reached<Fault>>,
			check:
				(_, c: Case<Fault>) =>
				([members, fault]) =>
					Effect.gen(function* () {
						c.note(fault)
						const plant = c.draw(plantedGen(fault))
						const prefix = yield* normalizingPrefix(members)
						const valid = stratumOf(prefix)
						refused((yield* normalizedOf(plant(valid))).result, faultOf(fault))
					}),
			oracle: { kind: "specification", name: "the fact shape each relation admits" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/identity.ts",
					original: "\tif (keys.value !== plan.fields.length) {",
					replacement: "\tif (keys.value < plan.fields.length) {",
					why: "A fact holding a field its relation lacks is admitted (scalar/values/identity.ts readFact counting too few keys only)."
				}
			]
		}
	)

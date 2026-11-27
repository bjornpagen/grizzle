/**
 * The law model decides each relation's unique objects beyond its primary key once, as it is built
 * (RelationLaws.beyond), comparing two guards by their predicates' canonical texts, each encoded once where its object
 * is built; and it specializes the schema once, over the theory whose containment evidence the plans' immediate laws
 * settle. Both are representation changes the decisions must survive unchanged.
 *
 * Each case draws a relation T's keys, each over its fields a and b, plain or over a selection of T by a conjunction of
 * `kind = j` and `flag = v` atoms, so keys share fields and guards in every arrangement: one subsuming another, two over
 * one selection and set of fields in two orders, none; and relations S whose `t` is contained, from every row or the
 * live ones, in K's key (K holds its key alone, so the reference is immediate), in T's or in an S's (each with a field
 * it does not reference, so deferred). A key over every fact is a candidate key, and no two of those share a set of
 * fields, which the schema refuses (schema/own.ts distinctKeys). The oracles: every relation's objects beyond its
 * primary key are those the decision restated here keeps, comparing two guards by encoding both, as it did before a
 * guard carried its canonical text; no two of a relation's unique objects hold each other, since two that would are
 * one key (ir/law.ts KeyColumnSet); and a containment's law is immediate, in the specialized model and in its
 * evidence, exactly when it is into K.
 *
 * Features: a guarded key subsumed, two keys over one set in two orders as one object, a key beyond the primary, an
 * immediate containment, a deferred containment.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { succeeded } from "#test/support/assert.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	type BeyondFeature,
	caseGen,
	restated,
	sameKeyInTwoOrders,
	schemaOf,
	subsumes
} from "#test/unit/laws/model/beyond-primary.fixtures.ts"

/** The objects beyond a primary key and the immediate laws are decided as before, once, by guards' canonical texts and the plans' immediate laws. Its budget is its suite's before it was a property (test/unit/laws/model/beyond-primary.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theObjectsBeyondAPrimaryKeyAndTheImmediateLawsAreDecidedAsBeforeOnceByGuardsCanonicalTextsAndThePlansImmediateLaws =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a guarded key subsumed",
			"two keys over one set in two orders, one object",
			"a key beyond the primary",
			"an immediate containment",
			"a deferred containment"
		] satisfies ReadonlyArray<Reached<BeyondFeature>>,
		check: (_, k: Case<BeyondFeature>) => (c) =>
			Effect.sync(() => {
				const owned = succeeded(ownedInput(schemaOf(c)))
				const model = succeeded(compileLaws(owned, { kind: "planned" }), "the schema compiles")
				for (const [name, laws] of model.relations) {
					const expected = restated(laws.uniques)
					assert.deepEqual(
						Arr.map(laws.beyond, (u) => u.name),
						Arr.map(expected, (u) => u.name),
						`${name}'s objects beyond its primary key`
					)
					const { others } = laws.uniques
					if (expected.length > 0) {
						k.note("a key beyond the primary")
					}
					if (Arr.some(others, (u) => u.kind === "guarded" && !expected.includes(u))) {
						k.note("a guarded key subsumed")
					}
					assert.ok(
						!Arr.some(others, (u, i) =>
							Arr.some(others, (w, j) => i < j && subsumes(w, u) && subsumes(u, w))
						),
						`no two of ${name}'s unique objects hold each other`
					)
				}
				if (
					Arr.some(c.keys, (x, i) => Arr.some(c.keys, (y, j) => i < j && sameKeyInTwoOrders(x, y)))
				) {
					k.note("two keys over one set in two orders, one object")
				}
				for (const e of model.theory.evidence.containments) {
					/** K holds its key alone and references nothing, so no reference into it is replaceable or on a cycle. */
					const immediate = e.to.relation === "K"
					assert.equal(
						model.immediate.has(e.law),
						immediate,
						`the containment of ${e.from.relation} in ${e.to.relation} is immediate exactly when it is into K`
					)
					assert.equal(
						e.context,
						immediate ? "immediate" : "committedSnapshot",
						"a containment's evidence context, the specialized model's verdict"
					)
					k.note(immediate ? "an immediate containment" : "a deferred containment")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the decision restated, two guards compared by encoding both; a containment immediate exactly when it is into K"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/uniques.ts",
				original: "\ta.relation === b.relation && a.predicate.id === b.predicate.id",
				replacement: "\ta.relation === b.relation",
				why: "laws/model/uniques.ts subsumes finds any two guards of one relation one guard (sameGuard compares no predicate)."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\treturn terms.reduce((held, t) => (rank(t) < rank(held) ? t : held))\n",
				replacement: "\treturn terms.reduce((held, t) => (rank(t) < rank(held) ? held : held))\n",
				why: "A selected side's first term is its guarded one (laws/model/plan.ts guardTerm), so two keys of one selection over its fields in two orders guard two columns and install two UNIQUEs that hold each other."
			}
		]
	})

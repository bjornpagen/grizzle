/**
 * An alternatives statement's laws (fin.md §7, R5): its expansion is pure and headless, one forward containment per arm
 * relation, `eq` for an arm of one handle and `in` for an arm of several, and one reverse containment per armed
 * handle; the theory states each as a containment law of source `alternatives`, and a containment the schema also
 * states itself is one law with both statements. The oracle is fin.md §7's expansion written as its own checker,
 * judged over every roster of at most four handles with every assignment of its handles to two arm relations or none.
 *
 * Features: one handle per arm, an arm of several handles, an unarmed handle, a restated containment.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { expandAlternatives, type StatementDesc } from "#compiler/ir/desc.ts"
import { assert } from "#test/support/assert.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import {
	alternativesSchema,
	assignment,
	containmentText,
	expectedContainments,
	type Feature
} from "#test/unit/analysis/theory/alternatives.fixtures.ts"
import { theoryOf } from "#test/unit/analysis/theory/support.ts"

/** Alternatives (fin.md §7) expands to its arms' containments, headless, each a containment law, a restated one merged. */
export const alternativesFinMd7ExpandsToItsArmsContainmentsHeadlessEachAContainmentLawARestatedOneMerged =
	property.exhaust(finite(assignment), {
		needs: {},
		situations: [
			"one handle per arm",
			"an arm of several handles",
			"an unarmed handle",
			"a restated containment"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, k: Case<Feature>) =>
			({ arms, restated }) =>
				Effect.sync(() => {
					const several =
						Arr.filter(arms, (a) => a === "A").length > 1 ||
						Arr.filter(arms, (a) => a === "B").length > 1
					k.note(several ? "an arm of several handles" : "one handle per arm")
					if (Arr.some(arms, (a) => a === undefined)) {
						k.note("an unarmed handle")
					}
					const desc = alternativesSchema(arms, restated)
					const statement = Arr.findFirst(
						decodedSchema(desc).statements,
						(s): s is Extract<StatementDesc, { readonly kind: "alternatives" }> =>
							s.kind === "alternatives"
					).pipe(Option.getOrElse(() => assert.fail("the schema states its alternatives")))
					const once = expandAlternatives(statement)
					const twice = expandAlternatives(statement)
					assert.deepEqual(once, twice, "the expansion is pure")
					const statedAs = (
						cs: ReadonlyArray<Extract<StatementDesc, { readonly kind: "contained" }>>
					): ReadonlyArray<string> =>
						Arr.sort(
							Arr.map(cs, (c) =>
								containmentText(
									c.left.relation,
									c.left.selection.conjuncts,
									c.right.relation,
									c.right.selection.conjuncts
								)
							),
							Order.String
						)
					assert.deepEqual(
						statedAs(once),
						expectedContainments(arms),
						"the expansion is fin.md §7's, with no head"
					)
					const t = theoryOf(desc)
					const laws = Arr.filter(t.laws, (law) => law.detail.kind === "containment")
					const lawsAs: ReadonlyArray<string> = Arr.sort(
						Arr.flatMap(laws, (law) =>
							law.detail.kind === "containment"
								? [
										containmentText(
											law.detail.from.relation,
											Arr.map(law.detail.from.selection.conjuncts, (c) => c.predicate),
											law.detail.to.relation,
											Arr.map(law.detail.to.selection.conjuncts, (c) => c.predicate)
										)
									]
								: []
						),
						Order.String
					)
					assert.deepEqual(lawsAs, expectedContainments(arms), "each containment is one law")
					assert.ok(
						Arr.every(
							laws,
							(law) => law.source.kind === "alternatives" && law.shape === "contained"
						),
						"each of source alternatives, of shape contained"
					)
					if (restated) {
						k.note("a restated containment")
						const merged = Arr.filter(laws, (law) => law.statements.length === 2)
						assert.equal(
							merged.length,
							1,
							"the restated containment is one law with both statements"
						)
					}
				}),
		oracle: { kind: "specification", name: "fin.md §7's expansion as a checker" },
		box: "every roster of 1 to 4 handles, each handle the arm of A, B or none, restated or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original:
					'\t\t\t\t: [{ kind: "contained", left: arm, right: discriminated(a, [first, ...rest]), loc: a.loc }]',
				replacement:
					'\t\t\t\t: [{ kind: "contained", left: arm, right: discriminated(a, [first]), loc: a.loc }]',
				why: "An arm of several handles is contained in its first handle's parents alone, `eq` where fin.md §7 states `in` (ir/desc.ts expandAlternatives)."
			}
		]
	})

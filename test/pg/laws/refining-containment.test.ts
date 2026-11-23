/**
 * A containment pairs fields of one base carrier, either side's type refining the other (scalar/compute/types.ts
 * sameCarrier): a refinement only narrows the values, so the inclusion is one law under the base's equality, the one a
 * foreign key between a domain and its base type compares natively and the judge reads. On PostgreSQL 19, over
 * RefiningContainment (refining-containment.fixtures.ts): four types of the base carrier int8, pg.bigint, natural, Low
 * (a contract over pg.bigint of the values at most 1, natural's sibling) and Unit (a contract over natural of the
 * values at most 1), and for each ordered pair of two of them a containment of a field of the first into a target's of
 * the second held by its foreign key, and one whose source is selected by a literal, held by the judge whole, every
 * relation immutable and keyed by its unit g first.
 *
 * Each case writes up to four states, each at a unit of its own in a transaction of its own: each type's target values
 * from -1 to 2 that its type admits, and some sources' rows, each a value its type admits and a kind, lawful ones
 * mostly, or a state aimed at one containment, its target holding or lacking the value its one row holds.
 *
 * Oracle: specification, the laws' meaning turned into a checker (refining-containment.fixtures.ts brokenBy): each
 * foreign-key pair held by its foreign key and each judged pair by the judge alone, and a state commits exactly when no
 * held row of a source, every row of a foreign key's and a judged source's of kind 1, has a value its target lacks,
 * refused otherwise with 23503 under a containment it breaks, through the installation's constraint map.
 *
 * Features: a committed state; a refusal at a foreign key and by the judge; a refinement committed into its base, a base
 * into its refinement and a contract into a sibling; a row its selection leaves out committed outside its target.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	type RefiningFeature,
	refiningTemplate,
	relations,
	runRefining,
	space
} from "#test/pg/laws/refining-containment.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Containments across refining types of one base carrier are installed, each a foreign key or the judge, and commit
 * exactly the states whose held source rows find their values in their targets.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const containmentsAcrossRefiningTypesOfOneBaseCarrierAreInstalledAndCommitExactlyTheStatesWhoseHeldSourceRowsFindTheirValuesInTheirTargets =
	property.explore(space, {
		needs: { fresh: Substrate.fresh(refiningTemplate) },
		situations: [
			"committed",
			"refused at a foreign key",
			"refused by the judge",
			"a refinement committed into its base",
			"a base committed into its refinement",
			"a contract committed into a sibling",
			"a row its selection leaves out committed outside its target"
		] satisfies ReadonlyArray<Reached<RefiningFeature>>,
		check:
			({ fresh }, c: Case<RefiningFeature>) =>
			(states) =>
				Effect.gen(function* () {
					const taken = yield* fresh
					const seat = yield* seatIn(taken, relations, "refining_containment")
					yield* runRefining(seat, states, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the laws' meaning: each pair held by its foreign key or the judge alone, and a state commits exactly when no held source row has a value its target lacks, refused otherwise with 23503 under a containment it breaks"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\t\t\t\t\tk.tracked,\n\t\t\t\t\t\tsameCarrier,\n",
				replacement: "\t\t\t\t\t\tk.tracked,\n\t\t\t\t\t\tcompatible,\n",
				why: "A containment pairs fields of one nominal identity, as a family does: every containment of the schema, of two types of one base carrier, is refused as the sides' field types differing, so the template installs nothing and no case runs."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tif (!sameCarrier(region.type, col.type)) {",
				replacement: "\t\tif (!compatible(region.type, col.type)) {",
				why: "A negated column correlates only with a region column of its nominal identity: the judge's violation query of a containment of two types, its target's anti-join bound to its source's terms, is refused as operands of one type, so the template installs nothing and no case runs."
			}
		]
	})

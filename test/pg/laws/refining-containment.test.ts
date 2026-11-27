/**
 * A containment pairs fields of one base carrier, either side's type refining the other (scalar/compute/types.ts
 * sameCarrier): a refinement only narrows the values, so the inclusion is one law under the base's equality, the one a
 * foreign key between a domain and its base type compares natively, the judge's anti-join correlates, and a probe's
 * equality types at the carrier, either side standing for the other retyped where navigation substitutes it
 * (ir/desc.ts RetypeDesc). On PostgreSQL 19, over RefiningContainment (refining-containment.fixtures.ts): four types of
 * the base carrier int8, pg.bigint, natural, Low (a contract over pg.bigint of the values at most 1, natural's sibling)
 * and Unit (a contract over natural of the values at most 1), each a target keyed by its unit g first and open in the
 * unit G, and for each ordered pair of two of them three containments of a field of the first into the second's: one
 * held by its foreign key, one whose source is selected by a literal, held by the judge whole, and one into the
 * second's values at every unit, a derived relation no unit holds, held by the judge's probes, both the gained side's
 * negated correlation and the lost side's positive read of the source at a lost row.
 *
 * Each case writes up to four states, each at a unit of its own in a transaction of its own: each type's target values
 * from -1 to 2 that its type admits, some sources' rows, each a value its type admits and a kind, lawful ones mostly,
 * and now and then a target row of an earlier unit deleted; or states aimed at one containment, its target holding or
 * lacking the value its one row holds, or at a probe's reach across units, a value another unit holds and then loses.
 *
 * Oracle: specification, the laws' meaning turned into a checker over the database a state leaves
 * (refining-containment.fixtures.ts brokenIn): each pair held by its own discharge alone, and a state commits exactly
 * when no held row of a source, every row of a foreign key's and a probe's and a judged source's of kind 1, lacks its
 * value in its target, at its unit, or for a probe's at any unit, refused otherwise with 23503 under a containment it
 * breaks, through the installation's constraint map.
 *
 * Features: a committed state; a refusal at a foreign key, by the judge and by a probe; a refinement committed into its
 * base, a base into its refinement and a contract into a sibling; a row its selection leaves out committed outside its
 * target; a probed value found at another unit; a target row dropped, and a lost one refused.
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
			"refused by a probe",
			"a probed value found at another unit",
			"a refinement committed into its base",
			"a base committed into its refinement",
			"a contract committed into a sibling",
			"a row its selection leaves out committed outside its target",
			"a target row dropped",
			"a lost target row refused"
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
			name: "the laws' meaning over the database a state leaves: each pair held by its own discharge alone, and a state commits exactly when no held source row lacks its value in its target, refused otherwise with 23503 under a containment it breaks"
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
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\t: { kind: "retype", to: to.desc, arg: term }',
				replacement: "\t\t: term",
				why: "A probe's guard binds the written relation's variable at the guarded relation's field of another refining type as it is, without the retype its equality proves: the checker refuses it as operands of one type, so the template installs nothing and no case runs."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					"\t\treturn this.restate(arg, to, arg.actual, Object.freeze({ ...arg.facts, ...factsOfType(to) }))",
				replacement: "\t\treturn this.castTo(arg, to, at)",
				why: "A retype prints as a runtime cast into its target's domain, which no bound proves where only the equality does: the cast is refused as a partial operation, so the template installs nothing and no case runs."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\tif (!meets(against, term.nominal) && !refinedPair(against, term.nominal)) {",
				replacement: "\t\tif (!meets(against, term.nominal)) {",
				why: "An equality between two refinements of one base carrier is refused as any comparison of two types is: a probe's equality of a lost row's value with the source's field, its navigated import's head with the term it is met at, is refused, so the template installs nothing and no case runs."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tif (!sameCarrier(region.type, col.type)) {",
				replacement: "\t\tif (!compatible(region.type, col.type)) {",
				why: "A negated column correlates only with a region column of its nominal identity: the judge's violation query of a containment of two types, its target's anti-join bound to its source's terms, is refused as operands of one type, so the template installs nothing and no case runs."
			}
		]
	})

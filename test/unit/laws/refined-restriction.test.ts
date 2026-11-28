/**
 * A check over a derived rule that equates a contract's field with Type.base of a natural, `r.eq(stage,
 * Type.base(number))`, beside a union of rules that delivers the contract at that stage, compiles to its installation
 * (analysis/theory/navigate.ts Navigator #defined): a variable an inlined import binds is defined by the import's own
 * head term for its column, of the column's type. Defined by the first equality of it, the judge's probe of an
 * assignment restricted the limits' union inside to the stage the rule equates with the written number's base
 * (`boundInside`) and defined the union's stage by that base, so the union delivered its Stage column as a bigint, and
 * the checker refused the step that reads Budget at it ("operands of one type: the variable bound to parameter via0.1
 * is bigint, stage is contract …"), a schema the builders and the types admit: metis's FirstBudget at
 * delivery/src/level.ts:298-310, its timing limits a union of three rules, refused on grizzle 1b28f756 and on main
 * 52e6155af.
 *
 * Property: over every case, the schema compiles to its installation.
 *
 * The box: Assignment(child, number: natural), Budget(child, stage: Stage, remaining) and Limit(number, seconds),
 * Stage a contract over pg.bigint as qti-pie's SittingKey is; each assignment's sitting at the stage its number casts
 * into Stage under the contract's key; the limits, a union of one or two rules over the sittings; First, each budget
 * beside its limit where its stage is the assignment's number, the equality written `stage = base(number)`, `base(number)
 * = stage` or `base(stage) = base(number)`, and a check of First. metis's shape, the first equality over a union of two
 * rules, is a case of the box.
 *
 * Oracle: the builders' admission, a schema schema.extend builds compiles to its installation.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, judged } from "#test/unit/laws/refined-restriction.fixtures.ts"

/** A check over a rule equating a contract's field with a natural's base, beside a union delivering the contract, compiles. */
export const aCheckOverARuleEquatingAContractsFieldWithANaturalsBaseBesideAUnionDeliveringTheContractCompiles =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"stage = base(number)",
			"base(number) = stage",
			"base(stage) = base(number)",
			"a union of one rule",
			"a union of two rules",
			"metis's first budget"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c) => (drawn) => Effect.sync(() => judged(drawn, (f) => c.note(f))),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its installation"
		},
		box: "First over Budget, the timing limits' union of one or two rules and Assignment, its Stage equated with the number's base by each spelling, checked",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\tconst definition = definitionAmong((w) => flat.equations.has(w)) ?? definitionAmong(() => true)\n",
				replacement: "\t\tconst definition = definitionAmong(() => true)\n",
				why: "A variable an inlined import binds is defined by the first equality of it, as before: the limits' union, restricted to the stage the rule equates with the written number's base, delivers its Stage column as that bigint, and the checker refuses the judge's step that reads Budget at it; the property fails at metis's first budget."
			}
		]
	})

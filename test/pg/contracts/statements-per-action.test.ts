/**
 * C6, statements per action bounded by its shape: a call sends its Db's prologue (the ledger's fence and the snapshot's
 * guard), one statement per stratum its program orders and one fill per binding it carries past its stratum, a read one
 * statement in all, and nothing else (wire-laws.ts statementsPerAction): no stand-up past a session's first call of a write,
 * no carrier emptying, no delta bookkeeping (edullm's start, 130 top-level statements against a shape of 18). The bound
 * is the shape's, computed from the program (wire-laws.ts strataCount, carriedCount), never measured.
 *
 * Oracle: the wire (test/support/wire-tap.ts), every statement a write's second call on its session executes.
 *
 * Space: drawn shapes (shapes.ts), aimed, where no witness has yet, at a two-strata write (`strataShapeGen`), which a
 * drawn shape reaches only where one of its members draws a parent.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { type ShapeSketch, shapeGen } from "#test/pg/contracts/shapes.ts"
import { statementsPerAction } from "#test/pg/contracts/wire-laws.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A shape whose write runs in two strata: a member keyed by (doc, k0) and a child of it, which the write's second
 * stratum inserts after its parent's (shapes.ts strataOf), each read by its document.
 */
const strataShapeGen: Gen<ShapeSketch> = (source) => ({
	members: [
		{
			keys: 1,
			values: source.draw(element([1, 2] as const)),
			mutable: source.draw(boolean),
			parent: Option.none()
		},
		{
			keys: source.draw(element([1, 2] as const)),
			values: source.draw(element([1, 2] as const)),
			mutable: source.draw(boolean),
			parent: Option.some(0)
		}
	],
	derived: [],
	reads: [
		{
			relation: { kind: "member", at: 0 },
			byKey: source.draw(boolean),
			via: "param",
			stated: "match"
		},
		{
			relation: { kind: "member", at: 1 },
			byKey: source.draw(boolean),
			via: "param",
			stated: "match"
		}
	],
	content: false,
	globalKey: false
})

/** A call sends its prologue, a statement per stratum and a fill per carried binding, and nothing else. */
export const aCallSendsItsPrologueAStatementPerStratumAndAFillPerCarriedBinding = property.explore(
	aimed(shapeGen, [["a two-strata write", strataShapeGen]] as const),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["a carried binding", "a two-strata write"] satisfies ReadonlyArray<
			Reached<ContractFeature>
		>,
		check:
			({ substrate }, c: Case<ContractFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						contractCase(
							s,
							c.note,
							(_, o) => statementsPerAction(o),
							"each call sends what its shape needs"
						)
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: { kind: "postgresql", name: "the wire: every statement a call executes" },
		budget: { runs: 8, steered: 8 },
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/served.ts",
				original:
					'\t\t\tcompiled.readBacks.filter((read) => read.carried.kind === "sent").length,\n',
				replacement:
					'\t\t\tcompiled.readBacks.filter((read) => read.carried.kind === "sent").length +\n\t\t\t1,\n',
				why: "The compiler states one statement more than a call sends: every write's stated count is off its wire."
			}
		]
	}
)

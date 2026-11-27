/**
 * C3, keyed reach, the binding stated by a where (SIP's acceptance): a read whose binding is stated as a where over the
 * relation's own variables, `doc` equated to a parameter or to the document of the row of Owner a parameter keys, and
 * `k0` to a parameter, means what the same binding stated in the match means, and carries every column it binds into
 * the leading run of an index of every relation it scans, through every derivation (laws.ts keyedReach). The where's
 * equality between the relation's `doc` and the row in hand's is a key of rows in hand, as a match's shared variable
 * is: the bound is the keyed read's O(k log n), whichever way the read states it.
 *
 * Oracle: PostgreSQL's generic plan of every statement a call sends (observed.ts), each scan's index condition read
 * against the leading run of the index it reads (copies.ts indexesOf).
 *
 * Space: drawn shapes (shapes.ts whereShapeGen), each read's binding stated in its match or by a where.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { keyedReach } from "#test/pg/contracts/laws.ts"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { whereShapeGen } from "#test/pg/contracts/shapes.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A read binding stated by a where carries every column it binds into every scan, as the binding stated in its match does. */
export const aBindingStatedByAWhereCarriesEveryColumnItBindsIntoEveryScan = property.explore(
	whereShapeGen,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a binding stated by a where over a live derivation",
			"a document a row in hand binds",
			"a live derived relation read"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check:
			({ substrate }, c: Case<ContractFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						contractCase(s, c.note, keyedReach, "every scan carries the binding the where states")
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's generic plan of every statement a call sends, each scan's index condition against the leading run of its index"
		},
		budget: { runs: 48, steered: 48 },
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original:
					"\treturn new Set(o.bindings.map((b) => classOf(b.var)).filter((c) => !read.has(c)))\n",
				replacement:
					"\treturn new Set(o.bindings.map((b) => b.var.id).filter((c) => !read.has(c)))\n",
				why: "A variable a where equates to a row in hand's is bound by its own occurrence alone, as before: Owner stays a join operand, and the live derivation it reaches is the statement's CTE, its member scanned with its document unbound."
			}
		]
	}
)

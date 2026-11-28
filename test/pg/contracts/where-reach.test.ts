/**
 * C3, keyed reach, the binding stated by a where (SIP's acceptance): a read whose binding is stated as a where over the
 * relation's own variables, `doc` equated to a parameter or to the document of the row of Owner a parameter keys, and
 * `k0` to a parameter, means what the same binding stated in the match means, and carries every column it binds into
 * the leading run of an index of every relation it scans, through every derivation (laws.ts keyedReach). The where's
 * equality between the relation's `doc` and the row in hand's is a key of rows in hand, as a match's shared variable
 * is: the bound is the keyed read's O(k log n), whichever way the read states it.
 *
 * Oracle: the plan laws over every call's flight (laws.ts keyedReach, test/support/advice.ts lawsOver): PostgreSQL's plan
 * of every statement a call sends under the advice its Db's frame held (observed.ts), each scan found by its target and
 * bound by every column the where binds.
 *
 * Space: drawn shapes (shapes.ts whereShapeGen), each read's binding stated in its match or by a where.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
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
			name: "PostgreSQL's plan of every statement a call sends under the advice its frame held: the plan laws, and each scan's binding by its target against the where's"
		},
		budget: { runs: 48, steered: 48 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/contracts/where-reach.test.ts#aBindingStatedByAWhereCarriesEveryColumnItBindsIntoEveryScan:7.1:1.0.0.0.0.0.0.0.1.0.1.0.0.1.0.1.0.0.0.0.0.0.0.0.0.1.0.0.0"
				),
				reason:
					"a live join of the first member with itself and a negation, read at the document a row of Owner names: the statement's MATERIALIZED CTE, read once per row of Owner, its scans of M0 binding no doc (lane REDS7's census of main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: []
	}
)

/**
 * C3, keyed reach (PIN 3's demand-driven restriction, claims-scoped reads its first case): every scan of a keyed
 * relation carries in its index condition every key column the read binds, through every derivation between the read
 * and the relation (laws.ts keyedReach). A read of k rows of a relation of n reads O(k log n) pages exactly where each
 * of its scans descends an index by every column the read fixes; a scan that leaves one out reads the rows of every
 * value of it, a number that grows with the population, as edullm's home read every assignment's status (8,683,161
 * pages at its 1x bar, its bound about 300).
 *
 * The claim is the model's of each read (shapes.ts askedOf), its binding reaching every occurrence of a member in a live
 * derived relation's definition, a negation's among them, and the stored table of a stored one, and the binding of
 * every scan a write makes, which its plan states (Law 2: each column a read binds an index condition of its scan). The
 * oracle is the plan laws over every call's flight (test/support/advice.ts lawsOver): PostgreSQL's plan of every
 * statement a call sends under the advice its Db's frame held (observed.ts), as installed and replanned at scale
 * (observed.ts atScale), sizes that straddle every cost tie between a few pages and millions of rows, each scan found by
 * its target, its index condition read off EXPLAIN (VERBOSE).
 *
 * Space: drawn shapes (shapes.ts): a unit's members, derived relations over them and over each other, published content
 * read through its fact, and writes in one stratum, in two and with a carried binding.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { keyedReach } from "#test/pg/contracts/laws.ts"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { shapeGen } from "#test/pg/contracts/shapes.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Every scan of a keyed relation in every statement a call sends binds every key column the call binds of it. */
export const everyScanOfAKeyedRelationBindsEveryKeyColumnTheCallBindsThroughEveryDerivation =
	property.explore(shapeGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a live derived relation read",
			"a stored derived relation read",
			"two aliases of one definition",
			"a read that binds k0",
			"a document a row in hand binds",
			"a key of k0 alone",
			"a two-strata write",
			"published content read through its fact"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check:
			({ substrate }, c: Case<ContractFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						contractCase(s, c.note, keyedReach, "every scan binds every key column the call binds")
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plan of every statement a call sends under the advice its frame held, as installed and replanned at scale: the plan laws, and each scan's binding by its target against the read's model"
		},
		budget: { runs: 16, steered: 16 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/contracts/keyed-reach.test.ts#everyScanOfAKeyedRelationBindsEveryKeyColumnTheCallBindsThroughEveryDerivation:ff.0:1.0.0.0.0.0.0.0.2.1.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.1.1.0.1"
				),
				reason:
					"the stored union of the first member with itself read at k0 and at the document a row of Owner names: its chain led by its read at k0, a key, which determines doc, where the law knew members' keys alone (lane REDS7's census of main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: []
	})

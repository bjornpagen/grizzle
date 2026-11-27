/**
 * C3, keyed reach (PIN 3's demand-driven restriction, claims-scoped reads its first case): every scan of a keyed
 * relation carries in its index condition every key column the read binds, through every derivation between the read
 * and the relation (laws.ts keyedReach). A read of k rows of a relation of n reads O(k log n) pages exactly where each
 * of its scans descends an index by every column the read fixes; a scan that leaves one out reads the rows of every
 * value of it, a number that grows with the population, as edullm's home read every assignment's status (8,683,161
 * pages at its 1x bar, its bound about 300).
 *
 * The claim is the model's of each read (shapes.ts askedOf), its binding reaching every occurrence of a member in a live
 * derived relation's definition, a negation's among them, and the stored table of a stored one, and the plan-local
 * binding of every scan a write makes (plan-bindings.ts): each member's key columns its plan offers it, the keys of the
 * facts the write holds. The
 * oracle is PostgreSQL's generic plan of every statement a call sends, as the session holds it (observed.ts), its index
 * conditions read off EXPLAIN (VERBOSE), at the sizes as installed and again with every table at scale (observed.ts
 * atScale), sizes that straddle every cost tie between a few pages and millions of rows.
 *
 * Space: drawn shapes (shapes.ts): a unit's members, derived relations over them and over each other, published content
 * read through its fact, and writes in one stratum, in two and with a carried binding.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
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
			name: "PostgreSQL's generic plan of every statement a call sends, as installed and at scale, its index conditions against the read's binding and each scan's offered key"
		},
		budget: { runs: 16, steered: 16 },
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\tif (taken.includes(c)) {",
				replacement: "\t\tif (taken.includes(c) || shape.unit.includes(c)) {",
				why: "The unit's lead declared no anchor: its field holds a few values at any size, so PostgreSQL prices a read by the unit at a share of the table and plans it by a scan of every document's rows, its index condition binding nothing the read binds."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: '\t\t\t\t\t\tkind: "relative",',
				replacement: '\t\t\t\t\t\tkind: "absolute",',
				why: "Each anchor declared a number of distinct values that holds at one size alone, as a sample's would: at a table's few installed pages a probe of it finds a row or two, and at a million rows a share of the table, which PostgreSQL reads by a scan, its index condition binding nothing the read binds; the plans at scale leave the bound, those as installed keep it."
			}
		]
	})

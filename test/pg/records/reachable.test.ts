/**
 * Records retired by reachability on PostgreSQL 19: over drawn queries of Shelves (attached.fixtures.ts, at depths one
 * to three and every delivery, an arm's among them) and drawn facts of Shelves, the query's rows stored as records keyed
 * by their digest alone, `records("Kept", query, { digest: sha256 }, ["digest"])`, at every key a holder names and at
 * one no holder names where the case draws it; holders, each a body of a retirable unit naming a key, as a drawn
 * layout places them: Ref alone, Root's body; Ref and Cite, both Root's; or Ref, Root's, and Cite, the body of Batch, a
 * unit of its own; each holder row drawn, a root naming a key as often as it likes; and
 * `reachable(on(records, "digest"), holders)`. Then a drawn sequence of retirements, each of a drawn set of groups of
 * the units, one served call each.
 *
 * (a) References left: a retirement that leaves some holder row naming a key, of its own relation, of another relation
 * or of another unit, keeps the key's rows. (b) The last reference: a retirement that removes the last holder row naming
 * a key removes the key's rows from every relation of the records, at every depth, in its own call, and counts each as a
 * delete of its relation. A key no holder ever named stays.
 *
 * Oracle: a model of the holders (reachable.fixtures.ts modelOf): after each retirement, each relation of the records
 * holds exactly its rows at the keys the model keeps; the call's outcome is the model's, its nonzero counts each group
 * retired anew a put of its header, each holder row removed a delete of its relation, and each released row a delete of
 * its relation of the records; and at the end every kept key's records read back exactly the rows the query delivered
 * (test/support/equivalence.ts exactValue).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ReachableFeature,
	reachableCase,
	reachableCaseGen
} from "#test/pg/records/reachable.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A retirement keeps the records of every key some holder row still names, and releases the records of every key it
 * leaves no holder row naming from every relation of them.
 *
 * Budget: 40 runs and 120 steered cases. Each case drafts, certifies and installs a schema of its own, seconds apiece,
 * so the runner's 150 runs ran past an hour on the shared cluster (2026-11-22); the steered phase ends at its last
 * situation.
 */
export const aRetirementKeepsTheRecordsOfEveryKeyAHolderStillNamesAndReleasesEveryOtherKeyItTookTheLastHolderOfFromEveryRelationOfTheRecords =
	property.explore(reachableCaseGen, {
		needs: { substrate: Substrate.fresh },
		budget: { runs: 40, steered: 120 },
		situations: [
			"kept by a holder of its retired holder's own relation",
			"kept by another relation's holder alone",
			"kept by another unit's holder alone",
			"released after an earlier retirement kept it",
			"released by retiring several of its groups at once",
			"released though one group named it twice",
			"released by Batch's retirement",
			"released with rows below the root",
			"released at depth three",
			"released with an arm's rows",
			"an unheld key kept beside a release"
		] satisfies ReadonlyArray<Reached<ReachableFeature>>,
		check:
			({ substrate }, notes: Case<ReachableFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.map(reachableCase(c), (reached) => {
							for (const feature of reached) {
								notes.note(feature)
							}
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a model of the holders: a key's records stay while a holder row names it or no holder ever did, and go from every relation of them with the retirement of its last holder row, counted as its deletes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original: "\t\t\t\tand(unheld)",
				replacement: "\t\t\t\tundefined",
				why: "The release takes every candidate key, ignoring holder rows outside the retired groups (physical/ddl/retire.ts releaseOf rR), so a key another root, relation or unit still names is deleted and its holder's foreign key refuses the retirement."
			},
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original: "\t\t\twhere: fieldsAt(b, r.carried, row, at),",
				replacement: "\t\t\twhere: lit.bool(false),",
				why: "No release: the retirement removes its holder rows and leaves the records of a key it took the last holder of in every relation."
			},
			{
				file: "packages/engine/src/physical/ddl/retire.ts",
				original: "\tconst removals = release.records.map((r): Cte => {",
				replacement: "\tconst removals = release.records.slice(0, 1).map((r): Cte => {",
				why: "The release deletes the records' root alone, so their attachments' rows at a released key stay or refuse the root's deletion, and the counts lack them."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\treachable: S.located(",
				replacement: "\treachable_: S.located(",
				why: "A schema description holding a reachable statement does not decode (ir/desc.ts statementDescShape), so an installation drafted from one is refused."
			}
		]
	})

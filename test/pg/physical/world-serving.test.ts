import { assert } from "@bjornpagen/testing/assert"
/**
 * Every world function is index-served: an existence test bound to its arguments, judged by PostgreSQL's serving judge
 * (world-serving.ts, serving.ts), over generated role schemas, each case's population of a drawn small size.
 *
 * A case draws a documents base, the roles the worlds model's generator draws over it (installGen), and one or two
 * witnesses, each a role writing a query entry over a relation T filtered by a link into another source (world-serving.ts
 * LinkWitness), so every situation below is reached by construction: a witness's filter function, called at its linked
 * source's middle row, probes the source at values it holds, and at values no row holds probes it in vain; its key
 * probes read T at a key it holds and at one it does not; its policy row calls the filter function under row security;
 * its read by key through the role's view of the entry, as a workload program over the role reads it, calls the
 * filter function at the row it finds; and its precheck calls the filter function and every probe. The witness's arm
 * chooses what its link reads: an ordinary relation, the derived relation, or an ordinary relation a declared key
 * reads, such as Share under the base's one-share variant, `key(on(Share, "doc"))`, whose probe is that key's key probe: UniqueObjects.keys holds
 * every declared key beside the primary key (laws/model/uniques.ts uniqueOf, "A UNIQUE over a declared candidate key's
 * fields in its order is that key's"), and a unique probe is only an object's beyond the keys, which
 * no documents base holds: pg/write/entry-occupants covers it, at its key over a selected side,
 * `key(on(select(Seat, lead), "grp"))`. Its link may bind a second field of the source,
 * to another field of T or to a context's claim, as the documents base's notes bind their document's
 * organization to the tenant's (test/support/worlds/model/bases/docs.ts), so a probe binds what the row and the claim fix together. The joined arm binds it to a field of a third
 * source that another field of T links into, `T ⋈ Y{to: T.from} ⋈ X{to: T.from2, h: Y.g}`, so X's probe binds what
 * the row and Y fix together: the row is one fact, which binds every probe of what it joins, so X is served by one
 * index of both fields rather than read by one and rechecked on the other. Every world function of the drawn roles'
 * writable entries is judged beside them, at T's middle row and at no row.
 *
 * Each case draws how many facts each relation holds, at most the least population at which every spread field of the
 * load holds two values (mostRows), so its load, one SERIALIZABLE transaction, stays small beside its neighbours'. With
 * sequential and bitmap scans disabled, over relations PostgreSQL plans unanalyzed (test/support/plans.ts unanalyzed),
 * the judge's structural verdicts stand at any size: a lowering that deduplicates each relation a filter reads, which
 * PostgreSQL cannot pull into its join, reads that relation's index with no index condition, and the judge names the
 * scan. Analyzed statistics of a small load decide a plan by its rows: at forty facts a relation, a role's read of Doc
 * by its key through its view merged Doc's row with the whole of Org's one-page primary key, which cost less than a
 * descent into it. Unanalyzed estimates decide a read through a view by their defaults alike, at any size: how the view
 * joins the membership to T's row is PostgreSQL's cost choice, a merge join over an index read whole among them, so
 * the read holds T's scans to the serving rules and the membership's to a planned index, whose reads by index at T's
 * row the filter function's body is judged on (world-serving.ts ScanOf). What only volume shows, a scan's buffers far
 * past its bound and an index PostgreSQL prefers by its cost, is no property here; that every created index is needed
 * is test/pg/physical/serving.test.ts's.
 *
 * Features: every situation the witnesses reach by construction (see above).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { caseGen, requiredSituations } from "#test/pg/physical/world-serving.fixtures.ts"
import { judgeCase, type WorldServingFeature } from "#test/pg/physical/world-serving.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every world function of generated roles reads by its indexes, over drawn small populations, each case installing its
 * roles' schema on the worker's clone, as each case of the search installed its own. The search's four kept cases were
 * the judge's reds, never grizzle's, each fixed in world-serving.ts alone (da3549b62: a precheck's calls planning their
 * bodies at the call, and a claimed read PostgreSQL drove through Note's index on doc; 14e73e8c5: a view whose rule
 * fixes a key field by a claim; 8906b5c58: a read through a view unique-ifying Note through its index read whole), so
 * they go with this conversion.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/physical/world-serving.test.ts at 22b809827).
 */
export const everyWorldFunctionOfGeneratedRolesReadsByItsIndexesOverDrawnSmallPopulations =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: requiredSituations satisfies ReadonlyArray<Reached<WorldServingFeature>>,
		check:
			({ substrate }, cx: Case<WorldServingFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const problems = yield* judgeCase(c.world, c.rows, cx.note)
							assert.deepEqual(problems, [], "every world function call reads by its indexes")
						})
					),
					Substrate,
					substrate
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's serving judge: each world function call reads by its indexes"
		},
		show: Formatter.format,
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})

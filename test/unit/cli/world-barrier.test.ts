/**
 * A role's world relation is a security barrier view (physical/ddl/roles.ts worldView), which PostgreSQL never flattens
 * into a reader and passes only the reader's leakproof quals (allpaths.c qual_is_pushdown_safe), so a reader's leaky
 * equality, a numeric's, a range's, a tsvector's or a vector's, is applied above it: the access extraction reads the
 * view as its statement reads it (physical/access/extract.ts WorldView, throughBarrier), its definition at the quals
 * the barrier passes, by the one rule the missed-index check applies at the view (physical/access/seeks.ts
 * leakyEquality), so what it asks and what the statement seeks agree. The bound: a read of k rows through the view at a
 * binding an index's leading run holds is O(k log n); with none it reads every row of Shop.
 *
 * The box: Shop(region, amount numeric(5, 2), n integer), keyed by (amount, region) or by (region, amount); one role
 * reading Shop through its query entry Mine, Shop's facts of region 1, a literal, and none whole; the login `app`
 * serving reads through Mine at a value of amount, of n, or of both.
 *
 * Oracle: the specification. Generate serves every read at the installation it drafts: its missed-index check, which
 * holds the leaky amount above the barrier, finds each read's seek of Shop at region, beneath the view, and at n where
 * the read binds it, served.
 *
 * Features: a leaky equality held above the barrier where Shop's key leads with it, and where it leads with region; a
 * leakproof one passed into the view.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, drafted } from "#test/unit/cli/world-barrier.fixtures.ts"

type Feature =
	| "a leaky equality held above the barrier where the key leads with it"
	| "a leaky equality held above the barrier where the key leads with region"
	| "a leakproof equality passed into the view"

/** Every read through a world view is served at the indexes generate drafts for what it seeks beneath the barrier. */
export const aReadThroughAWorldViewIsAskedAsWhatItSeeksBeneathTheBarrier = property.explore(
	caseGen,
	{
		needs: {},
		situations: [
			"a leaky equality held above the barrier where the key leads with it",
			"a leaky equality held above the barrier where the key leads with region",
			"a leakproof equality passed into the view"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 16, steered: 32 },
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				const d = yield* drafted(c)
				assert.equal(
					d.refusal,
					undefined,
					"generate serves every read at the installation it drafts"
				)
				for (const read of c.reads) {
					if (read === "byN" || read === "byBoth") {
						notes.note("a leakproof equality passed into the view")
					}
					if (read === "byAmount" || read === "byBoth") {
						notes.note(
							c.key === "amount first"
								? "a leaky equality held above the barrier where the key leads with it"
								: "a leaky equality held above the barrier where the key leads with region"
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each read's seek of Shop beneath the barrier, at region and at n where it binds it, never at the leaky amount, served at the installation generate drafts"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/cli/world-barrier.test.ts#aReadThroughAWorldViewIsAskedAsWhatItSeeksBeneathTheBarrier:7.0:0.0.0"
				),
				reason:
					"a read of Mine at amount, Shop keyed (amount, region): the extraction inlined Mine's definition and pushed the leaky amount into it, a lookup of the key, where the statement's barrier holds amount above the view and seeks Shop at region, which no index led with, so generate refused the read as a missed index",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\tmapPushed(pushed, (c) => (view.leaky.has(c) ? undefined : c))\n",
				replacement: "\tmapPushed(pushed, (c) => c)\n",
				why: "A reader's leaky equality is pushed past the barrier into the view's definition: a read of Mine at amount, Shop keyed (amount, region), is asked as a lookup of the key, and the statement, whose barrier holds amount above it, seeks Shop at region, which no index leads with, so generate refuses the read as a missed index."
			}
		]
	}
)

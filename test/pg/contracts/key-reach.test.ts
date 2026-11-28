/**
 * C3, keyed reach, read by a key alone (edullm's Q01 and Q05, reduced): a read that binds a unit's members by `k0`
 * alone, its `doc` left to what `k0` determines, carries `k0` in the leading run of an index of every relation it scans,
 * through every derivation (laws.ts keyedReach): metis's home read matched AssignmentStatus, a live union of
 * negations over every assignment's events, by its number alone, a key of Assignment, and read every assignment's
 * status, 253,838 pages of 8.7 million for one child's row (Q01's r37); submit's duration reached test_moment by its
 * stage, a key of a sitting, without its child, through test_moment's (child, stage, at) index alone, and scanned the
 * table 34 times, 367,166 pages (Q05). The bound is the keyed read's O(k log n): the read's rows are the rows at the key,
 * and every scan descends to them by it, a member read at a key of `k0` alone (the first member's, `globalKey`) at its
 * one row, the rest at the document that row names, or through an index leading with `k0`.
 *
 * Oracle: the plan laws over every call's flight (laws.ts keyedReach, test/support/advice.ts lawsOver), PostgreSQL's
 * plan of every statement a call sends under the advice its Db's frame held, as installed and replanned at scale
 * (observed.ts): the plan it makes is the one the call carries, every column a read binds an index condition of its
 * scan (Law 2), and every scan of a member the model reads by `k0` binds it, or a whole key.
 *
 * Space: drawn shapes (shapes.ts keyShapeGen), reads binding `k0` alone among them, the first member keyed by `k0`
 * alone half the time; aimed, where no witness has yet, at a live derivation read by its key alone (shapes.ts
 * liveKeyReadGen), which few drawn shapes reach.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { keyedReach } from "#test/pg/contracts/laws.ts"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { keyShapeGen, liveKeyReadGen } from "#test/pg/contracts/shapes.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Every scan of a read by a key alone carries the key in the leading run of an index it reads, through every derivation. */
export const aReadByAKeyAloneCarriesTheKeyIntoEveryScanThroughEveryDerivation = property.explore(
	aimed(keyShapeGen, [["a live derivation read by its key alone", liveKeyReadGen]] as const),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a live derivation read by its key alone",
			"a key of k0 alone",
			"a live derived relation read"
		] satisfies ReadonlyArray<Reached<ContractFeature>>,
		check:
			({ substrate }, c: Case<ContractFeature>) =>
			(s) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						contractCase(s, c.note, keyedReach, "every scan carries the key the read binds")
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
					"test/pg/contracts/key-reach.test.ts#aReadByAKeyAloneCarriesTheKeyIntoEveryScanThroughEveryDerivation:-:0.1.0.0.1.0.0.0.0.0.0.2.0.0.0"
				),
				reason:
					"edullm's Q05 reduced (SIP2's red at e42937e8b): M0 keyed (doc, k0, k1) in unit Doc, read0 reading it by k0 alone, as submit's duration read test_moment by its stage without its child. The engine asked M0 (k0) and appended doc for its stored derivation's upkeep, (k0, doc); the declaration priced k0 at a share of the table, a member's column no fact scopes, and PostgreSQL read M0's key in its (doc, k1) order beside a filter, as test_moment was scanned 34 times, 367,166 pages. k0 now leads (k0) alone, an anchor paired with doc, and the read seeks it",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/contracts/key-reach.test.ts#aReadByAKeyAloneCarriesTheKeyIntoEveryScanThroughEveryDerivation:2.1:0.0.0.0.1.0.1.1.0.1.0.0.0.0.0.1.0.0.0.0"
				),
				reason:
					"a live derivation with a negation, read at the document a row of Owner names: rule 5b made it the statement's MATERIALIZED CTE, read once per row of Owner, and the key set its read found was dropped (no lookup reads an anti-join), so M0 was scanned with its document unbound, every document's rows (lane REDS7's census of main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: []
	}
)

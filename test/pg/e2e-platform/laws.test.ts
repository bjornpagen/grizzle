/**
 * The platform's laws refuse exactly what they forbid, each named through the naming door.
 *
 * A case is a generated platform, stored by one call of the workload's load, and one write built from it as the
 * application builds it (priced, settled and attributed by the host billing model) with exactly one thing wrong, by a
 * drawn margin of one micro-dollar or second or more. The faulty write must be refused with `invariant-rejected`
 * naming the one law it breaks; then the same write without its fault must be accepted, so the refusal is the fault's
 * and no other law's. The host law model (test/support/platform/laws.ts) judges both writes on the stored platform too,
 * as a second oracle: the faulty write's state after breaks exactly the fault's law and the sound write's none, so the
 * model refuses exactly what grizzle refuses:
 *
 * - spend past a workspace's monthly cap (spendWithinCap): a usage event in a month whose cap the workspace has spent
 *   exactly; without the fault, the same event with no tokens;
 * - a refund past what is left of a paid invoice (refundWithinInvoice); without it, a refund of exactly what is left;
 * - an event's kinds summing past its charge (chargeExact); without it, the event as priced;
 * - a debit from a grant whose validity ended before the request (debitWhileValid); without it, the event paid by none;
 * - usage on a key after its revocation (usageWhileActive); without it, the same usage before the revocation;
 * - a rate card overlapping the one in force for its model and kind (rateInForce); without it, a card that ends where
 *   the first begins;
 * - a refund of an open invoice (refundOnlyPaid); without it, the same refund of a paid one;
 * - a debit past what is left of a grant (grantWithinAmount); without it, a debit of exactly what is left;
 * - a plan change that cuts the priced segment an allocation lies in before the allocation ends (allocationCovered);
 *   without it, the same change splitting the segment there, its second part priced alike;
 * - an invoice marked paid without its payment (invoiceSettlement's reverse law); without it, paid with its payment;
 * - a charge priced at an instant before every card of its model and kind (pricedByCard); without it, the charge priced
 *   at its event's start;
 * - a card retired from under a charge it priced, cut before the charge's instant (pricedByCard); without it, the card
 *   split after the instant, its second part priced alike.
 *
 * Every fault is planted at its boundary on a platform rich enough for all of them, then searched on drawn platforms,
 * where a fault with no place to go (no paid invoice, no revoked key) is noted as such.
 *
 * Features: each fault refused by its law.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { applyFacts, openedPlatform } from "#test/pg/e2e-platform/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { buildPlatform, resolvePlatform } from "#test/support/platform/generate.ts"
import { decideSet, stateOf } from "#test/support/platform/laws.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"

import {
	law,
	faults,
	faultLaw,
	hostLaws,
	unnoted,
	plant,
	type LawFeature,
	lawSketchGen,
	faultAims,
	lawsPlatform
} from "#test/pg/e2e-platform/laws.fixtures.ts"

/**
 * The platform's laws refuse exactly what they forbid: each planted fault is refused by its one law, and the write
 * without it accepted, each case on the worker's seat of the platform's template.
 *
 * Its pre-conversion budget: runs 20, coverage cases 200 (test/pg/e2e-platform/laws.test.ts at 3f3571927).
 */
export const thePlatformsLawsRefuseExactlyWhatTheyForbidEachPlantedFaultIsRefusedByItsOneLawAndTheWriteWithoutItAccepted =
	property.explore(aimed(lawSketchGen, faultAims), {
		needs: { platform: Substrate.seat(lawsPlatform) },
		situations: Arr.map(faults, (f): LawFeature => `refused by ${f}`),
		check:
			({ platform: seat }, cx: Case<LawFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* seat
						const platform = openedPlatform(taken)
						const c = {
							platform: buildPlatform(cx.draw(resolvePlatform(sketch.platform))),
							fault: sketch.fault,
							margin: BigInt(sketch.margin)
						}
						const placed = plant(c.fault, c.platform, c.margin)
						if (Option.isNone(placed)) {
							cx.note(`no place for ${c.fault}`)
							return
						}
						const planted = placed.value
						const broken = law[faultLaw[c.fault]]
						/**
						 * The host law model on the stored platform: the faulty write breaks exactly the fault's
						 * law, the sound one none.
						 */
						const stored = stateOf(c.platform.facts)
						const modelFaulty = decideSet(stored, planted.faulty.ops)
						assert.ok(
							modelFaulty.kind === "refused",
							`the model judges ${c.fault} by ${c.margin}: ${modelFaulty.kind}`
						)
						assert.deepEqual(
							Arr.map(modelFaulty.laws, (l) => l.name),
							[defined(hostLaws.get(broken), `the model's ${broken}`).name],
							`the model judges ${c.fault} by ${c.margin}`
						)
						assert.equal(
							decideSet(stored, planted.sound.ops).kind,
							"accepted",
							`the model judges ${c.fault} without its fault`
						)
						yield* platform.withDb((db) =>
							Effect.gen(function* () {
								yield* untilAnswered(applyFacts(db, c.platform.facts), unnoted)
								const faulty = yield* untilAnswered(planted.faulty.apply(db), unnoted)
								assert.deepEqual(
									faulty,
									{ kind: "refused", laws: [broken] },
									`${c.fault} by ${c.margin}`
								)
								cx.note(`refused by ${c.fault}`)
								const sound = yield* untilAnswered(planted.sound.apply(db), unnoted)
								assert.deepEqual(sound, { kind: "accepted" }, `${c.fault} without its fault`)
							})
						)
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the host law model: the faulty write breaks exactly its fault's law, the sound one none"
		},
		budget: { runs: 20, steered: 200 },
		kept: [],
		kills: []
	})

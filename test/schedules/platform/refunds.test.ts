/**
 * Refunds racing: two or three refunds of one invoice, whose amounts together exceed what is left of it, with its
 * settlements racing them: on a paid invoice a dispute, and on an open invoice its payment and its voiding.
 *
 * The settlements are the workload programs payInvoice, disputeInvoice and voidInvoice: a ChangeSet whose put and arm
 * insertion read one sub-query, the invoice in the state the settlement moves it from, so a settlement applies only to
 * an invoice in that state and is unchanged on any other. Refunds never exceed what the invoice charged
 * (refundWithinInvoice), only a paid invoice is refunded (refundOnlyPaid), and a paid, void or disputed invoice has
 * exactly its payment, voiding or dispute (invoiceSettlement); the harness's oracle explains every outcome by those
 * laws and the programs' reads in some serial order. A direct writer settles the invoice as it read it before the race:
 * it puts the invoice in its new state, its lines and refunds kept, and removes its payment where it gives way.
 *
 * The swarm adds refunds made before the race, the dispute, the voiding, and an open invoice whose payment races its
 * refunds.
 */

import { commonRequired, raceSuite } from "#test/schedules/platform/support.ts"

import { refundSketchGen, resolveRefunds } from "#test/schedules/platform/refunds.fixtures.ts"

export const refundsRacingEveryRaceIsExplainedByTheBillingModelAndConverges = raceSuite({
	sketch: refundSketchGen,
	resolve: resolveRefunds,
	required: [
		...commonRequired,
		"law family hit: check",
		"law family hit: containment",
		"planted: refunds summing to the invoice exactly",
		"planted: a refund one micro over what is left refused",
		"planted: a settlement refused by refunds",
		"planted: a refund of an unpaid invoice refused",
		"planted: a settlement unchanged after another settled it",
		"grizzle unchanged",
		"write: dispute",
		"write: void",
		"write: pay"
	]
})

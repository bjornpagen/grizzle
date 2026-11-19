/**
 * Usage against credit grants: two to four requests of one organization, each settled from its prepaid grants by
 * earliest expiry and recorded by its own writer, against a grant too small for all of them.
 *
 * Each request is priced and settled by the host billing model (settle) from the grants
 * as every application read them before the race, so the requests compete for the same credit. The grant laws decide
 * which are recorded (a grant debited at most its amount, a debit inside its grant's validity, a kind's debits summing
 * to its credited part), and the harness's oracle explains every outcome by them in some serial order. The race's own
 * contract is the billing rule the laws do not state: settlement stays first-in-first-out under concurrency, so every
 * request the explained order records is debited exactly as the model settles it from the grants at its place. That
 * holds because balances only fall during a race and validity only shrinks: a request settled from an older state is
 * either what the model settles at its place or over-debits a grant and is refused.
 *
 * The swarm adds a second grant expiring later, requests whose windows cross the first grant's expiry, credit spent
 * before the race, the first grant expiring mid-race (a put shortening its validity, by grizzle or a direct writer's
 * UPDATE in place, its debits kept), and a request submitted twice.
 */

import { commonRequired, raceSuite } from "#test/schedules/platform/support.ts"

import { creditSketchGen, resolveCredits } from "#test/schedules/platform/credits.fixtures.ts"

export const usageAgainstCreditGrantsEveryRaceIsExplainedByTheBillingModelAndConverges = raceSuite({
	sketch: creditSketchGen,
	resolve: resolveCredits,
	required: [
		...commonRequired,
		"law family hit: check",
		"law family hit: coverage",
		"planted: a grant debited to its last micro",
		"planted: a request one micro over its grant refused",
		"planted: an event split across two grants",
		"planted: a debit outside its grant's validity refused",
		"write: expiry",
		"write: usage again"
	]
})

/**
 * A rate change racing usage: the model's input card split at an instant, the new card taking a new rate from it on,
 * or retired there with no card after it, while one to three requests whose windows start at, just before or just
 * after the instant are being recorded.
 *
 * Against a split, a grizzle writer prices its request as the application does just before recording it: it reads the
 * fixture's quote for the window's start, then records the request with what the quote charged, two transactions, both
 * again after a TransientFailure; a direct writer records the request as it was priced before the race. Against a
 * retirement, every writer records the request as it was priced before the race: a quote the race may make stale. A
 * charge is priced by a card of its model and kind in force at its event's start (pricedByCard), and a model's cards of
 * one kind never overlap (rateInForce), so the harness's oracle explains every outcome by those laws: a request priced
 * where the retirement left no card is refused, and so is the retirement of a card a recorded charge was priced by. The
 * race's own contract is what the laws do not state: the committed cards still cover all of time from January on with
 * no gap but the retirement's end, each quoted request is charged by exactly one card that held its start, and real
 * time decides which: a request whose writing ended before the split began is charged the old rate, and one that began
 * after the split committed the new rate wherever the new card holds its start.
 *
 * The swarm adds a second split at a later instant, priced from the same card, so the two splits race for it: the
 * second to commit finds the card it retires gone and its own first part colliding with the first split's.
 */

import { commonRequired, raceSuite } from "#test/schedules/platform/support.ts"

import { rateSketchGen, resolveRates } from "#test/schedules/platform/rates.fixtures.ts"

export const aRateChangeRacingUsageEveryRaceIsExplainedByTheBillingModelAndConverges = raceSuite({
	sketch: rateSketchGen,
	resolve: resolveRates,
	required: [
		...commonRequired,
		"law family hit: coverage",
		"planted: a request at the split priced by the new rate",
		"planted: a request at the split priced by the old rate",
		"planted: a second split refused",
		"planted: a retirement refused by the charges it priced",
		"planted: a request priced after the card's end refused",
		"write: quoted usage",
		"write: card retired"
	]
})

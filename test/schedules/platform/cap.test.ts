/**
 * Usage against a spend cap: two to four requests of one workspace in one month, each recorded by its own writer, whose
 * charges together cross the workspace's cap, with the workspace's caps changed while they race.
 *
 * Each request is priced from the platform as the application read it before the race, and the cap law
 * (spendWithinCap) decides which are recorded; the harness's oracle explains every outcome by it in some serial order.
 * The caps are the platform's one mutable relation, changed two ways: the fixture's setCap, a put that changes the
 * month's cap in place, and setCaps, a put of the months given from a relation parameter, here the race's month's cap
 * changed beside the second month's, which nothing spends in, given again. No write removes a month's cap: a delete of
 * WorkspaceLimit removes the month whole with its charges and their debits, which grizzle refuses when it compiles,
 * since a debit is a member of its grant's family too (test/support/fixtures/api/platform.ts setCaps).
 *
 * The swarm adds spend recorded before the race, a cap put, the caps given, and a request submitted twice by two
 * writers (its keys make the second no-change or refused, never a second charge).
 */

import { commonRequired, raceSuite } from "#test/schedules/platform/support.ts"

import { capSketchGen, resolveCap } from "#test/schedules/platform/cap.fixtures.ts"

export const usageAgainstASpendCapEveryRaceIsExplainedByTheBillingModelAndConverges = raceSuite({
	sketch: capSketchGen,
	resolve: resolveCap,
	required: [
		...commonRequired,
		"law family hit: check",
		"planted: the cap is hit exactly",
		"planted: a request one micro over the cap refused",
		"write: cap put",
		"write: caps given",
		"write: usage again",
		"direct refused"
	]
})

/**
 * Revocation racing usage: a key revoked at an instant while one to four of its requests are being recorded, before,
 * across, at and after the instant.
 *
 * Usage lies inside its key's active spans (usageWhileActive, a span coverage), and a revoked key has its revocation
 * (keyRevocation, the revoked state's mirrors with Revocation). The revocation is the fixture's revokeKey: the key's
 * state and revocation by query members that read the key active, and its active span cut at the instant; a direct
 * writer replaces the key and its active span. The harness's oracle explains every outcome by those laws and the
 * program's reads in some serial order: a request is recorded exactly when its window lies inside the key's active span
 * at its place, and the revocation commits exactly when no recorded request outlives the cut. What the explained order
 * reached is the race's own record: a request ending exactly at the instant recorded, one after it refused, and the
 * revocation refused by usage recorded first.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { commonRequired, raceSuite } from "#test/schedules/platform/support.ts"

import {
	revokeSketchGen,
	resolveRevoke,
	revocationAims
} from "#test/schedules/platform/revocation.fixtures.ts"

export const revocationRacingUsageEveryRaceIsExplainedByTheBillingModelAndConverges = raceSuite({
	sketch: aimed(revokeSketchGen, revocationAims),
	resolve: resolveRevoke,
	required: [
		...commonRequired,
		"law family hit: coverage",
		"planted: a request ending at the revocation recorded",
		"planted: a request after the revocation refused",
		"planted: the revocation refused by later usage"
	]
})

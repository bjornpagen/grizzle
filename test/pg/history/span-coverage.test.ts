/**
 * Generated histories over the span coverage family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact (test/support/history/suite.ts historySuite).
 */

import { spanCoverageHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

export const spanCoverageHistories = historySuite(import.meta, spanCoverageHistory)

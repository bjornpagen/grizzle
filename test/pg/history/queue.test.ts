/**
 * Generated histories over the work queue family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact (test/support/history/suite.ts historySuite).
 */

import { queueHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

export const queueHistories = historySuite(import.meta, queueHistory)

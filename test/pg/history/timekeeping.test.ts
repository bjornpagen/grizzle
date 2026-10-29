/**
 * Generated histories over the timekeeping family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact.
 */

import { timekeepingHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

historySuite(timekeepingHistory)

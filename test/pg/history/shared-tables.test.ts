/**
 * Generated histories over the shared-tables family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact.
 */

import { sharedTablesHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

historySuite(sharedTablesHistory)

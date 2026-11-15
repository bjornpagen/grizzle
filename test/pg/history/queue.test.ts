/**
 * Generated histories over the work queue family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact (test/support/history/suite.ts historySuite).
 *
 * @plant test/plants/pg/history/races-inserter-begins-swapped.patch Each isolation level's BEGIN is sent for the
 * other's, which puts grizzle's writes at READ COMMITTED, where the guard refuses them; the histories fail.
 */

import { queueHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

historySuite(queueHistory)

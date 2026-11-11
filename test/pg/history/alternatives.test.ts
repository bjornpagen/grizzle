/**
 * Generated histories over the alternatives family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact (test/support/history/suite.ts historySuite).
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/races-inserter-begins-swapped.patch, each level's BEGIN sent for the
 * other's, puts grizzle's writes at READ COMMITTED, where the guard refuses them, and must turn the histories red.
 */

import { alternativesHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

historySuite(alternativesHistory)

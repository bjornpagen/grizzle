/**
 * Generated histories over the work queue family: grizzle, SERIALIZABLE psql and planted below-SERIALIZABLE psql
 * writers at once, checked after the fact (test/support/history/suite.ts historySuite).
 *
 * Plants: ~/.cache/grizzle-release/BR08/plants/races-inserter-begins-swapped.patch, each level's BEGIN sent for the
 * other's, puts grizzle's writes at READ COMMITTED, where the guard refuses them, and must turn the histories red;
 * ~/.cache/grizzle-release/BR08/plants/isolation-guard-admits-repeatable-read.patch, the guard comparing against
 * REPEATABLE READ, must turn the exhaustion of the writers below SERIALIZABLE red.
 */

import { queueHistory } from "#test/support/history/families.ts"
import { historySuite } from "#test/support/history/suite.ts"

historySuite(queueHistory)

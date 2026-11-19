/**
 * Generated work queue schemas (test/support/laws/boxes.ts queueFamily): alternatives over a work item's standing,
 * every handle armed, each arm's two containments native foreign keys (fin.md §7), a lease's candidate key and its
 * foreign key into Seat. The oracle is the host model (test/support/laws/model.ts), a second implementation judging
 * each generated write sequence.
 */

import { queueFamily } from "#test/support/laws/boxes.ts"
import { familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"

export const queueLaws = familySuite(import.meta, queueFamily, "the family", noKeptCases)

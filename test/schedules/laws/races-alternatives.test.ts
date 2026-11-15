/**
 * Generated races on the alternatives family's laws (test/schedules/laws/races.ts raceSuite).
 *
 * @plant test/plants/schedules/laws/races-alternatives-no-forward.patch An alternatives statement is expanded to its
 * reverse containments alone (ir/desc.ts expandAlternatives), so a race commits an arm row whose parent is of another
 * handle; the races' property fails.
 */

import { raceSuite } from "#test/schedules/laws/races.ts"
import { alternativesHistory } from "#test/support/history/families.ts"

raceSuite(alternativesHistory)

/** Generated races on the work queue family's laws. */

import { raceSuite } from "#test/schedules/laws/races.ts"
import { queueHistory } from "#test/support/history/families.ts"

export const queueRaces = raceSuite(import.meta, queueHistory)

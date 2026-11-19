/**
 * Generated timekeeping schemas (test/support/laws/boxes.ts timekeepingFamily): span keys WITHOUT OVERLAPS, a
 * selected containment into Timesheet from the selected shifts' law columns, and their coverage by Employment, a PERIOD
 * foreign key, every law native. The oracle is the host model (test/support/laws/model.ts), a second implementation
 * judging each generated write sequence.
 */

import { timekeepingFamily } from "#test/support/laws/boxes.ts"
import { familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"

export const timekeepingLaws = familySuite(
	import.meta,
	timekeepingFamily,
	"the family",
	noKeptCases
)

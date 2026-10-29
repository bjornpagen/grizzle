/** Generated timekeeping schemas. */

import { timekeepingFamily } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(timekeepingFamily, casesPerTest, "the family")

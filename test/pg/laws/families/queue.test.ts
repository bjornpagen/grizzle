/** Generated work queue schemas. */

import { queueFamily } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(queueFamily, casesPerTest, "the family")

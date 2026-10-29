/** Generated deposits schemas. */

import { depositsFamily } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(depositsFamily, casesPerTest, "the family")

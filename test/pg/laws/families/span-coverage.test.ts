/** Generated span coverage schemas. */

import { spanCoverage } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(spanCoverage, casesPerTest, "the family")

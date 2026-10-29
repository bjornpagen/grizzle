/** Generated schemas whose selected-source containment and capacity share tables over composite tenant keys. */

import { sharedTablesFamily } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(sharedTablesFamily, casesPerTest, "the family")

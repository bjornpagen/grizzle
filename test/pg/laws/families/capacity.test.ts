/**
 * Generated scalar-group capacity schemas and the schemas of two capacities on one relation by
 * keys of one arity.
 */

import { badgesFamily, capacityFamily } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(capacityFamily, casesPerTest, "the family")
familySuite(badgesFamily, casesPerTest, "the family")

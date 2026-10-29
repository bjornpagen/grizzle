/** Generated alternatives schemas: over a single key, and over a composite key. */

import { alternativesFamily, compositeAlternatives } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(alternativesFamily, casesPerTest, "the family")
familySuite(compositeAlternatives, casesPerTest, "every schema's refusals of stored and new facts")

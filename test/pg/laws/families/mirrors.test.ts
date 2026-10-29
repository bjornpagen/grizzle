/**
 * Generated conditional mirrors schemas: boolean selectors, a composite projection out of the
 * parent's key order, and integer, text and closed-handle selectors on either side.
 */

import { conditionalMirrors, mirrorShapes } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(conditionalMirrors, casesPerTest, "the family")
familySuite(mirrorShapes, casesPerTest, "every schema's refusals")

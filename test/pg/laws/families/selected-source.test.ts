/**
 * Generated selected-source containment schemas: a scalar anchor, a composite text and uuid
 * anchor, and one relation as both source and target.
 */

import { selectedSource, sourceShapes } from "#test/pg/laws/families/families.ts"
import { casesPerTest, familySuite } from "#test/pg/laws/families/suites/family.ts"

familySuite(selectedSource, casesPerTest, "the family")
familySuite(sourceShapes, casesPerTest, "every schema's refusals of stored and new facts")

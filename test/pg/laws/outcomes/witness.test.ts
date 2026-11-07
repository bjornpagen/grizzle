/** What a law's refusal names. The suites are suites/witness.ts, suites/host.ts and suites/every.ts. */

import { everyLawSuite } from "#test/pg/laws/outcomes/suites/every.ts"
import { hostWitnessSuite } from "#test/pg/laws/outcomes/suites/host.ts"
import { witnessSuite } from "#test/pg/laws/outcomes/suites/witness.ts"

witnessSuite()
hostWitnessSuite()
everyLawSuite()

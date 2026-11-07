/** What a law's refusal names. The suites are suites/witness.ts and suites/host.ts. */

import { hostWitnessSuite } from "#test/pg/laws/outcomes/suites/host.ts"
import { witnessSuite } from "#test/pg/laws/outcomes/suites/witness.ts"

witnessSuite()
hostWitnessSuite()

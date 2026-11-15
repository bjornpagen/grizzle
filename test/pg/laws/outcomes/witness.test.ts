/**
 * What a law's refusal names. The suites are suites/witness.ts, suites/host.ts and suites/every.ts.
 *
 * @plant test/plants/pg/laws/outcomes/witness-judged-at-slot-starts.patch The witness judges an owner's count and
 * ends at its slot's starts, the empty family's, whatever the write fills (runtime/write/bind.ts judgedRow); every.ts's
 * search, a refused CHECK naming every law its row breaks, fails.
 * @plant test/plants/pg/laws/outcomes/witness-unknown-count-names-every.patch The witness reads a filled count or end
 * as unknown and judges a CHECK it cannot evaluate as holding, so it still names `every` law (runtime/write/witness.ts
 * hostField, checked); every.ts's search fails.
 * @plant test/plants/pg/laws/outcomes/witness-unread-owner-judged-new.patch A stated owner no read looked up is
 * judged as a new one, `known` at its empty family rather than `ifFresh` (runtime/write/bind.ts judgedRow); every.ts's
 * search fails at the stored owner inserted again beside a refused new one.
 */

import { everyLawSuite } from "#test/pg/laws/outcomes/suites/every.ts"
import { hostWitnessSuite } from "#test/pg/laws/outcomes/suites/host.ts"
import { witnessSuite } from "#test/pg/laws/outcomes/suites/witness.ts"

witnessSuite()
hostWitnessSuite()
everyLawSuite()

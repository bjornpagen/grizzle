/**
 * The law-family box (test/support/laws/generated.ts) through grizzle: generated write sequences over every point,
 * each step's outcome the host model's (accepted, unchanged, or refused by one of the violated laws) and the committed
 * state the host's, compared as sets. Every law is native, so a refusal names its law and no fact. Every trait of a
 * point must meet a refusal by every kind of law from a selected side that point declares.
 *
 * The oracle is a second implementation: the host model (test/support/laws/model.ts), judging the same steps.
 */

import { lawBox } from "#test/support/laws/generated.ts"
import { casesPerTest, familySuite } from "#test/support/laws/suites/family.ts"

familySuite(lawBox, casesPerTest, "every schema's refusals")

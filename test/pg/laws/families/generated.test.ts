/**
 * The law-family box (test/support/laws/generated.ts) through grizzle: generated write sequences over every point,
 * each step's outcome the host model's (accepted, unchanged, or refused by one of the violated laws) and the committed
 * state the host's, compared as sets. Every law is native, so a refusal names its law and no fact. Every trait of a
 * point must meet a refusal by every kind of law from a selected side that point declares.
 *
 * The oracle is a second implementation: the host model (test/support/laws/model.ts), judging the same steps.
 *
 * @plant test/plants/pg/laws/families/stratum-order-drops-generated-class.patch The order model
 * (test/support/stratum-order.ts) drafts no generated insertion from an enumerated insert into a relation with an
 * identity column, so it orders the mutable box's stratum that puts Child, inserts Parent and deletes Parent, which
 * grizzle refuses (laws/the-law-family-box/mutable, TEST_SEED=572712174, rotating case 117).
 */

import { lawBox } from "#test/support/laws/generated.ts"
import { casesPerTest, familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"

familySuite(lawBox, casesPerTest, "every schema's refusals", noKeptCases)

/**
 * Generated span coverage schemas (test/support/laws/boxes.ts spanCoverage), every law native: each coverage a
 * PERIOD foreign key, from a selected source's range law column or into a selected target's, into a target keyed
 * WITHOUT OVERLAPS (fin.md §7). The oracle is the host model (test/support/laws/model.ts), a second implementation:
 * generated write sequences are accepted exactly when its violation queries are empty, and each refusal names a law it
 * names.
 */

import { spanCoverage } from "#test/support/laws/boxes.ts"
import { casesPerTest, familySuite } from "#test/support/laws/suites/family.ts"

familySuite(spanCoverage, casesPerTest, "the family")

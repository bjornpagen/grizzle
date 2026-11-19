/**
 * A direct SQL writer over generated schemas: alternatives over a composite key, its forward and reverse containments
 * native foreign keys, the reverse deferred on the cycle (fin.md §7). The oracle is the host model
 * (test/support/laws/model.ts), judging each SERIALIZABLE transaction's verdict and where it is raised.
 *
 * An UPDATE that moves a run into a handle, or moves an armed run or its arm, commits only when the rest of its
 * transaction leaves every arm with its run and every armed run with its arm, which a drawn set of fields rarely does
 * and the selected and carried modes of an UPDATE do (direct.ts). Both are planted for the mutable schema too: a draft
 * run moved into the paid handle with its payment inserted after it, and a paid run moved to the other tenant with its
 * payment moved after it.
 */
import { planted } from "#test/pg/laws/families/direct-alternatives.fixtures.ts"
import { compositeAlternatives } from "#test/support/laws/boxes.ts"
import { directSuite } from "#test/support/laws/suites/direct.ts"

/** A direct writer over compositeAlternatives, each population: a transaction commits iff its final state is lawful. */
export const compositeAlternativesDirect = directSuite(import.meta, compositeAlternatives, planted)

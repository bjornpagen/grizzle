/**
 * A direct SQL writer over the law-family box (test/support/laws/generated.ts directLawBox): SERIALIZABLE transactions
 * commit iff their final state is lawful, each refusal raised where its law is checked, under the constraint the host's
 * law names, every law native, so its identity names its constraint's table and name. The oracle is the host model
 * (test/support/laws/model.ts), a second implementation judging the same transactions.
 *
 * An UPDATE that moves a fact into a referring side's selection needs a fact outside the selection to move, which the
 * lawful states a case starts from store (support.ts lawfulStateSketchGen), so the streams reach such an UPDATE refused
 * at COMMIT and one in a transaction that commits. Both are kept cases too, on the mutable point whose child a boolean
 * selects: an unselected child whose parent is missing selected, and the same child selected with its parent inserted
 * after it.
 */
import { planted } from "#test/pg/laws/families/direct-box.fixtures.ts"
import { directLawBox } from "#test/support/laws/generated.ts"
import { directSuite } from "#test/support/laws/suites/direct.ts"

/** A direct writer over directLawBox, each population: a transaction commits iff its final state is lawful. */
export const directLawBoxDirect = directSuite(import.meta, directLawBox, planted)

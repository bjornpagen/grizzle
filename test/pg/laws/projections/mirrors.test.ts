/**
 * Mirrors over selected sides as partial projections: its two containments, each a native foreign key, the pair a
 * cycle and so deferred, so a selected parent without its child, or a child whose parent leaves the selection, is
 * refused by PostgreSQL at COMMIT with 23503, a child that is all key included; generated schemas through grizzle and
 * through a direct SQL writer.
 *
 * For the direct writer, an UPDATE that moves a ticket into a selection, or moves a selected ticket or its follow-up,
 * commits only when the rest of its transaction leaves every follow-up with its selected ticket and every selected
 * ticket with its follow-up, which drawn transactions rarely do; a move into a selection refused at COMMIT is rare too.
 * All three are planted for the mutable ticket's schema, on a German ticket of low priority, which no selection but
 * the one by level reaches: raised to level 3 with its escalation inserted after it, raised to level 3 with no
 * escalation, and, at level 3, moved to another id with its escalation moved after it.
 */
import { mirrorShapes, projectedMirrors } from "#test/pg/laws/projections/families.ts"
import { planted } from "#test/pg/laws/projections/mirrors.fixtures.ts"
import { directSuite } from "#test/support/laws/suites/direct.ts"
import { familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"

/** Law-bearing generated schemas, the ticket's projected mirrors: accepted iff every violation query is empty. */
export const projectedMirrorsLaws = familySuite(
	import.meta,
	projectedMirrors,
	"the family",
	noKeptCases
)

/** Law-bearing generated schemas, the mirrors' shapes: each schema's every refusal by every law but a key. */
export const mirrorShapesLaws = familySuite(
	import.meta,
	mirrorShapes,
	"every schema's refusals by every law but a key",
	noKeptCases
)

/** A direct writer over the mirrors' shapes, each population: a transaction commits iff its final state is lawful. */
export const mirrorShapesDirect = directSuite(import.meta, mirrorShapes, planted)

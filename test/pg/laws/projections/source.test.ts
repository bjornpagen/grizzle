/**
 * Selected sources as partial projections: a selected side's foreign key from its STORED generated columns, and a key
 * over the same side, refused by PostgreSQL's own constraints, 23503 and 23505; generated schemas through grizzle and
 * through a direct SQL writer.
 *
 * For the direct writer, an UPDATE that moves a node into its selection or moves a selected node's parent is refused at
 * COMMIT, the self-referencing foreign key being on a cycle, only when the parent it then needs is missing, and an
 * UPDATE of a key commits only when nothing selected refers to it, which drawn transactions reach a few times a run.
 * All three are planted for a mutable schema whose node is selected when live: an unselected node whose parent is
 * missing made live, a live node's parent moved to a missing node, and an unselected node moved to another id, which
 * its own null generated column does not refer to. A selected key's refusal at its statement is planted in each
 * population, on the rota keyed over its approved shifts: a second approved shift of a sheet's week.
 */
import { projectedSource, sourceShapes } from "#test/pg/laws/projections/families.ts"
import { planted } from "#test/pg/laws/projections/source.fixtures.ts"
import { directSuite } from "#test/support/laws/suites/direct.ts"
import { familySuite, noKeptCases } from "#test/support/laws/suites/family.ts"

/** Law-bearing generated schemas, the selected sources as projections: accepted iff every violation query is empty. */
export const projectedSourceLaws = familySuite(
	import.meta,
	projectedSource,
	"the family",
	noKeptCases
)

/** Law-bearing generated schemas, the sources' shapes: each schema's every refusal by every law but a key. */
export const sourceShapesLaws = familySuite(
	import.meta,
	sourceShapes,
	"every schema's refusals by every law but a key",
	noKeptCases
)

/** A direct writer over the sources' shapes, each population: a transaction commits iff its final state is lawful. */
export const sourceShapesDirect = directSuite(import.meta, sourceShapes, planted)

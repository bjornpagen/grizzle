/**
 * What a fragment holding records costs (schema/budget/records-fragment.ts): flat records, records of an array of
 * options two levels deep, and records of a document scan (pantry's documentScanOf's shape: an array of nodes, each with
 * an option chain three deep and arrays of arrays under one name twice), each written 10 and 20 times over one schema,
 * each unit a query, its records and a fragment holding the records' relations and their own laws, each program checked alone by one checker. The records hold their
 * relations and laws as unions of the members alone, read once their query is known (types/schema/records.ts
 * RecordsHeld), each relation one type for one child, so the fragment's statements, read back by name, are related
 * member by member and never through the recursion over the attachment tree that built them.
 *
 * Properties: every program typechecks with no diagnostic, and each unit the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/support/types/batch/measured.ts), against the bound
 * measured when records' unions were unboxed (records-fragment.ts addedAtMost).
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { recordsFragments } from "#test/types/schema/budget/records-fragment.dictionary.ts"
import { fragmentCost, fragmentShapeName } from "#test/types/schema/budget/records-fragment.ts"

/** Each shape's added unit costs at most its measured instantiations. */
export const cost = costGate(recordsFragments, {
	box: "every shape of records a fragment holds beside their laws",
	name: fragmentShapeName,
	measure: fragmentCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, against each shape's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/types/schema/records.ts",
			original: "type Boxed<X> = readonly [X]",
			replacement: "type Boxed<X> = X",
			why: "Records hold their relations and laws as the unions the recursions over the attachment tree built, each carrying its alias and arguments, the query's attachment phantom among them, which holds each attached query whole; reading the fragment's statements back relates them through the alias's variance, the recursion instantiated over markers, and into the queries: TS2589 at the fragment of records of a document scan."
		}
	]
})

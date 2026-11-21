/**
 * What a fragment holding records costs (schema/budget/records-fragment.ts): flat records, and records of an array of
 * options two levels deep, each written 10 and 20 times over one schema, each unit a query, its records, a header and a
 * fragment holding the header, the records' relations, a retirable body over the records and the records' own laws,
 * each program checked alone by one checker. The records hold their laws collected, each law as itself, read once their
 * query is known, so the fragment's statements, read back by name, never instantiate the recursion over the attachment
 * tree that built them.
 *
 * Properties: every program typechecks with no diagnostic, and each unit the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/types/batch/measured.ts), against the bound
 * measured when records' unions were collected (records-fragment.ts addedAtMost).
 */
import { costGate } from "#test/types/batch/measured.ts"
import { recordsFragments } from "#test/types/schema/budget/records-fragment.dictionary.ts"
import { fragmentCost, fragmentShapeName } from "#test/types/schema/budget/records-fragment.ts"

/** Each shape's added unit costs at most its measured instantiations. */
export const cost = costGate(recordsFragments, {
	box: "every shape of records a fragment holds beside their laws and a retirable body over them",
	name: fragmentShapeName,
	measure: fragmentCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, against each shape's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/types/schema/records.ts",
			original: "type Collected<U> = U extends unknown ? U : never",
			replacement: "type Collected<U> = U",
			why: "Records hold their laws as the union the recursion over the attachment tree built, each law a reference over the tree below it, which the checker instantiates again, the whole tree, wherever the fragment's statements are read back: TS2589 at the fragment of records of an array of options."
		},
		{
			file: "packages/engine/src/types/schema/records.ts",
			original:
				"\treadonly laws: Q extends unknown\n\t\t? Collected<\n\t\t\t\tAttachedLaws<Stem, RecordsPaths<AttachedOf<Q>>, RootOf<Stem, Owner, Key, Q>, AttachedOf<Q>>\n\t\t\t>\n\t\t: never",
			replacement:
				"\treadonly laws: Collected<\n\t\tAttachedLaws<Stem, RecordsPaths<AttachedOf<Q>>, RootOf<Stem, Owner, Key, Q>, AttachedOf<Q>>\n\t>",
			why: "Records collect their laws over a query's type parameter too, where the recursion over the attachment tree stays half made, and the instantiation for a query instantiates that again, the whole tree: TS2589 at the fragment of records of an array of options."
		}
	]
})

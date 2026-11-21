/**
 * The scoped entries' types (test/types/schema/scoped-entries.ts): over every way a caller states scopedEntriesOf's
 * options and holds its entries in a role, a cell typechecks exactly where the rule admits it. Each statement is a cell
 * of the box; a batch's cells are one program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { scopedEntriesBox } from "#test/types/schema/scoped-entries.dictionary.ts"
import { scopedEntriesProgram } from "#test/types/schema/scoped-entries.ts"

/** Admits every statement of scoped entries the rule admits, and refuses every other. */
export const scopedEntries = boxAgreement(finite(word(scopedEntriesBox)), {
	box: "a role holding scoped entries, a workload over it of a program over its base, its relation under a scoped name, its write list, a root of no relation and of no field, and a role holding a relation through a query entry of its own",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: scopedEntriesProgram,
	oracle: {
		kind: "specification",
		name: "scoped entries are wholeEntriesOf's, each relation whole or scoped under its own name, so the role holds its base"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: 'type HeldRelationOf<V> = V extends AnyScoped ? V["relation"] : V',
			replacement: "type HeldRelationOf<V> = V extends AnyScoped ? V : V",
			why: "A scoped entry's role relation is the entry, not its relation, so the role holds no level of its base: the workload over it of a program over its base is refused, and its directive-free cell fails."
		}
	]
})

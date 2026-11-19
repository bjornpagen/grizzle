import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
/**
 * A relation's name (test/types/api/names.ts): over the box of every constructor that names a relation by every
 * spelling of the name it is handed, a call is refused exactly when the name's type is no one string literal, at the
 * name, the call's own argument, a helper's call to the constructor included, and every call it admits keeps its
 * level's inputs. Each call is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the box's
 * own typing of each name.
 */
import { namesBox } from "#test/types/api/names.dictionary.ts"
import { namesProgram } from "#test/types/api/names.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * Over every constructor that names a relation by every spelling of its name, refuses exactly the names no one string
 * literal states, at the name, and admits every other with its level's inputs kept.
 */
export const names = boxAgreement(finite(word(namesBox)), {
	box: "every constructor that names a relation (relation, relation.generated, closed.ordered, closed.unordered, closed.relation, derived, derived.materialized) by every spelling of its name: a literal, string, a union, a template, a helper's RelationName<N> and a helper's string",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: namesProgram,
	oracle: { kind: "specification", name: "the box's own typing of each name" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/relation.ts",
			original:
				"\t\t: Refusal<\"a relation's name is one string literal, the key its schema's types hold it under\">)",
			replacement: "\t\t: unknown)",
			why: "A name no one string literal states is admitted (types/schema/relation.ts RelationName answers unknown for it), so every refused cell's name raises nothing and its directive is unused; the program fails."
		}
	]
})

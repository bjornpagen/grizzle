/**
 * A relation's name (test/types/api/names.ts): over the box of every constructor that names a relation by every
 * spelling of the name it is handed, a call is refused exactly when the name's type is no one string literal, at the
 * name, the call's own argument, a helper's call to the constructor included, and every call it admits keeps its
 * level's inputs. Each call is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the box's
 * own typing of each name.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { namesBox } from "#test/types/api/names.dictionary.ts"
import { namesProgram } from "#test/types/api/names.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * Over every constructor that names a relation by every spelling of its name, refuses exactly the names no one string
 * literal states, at the name, and admits every other with its level's
 * inputs kept.
 */
export const names = boxAgreement(finite(word(namesBox)), {
	box: "every constructor that names a relation (relation, relation.generated, closed.ordered, closed.unordered, closed.relation, derived, and the dynamic door's five) by every spelling of its name: a literal, string, a union, a template, a helper's RelationName<N> and a helper's string",
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
		},
		{
			file: "packages/engine/src/public/dynamic.ts",
			original: "const orderedRoster = (\n\tname: string,",
			replacement:
				'const orderedRoster = <const N extends string>(\n\tname: N & (string extends N ? "a literal" : unknown),',
			why: "The dynamic door's closed.ordered refuses a name typed string, as the root's does, so a cell that hands it a name known only at run time is refused with no directive over it; the program fails."
		},
		{
			file: "packages/engine/src/public/dynamic.ts",
			original:
				"const orderedRoster = (\n\tname: string,\n\thandles: ReadonlyArray<string>,\n\t...extra: ReadonlyArray<never>\n): AnyRoster =>",
			replacement:
				'const orderedRoster = <const N extends string>(\n\tname: N,\n\thandles: ReadonlyArray<string>,\n\t...extra: ReadonlyArray<never>\n): ReturnType<typeof closedBuilder<N, ReadonlyArray<string>, "ordered">> =>',
			why: "The dynamic door's closed.ordered types its value by the name it is handed, so a schema's types key on a literal it was handed and the cell's lost line, which reads the value's name as string, fails; the program fails."
		}
	]
})

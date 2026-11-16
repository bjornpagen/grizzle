import { costGate } from "#test/types/batch/measured.ts"
/**
 * schema.extend's type cost against the base it extends (schema/budget/extension.ts): the derived relations an
 * extension lists, and the laws it states over derived relations, each program checked alone over a base of `small`
 * relations and over one of `large`, as edullm's pantry extends its stored level of hundreds of relations with the
 * derived relations its laws read (its Qti over QtiBase).
 *
 * Properties: instantiations per derived relation listed, and per law over a derived relation, are invariant in the
 * size of the base. The extension listing twice as many derived relations, and the one stating twice as many laws, add
 * exactly as many instantiations over the large base as over the small one: I(large, 2k) − I(large, k) =
 * I(small, 2k) − I(small, k). A derived relation holds its definition, a query over the base, so a test of it, or of a
 * statement naming it, that the checker resolves instantiates the base whole, and costs more over the larger one, by
 * every relation it walks, for each relation or law the second program adds. The measured laws are each relation's
 * second: the first statement naming a relation compares it whole with the record's relation of its name (Identical),
 * once for each relation, since a statement naming another relation of a declared name is refused (Undeclared) and
 * only a comparison tells two relations of one name apart. Every derived relation and every measured law is passed to a
 * generic call in every program, which resolves its members, a cost of using it anywhere (extension.ts). And every
 * program typechecks with no diagnostic. Oracle: the compiler's own counts and diagnostics
 * (test/types/batch/measured.ts), compared across the two bases.
 */
import { extensionDimensions } from "#test/types/schema/budget/extension.dictionary.ts"
import { extensionCost, extensionDimensionName } from "#test/types/schema/budget/extension.ts"

/** Each derived relation an extension lists, and each law over one, costs as many instantiations over the large base as over the small one. */
export const cost = costGate(extensionDimensions, {
	box: "every dimension of an extension: its derived relations listed, its laws over them",
	name: extensionDimensionName,
	measure: extensionCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two bases" },
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\t\t\t> extends true\n\t\t\t\t? never\n\t\t\t\t: ClashesOf<Boxed<Relations[I]>, Relations, Below>",
			replacement:
				"\t\t\t> extends unknown\n\t\t\t\t? ClashesOf<Boxed<Relations[I]>, Relations, Below>\n\t\t\t\t: never",
			why: "The list's clash check compares every element of a tuple whole with the relations under its name (ClashesOf), the one declaration of its name among them: each derived relation is compared with itself (Identical), which instantiates its definition, the base with it; the derived relations' cost grows with the base."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: '\t? SideNames<Stated<St, "side">>',
			replacement: "\t? St extends Key<infer S>\n\t\t? SideNames<S>\n\t\t: never",
			why: "NamedBy reads a key's side by matching the statement (`St extends Key<infer S>`): the key holds the derived relation its side reads, and the test instantiates it whole, the base with it, for each key; the laws' cost grows with the base."
		}
	]
})

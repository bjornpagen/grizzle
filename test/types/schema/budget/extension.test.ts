/**
 * schema.extend's type cost against the base it extends (schema/budget/extension.ts): the derived relations an
 * extension lists, and the laws it states over derived relations, each program checked alone over a base of `small`
 * relations and over one of `large`, as edullm's pantry extends its stored level of hundreds of relations with the
 * derived relations its laws read (its Qti over QtiBase).
 *
 * Properties: instantiations per derived relation listed, per law over a derived relation, the first naming it and one
 * a statement already names, and per law over a base relation from none, are invariant in the size of the base. The
 * extension listing twice as many derived relations, the ones stating twice as many laws, and the one stating k laws
 * over base relations where the other states none, add exactly as many instantiations over the large base as over the
 * small one: I(large, 2k) − I(large, k) = I(small, 2k) − I(small, k), and I(large, k) − I(large, 0) = I(small, k) −
 * I(small, 0). A derived relation's type holds a view of its definition, never the query over the base
 * (types/derived/derived.ts Derived), so a test of it costs what the view holds (test/types/schema/budget/levels holds
 * that view's own laws). The first statement naming a base relation looks it up in the extension's record by name,
 * which reads the record once, so a record whose first lookup walks the base costs more over the larger one, as
 * edullm's pantry's LOM level's first law over a relation of the levels below it did. Every derived relation and every measured law is passed to a generic call in every program, which resolves its
 * members, a cost of using it anywhere (extension.ts). And every program typechecks with no diagnostic. Oracle: the
 * compiler's own counts and diagnostics (test/support/types/batch/measured.ts), compared across the two bases.
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { extensionDimensions } from "#test/types/schema/budget/extension.dictionary.ts"
import { extensionCost, extensionDimensionName } from "#test/types/schema/budget/extension.ts"

/** Each derived relation an extension lists, and each law over one, costs as many instantiations over the large base as over the small one. */
export const cost = costGate(extensionDimensions, {
	box: "every dimension of an extension: its derived relations listed, its laws over them and over the base's relations",
	name: extensionDimensionName,
	measure: extensionCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two bases" },
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\t\t\t: { readonly [N in keyof B | keyof L]: N extends keyof B ? B[N] : L[N & keyof L] }",
			replacement: "\t\t\t: B & L",
			why: "The extension's record is the intersection of the base's and the level's (RecordOver): the first lookup by name in it asks whether the intersection reduces, which instantiates it whole, every base relation with it; the first law over a base relation costs more over the larger base."
		}
	]
})

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
 *
 * @plant test/plants/types/schema/budget/clash-compared-whole.patch The list's clash check compares every element of a
 * tuple whole with the relations under its name (ClashesOf), the one declaration of its name among them: each derived
 * relation is compared with itself (Identical), which instantiates its definition, the base with it; the derived
 * relations' cost grows with the base.
 * @plant test/plants/types/schema/budget/named-by-matched.patch NamedBy reads a key's side by matching the statement
 * (`St extends Key<infer S>`): the key holds the derived relation its side reads, and the test instantiates it whole,
 * the base with it, for each key; the laws' cost grows with the base.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import { assertClean, measuredEach } from "#test/types/batch/measured.ts"
import { type ExtensionShape, extensionSource } from "#test/types/schema/budget/extension.ts"

/**
 * The derived relations or laws of the first program, and the bases' sizes. The second program lists or states twice as
 * many; the small base holds twice as many relations as that, each of the derived relations over one of its own, and
 * the large one four times as many as the small, so a derived relation or a law that walks the base walks every relation
 * the large base adds, three for each of the small one's, for each relation or law the second program adds.
 */
const added = 5
const derived = 2 * added
const small = 2 * derived
const large = 4 * small

/** What one law measures: the shape of its first program over the base of `relations`, and of its second. */
type Dimension = {
	readonly what: string
	readonly shape: (relations: number, count: number) => ExtensionShape
}

const dimensions: ReadonlyArray<Dimension> = [
	{
		what: "derived relation the extension lists",
		shape: (relations, count) => ({ relations, derived, listed: count, named: 0, laws: 0 })
	},
	{
		what: "law over a derived relation a statement already names",
		shape: (relations, count) => ({
			relations,
			derived,
			listed: derived,
			named: derived,
			laws: count
		})
	}
]

/** The four programs of one dimension, in order: `added` and twice as many, over each base. */
const shapes = [
	{ relations: small, count: added },
	{ relations: small, count: 2 * added },
	{ relations: large, count: added },
	{ relations: large, count: 2 * added }
] as const

layer(NodeServices.layer, { excludeTestServices: true })("the extension programs", (it) => {
	for (const dimension of dimensions) {
		it.effect(
			`each ${dimension.what} costs as many instantiations over ${large} base relations as over ${small}`,
			() =>
				Effect.gen(function* () {
					const measured = yield* measuredEach(
						"test/types/schema",
						Arr.map(shapes, (at) => ({
							size: at.relations,
							source: (entries: PreludeAt) =>
								extensionSource(dimension.shape(at.relations, at.count), entries)
						}))
					)
					for (const m of measured) {
						assertClean(m, `the extension of each ${dimension.what}`)
					}
					const count = (i: number): number =>
						defined(measured[i], `the program of each ${dimension.what} at ${i}`).instantiations
					const step = { small: count(1) - count(0), large: count(3) - count(2) }
					assert.equal(
						step.large,
						step.small,
						`the last ${added} of each ${dimension.what} cost ${step.large} instantiations over ${large} base relations and ${step.small} over ${small}`
					)
				})
		)
	}
})

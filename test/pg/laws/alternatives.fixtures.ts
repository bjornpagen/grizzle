/** What the properties of alternatives.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data } from "effect"
import { closedId, pg } from "#compiler/public/fields.ts"
import { alternatives, closed, mutable, relation, schema } from "#compiler/public/schema.ts"

export const Kind = closed.ordered("Kind", ["a", "b", "c"])

const Item = relation("Item", { id: pg.integer, kind: closedId(Kind) }, ["id"])

const A = relation("A", { item: pg.integer }, ["item"])

const B = relation("B", { item: pg.integer }, ["item"])

/**
 * The box's schema, every relation mutable: a containment between immutable relations that joins within one unit is
 * judged whole at COMMIT and installs no foreign key (laws/model/plan.ts containmentDischarge, since bb62f0fa1), and
 * this box reads the alternatives' native lowering.
 */
export const Alternatives = schema(
	"fin_alternatives",
	[Kind, Item, A, B],
	[alternatives(Item, "kind", Kind, { a: A, b: B }), mutable(Item), mutable(A), mutable(B)]
)

export const RELATIONS = ["Item", "A", "B"] as const

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export type Handle = "a" | "b" | "c"

/** A case: parents 0 and 1 present with a kind or absent, and each arm's rows among the parents' ids. */
interface Sketch {
	readonly kinds: ReadonlyArray<Handle | undefined>
	readonly a: ReadonlyArray<number>
	readonly b: ReadonlyArray<number>
}

const SUBSETS: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>> = [[], [0], [1], [0, 1]]

export const sketchGen: Gen<Sketch> = (source) => ({
	kinds: Arr.map([0, 1], () =>
		source.draw(element<Handle | undefined>([undefined, "a", "b", "c"]))
	),
	a: source.draw(element(SUBSETS)),
	b: source.draw(element(SUBSETS))
})

/** What breaks a state: an arm row whose parent is absent or of another kind, or a parent of an armed kind with no arm. */
export type Broken = "forward" | "reverse"

export const brokenOf = (s: Sketch): ReadonlyArray<Broken> => {
	const kindOf = (id: number) => s.kinds[id]
	const forward =
		Arr.some(s.a, (id) => kindOf(id) !== "a") || Arr.some(s.b, (id) => kindOf(id) !== "b")
	const reverse = Arr.some(
		s.kinds,
		(k, id) => (k === "a" && !s.a.includes(id)) || (k === "b" && !s.b.includes(id))
	)
	return [...(forward ? ["forward" as const] : []), ...(reverse ? ["reverse" as const] : [])]
}

export type AlternativesFeature = "committed" | "committed an unarmed parent" | `refused ${Broken}`

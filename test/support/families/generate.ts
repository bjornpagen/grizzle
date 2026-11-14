/**
 * Random families with their owners and counts: each owner's family drawn as the array the application writes under
 * it, so every drawn state satisfies the theorem by construction (theorem.ts).
 *
 * The lengths a family's laws branch on are a dictionary: empty, where the count's predecessor is undefined and no
 * last slot is required; one, where the last slot is the first and no row has a predecessor; two, where the last slot
 * is the one predecessor; and long. A swarm turns lengths on and off per case, so a case of only empty families, or of
 * only long ones, is as likely as a mixed one. Members are numbered across the whole state and dealt to the families in
 * a drawn order, so a member's number says nothing of its slot or its owner, and a read that orders by member instead
 * of by slot is caught. A case shrinks toward fewer owners, shorter families and members numbered in slot order.
 *
 * Span-keyed owners (`spanOwnersGen`) are those families' owners keyed by an id and a span WITHOUT OVERLAPS instead,
 * which a put must update in place.
 */
import { array, type Gen, int, shuffled, type Size } from "@bjornpagen/testing/gen"
import { swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { Families, Family } from "#test/support/families/theorem.ts"

/** The lengths a family's laws branch on, the simplest first. */
const LENGTHS = ["empty", "single", "pair", "long"] as const

/** What a drawn state may hold: how many owners, and how long a long family is, from three members up. */
export interface FamilySpace {
	readonly owners: Size
	readonly long: Size
}

/** Owners 0, 1, … with families of the drawn lengths, the members dealt to them in the drawn order. */
export const familiesGen =
	(space: FamilySpace): Gen<Families> =>
	(source) => {
		const lengths = source.draw(swarm(LENGTHS))
		const lengthGen: Gen<number> = (drawing) => {
			const length = drawing.draw(swarmChoice(lengths, LENGTHS))
			switch (length) {
				case "empty":
					return 0
				case "single":
					return 1
				case "pair":
					return 2
				case "long":
					return drawing.draw(int(space.long.min, space.long.max))
			}
		}
		const counts = source.draw(array(lengthGen, space.owners))
		const total = Arr.reduce(counts, 0, (sum, count) => sum + count)
		const dealt = source.draw(shuffled(indices(total), { min: total, max: total }))
		const families: Array<Family> = []
		let from = 0
		for (const [owner, count] of counts.entries()) {
			families.push({ owner, members: dealt.slice(from, from + count) })
			from += count
		}
		return families
	}

/** An owner keyed by its id and a span WITHOUT OVERLAPS, with its family: the span `[start, end)`, never empty. */
export interface SpanKeyedOwner {
	readonly id: number
	readonly during: { readonly start: number; readonly end: number }
	readonly members: ReadonlyArray<number>
}

/**
 * Owners keyed by an id and a span WITHOUT OVERLAPS, each with the family `familiesGen` draws for it: each owner takes
 * one of two ids and a span that starts at or after the end of the last span of its id, so owners share an id over
 * disjoint spans, adjacent ones among them, and only the id and the span together name an owner.
 */
export const spanOwnersGen =
	(space: FamilySpace): Gen<ReadonlyArray<SpanKeyedOwner>> =>
	(source) => {
		const families = source.draw(familiesGen(space))
		const ends = new Map<number, number>()
		return Arr.map(families, (family) => {
			const id = source.draw(int(0, 1))
			const start = (ends.get(id) ?? 0) + source.draw(int(0, 2))
			const end = start + source.draw(int(1, 3))
			ends.set(id, end)
			return { id, during: { start, end }, members: family.members }
		})
	}

/** What the properties of cycle.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"

/**
 * Plain foreign keys on a cycle, through a served ChangeSet, against a host model of containment: A's `b` is in B's
 * key and B's `a` in A's, each target holding a field outside its key, so both foreign keys are deferred and judged at
 * COMMIT. A ChangeSet that inserts facts of both relations naming each other, in one stratum, commits; one whose final
 * state leaves a reference without its target, an insertion naming a fact nobody holds or a deletion of a fact still
 * named, is refused at COMMIT by the law of a reference it breaks, and nothing of it commits.
 *
 * Each case draws a lawful stored state over ids 1 to 3 and a ChangeSet of insertions of facts at ids nobody stores,
 * referencing ids 1 to 4, and deletions of stored facts. The model: the final state is the stored one less the
 * deletions plus the insertions; it is accepted when every reference meets its target there, with every fact counted,
 * no-change when the ChangeSet changes nothing, and otherwise refused by a law of the references it breaks.
 *
 * Features: accepted, no-change, a cycle inserted in one ChangeSet, a refusal by each reference, and a deletion of a
 * fact still named refused.
 */
export const A = relation("A", { id: pg.integer, b: pg.integer }, ["id"])

export const B = relation("B", { id: pg.integer, a: pg.integer }, ["id"])

export const intoB = contained(on(A, "b"), on(B, "id"))

export const intoA = contained(on(B, "a"), on(A, "id"))

export const Cycle = schema("Cycle", [A, B], [intoB, intoA, mutable(A), mutable(B)])

/** The full world's workload: one ChangeSet inserting and deleting facts of A and B, each call's facts by op. */
const programs = Object.freeze({
	change: ChangeSet.empty(Cycle).insert(A, []).insert(B, []).delete(A, []).delete(B, [])
})

/** A fact of either relation: its key and the key it references in the other. */
export interface Fact {
	readonly id: number
	readonly ref: number
}

/** A lawful stored state: A's ids, B's ids, each fact referencing one of the other's, or nothing stored at all. */
interface Stored {
	readonly a: ReadonlyArray<Fact>
	readonly b: ReadonlyArray<Fact>
}

const storedGen: Gen<Stored> = (source) => {
	const aIds = source.draw(subarray([1, 2, 3]))
	const bIds = source.draw(subarray([1, 2, 3]))
	if (!Arr.isReadonlyArrayNonEmpty(aIds) || !Arr.isReadonlyArrayNonEmpty(bIds)) {
		return { a: [], b: [] }
	}
	return {
		a: Arr.map(aIds, (id) => ({ id, ref: source.draw(element(bIds)) })),
		b: Arr.map(bIds, (id) => ({ id, ref: source.draw(element(aIds)) }))
	}
}

/** A ChangeSet over the stored state: insertions at ids nobody stores, and deletions of stored facts. */
interface Requested {
	readonly insertA: ReadonlyArray<Fact>
	readonly insertB: ReadonlyArray<Fact>
	readonly deleteA: ReadonlyArray<Fact>
	readonly deleteB: ReadonlyArray<Fact>
}

export const minus = (xs: ReadonlyArray<Fact>, ys: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
	Arr.filter(xs, (x) => !Arr.some(ys, (y) => y.id === x.id))

/** The ids 1 to 4 no fact of `stored` holds: where an insertion may go. */
const freeIds = (stored: ReadonlyArray<Fact>): ReadonlyArray<number> =>
	Arr.filter([1, 2, 3, 4], (id) => !Arr.some(stored, (f) => f.id === id))

/**
 * A stored state and a ChangeSet over it: insertions at ids nobody stores, and deletions of stored facts. In the case's
 * lawful arm each insertion references a key the other relation holds after the ChangeSet, its kept facts' or its
 * insertions', so facts inserted together name each other; otherwise any id 1 to 4, keys nobody holds among them.
 */
export const caseGen: Gen<readonly [Stored, Requested]> = (source) => {
	const stored = source.draw(storedGen)
	const deleteA = source.draw(subarray(stored.a))
	const deleteB = source.draw(subarray(stored.b))
	const idsA = source.draw(subarray(freeIds(stored.a)))
	const idsB = source.draw(subarray(freeIds(stored.b)))
	const lawful = source.draw(boolean)
	const into = (kept: ReadonlyArray<Fact>, inserted: ReadonlyArray<number>): Gen<number> => {
		const keys = [...Arr.map(kept, (f) => f.id), ...inserted]
		return lawful && Arr.isReadonlyArrayNonEmpty(keys) ? element(keys) : int(1, 4)
	}
	const keyOfB = into(minus(stored.b, deleteB), idsB)
	const keyOfA = into(minus(stored.a, deleteA), idsA)
	return [
		stored,
		{
			insertA: Arr.map(idsA, (id) => ({ id, ref: source.draw(keyOfB) })),
			insertB: Arr.map(idsB, (id) => ({ id, ref: source.draw(keyOfA) })),
			deleteA,
			deleteB
		}
	] as const
}

/** The references of `from` without their target among `to`'s keys. */
export const dangling = (from: ReadonlyArray<Fact>, to: ReadonlyArray<Fact>): boolean =>
	Arr.some(from, (f) => !Arr.some(to, (t) => t.id === f.ref))

export type CycleFeature =
	| "accepted"
	| "unchanged"
	| "a cycle inserted in one ChangeSet"
	| "refused by A's reference"
	| "refused by B's reference"
	| "a deletion of a fact still named, refused"

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const cycleInstall = Object.freeze({ label: "cycle", programs })

/** Cycle installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const cycleTemplate = fixtureTemplate(import.meta, Cycle, cycleInstall)

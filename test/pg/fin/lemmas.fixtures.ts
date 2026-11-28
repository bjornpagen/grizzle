/** What the properties of lemmas.test.ts read: the box of states, the seats' families and the model's settling. */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Oracle } from "@bjornpagen/testing/property"
import { Array as Arr } from "effect"

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	BREAKING_FORMS,
	type Form,
	LAWFUL_FORMS,
	type Program,
	type ProgramSpace,
	programGen,
	type Settled,
	settledUnder,
	type MutationStatement
} from "#test/support/families/mutate.ts"
import {
	type Constraint,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored,
	successorOf
} from "#test/support/families/theorem.ts"
import { type FamilySeat, familyTemplates } from "#test/support/pg/fin/family.ts"
import { type EndFeature } from "#test/support/pg/fin/installed.ts"
import { upTo } from "#test/support/up-to.ts"

/** Each shape's family installed once per member (family.ts familyTemplates), which every case seats. */
export const lemmaFamilies = familyTemplates(import.meta, "lemma")

/** The box: two owners, each absent or of count 0 to 3, and at most three rows over slots 0 to 4. */
const box = { owners: [0, 1], counts: [0, 1, 2, 3], rows: 3, ats: [0, 1, 2, 3, 4] } as const

/** A state of the box: each owner's count or absence, and its rows as (owner, slot) cells, a multiset in cell order. */
interface StateSketch {
	readonly counts: ReadonlyArray<number | undefined>
	readonly cells: ReadonlyArray<readonly [owner: number, at: number]>
}

const CELLS = Object.freeze(
	Arr.flatMap(box.owners, (o) => Arr.map(box.ats, (at) => [o, at] as const))
)

/** Every multiset of at most `k` cells from index `from` on, in cell order. */
const multisetGen =
	(k: number, from: number): Gen<ReadonlyArray<number>> =>
	(source) => {
		if (k === 0 || source.draw(element([false, true]))) {
			return []
		}
		const first = source.draw(element(nonEmpty(upTo(CELLS.length - 1 - from + 1, (i) => from + i))))
		return [first, ...source.draw(multisetGen(k - 1, first))]
	}

const stateGen: Gen<StateSketch> = (source) => ({
	counts: Arr.map(box.owners, () =>
		source.draw(element<number | undefined>([undefined, ...box.counts]))
	),
	cells: Arr.map(source.draw(multisetGen(box.rows, 0)), (i) => Arr.getUnsafe(CELLS, i))
})

/**
 * The box's states, a case the search steers at a row just past a positive count drawing one (`rowJustPastCount`):
 * owner 0 of count 1 or 2 with a row at each of its slots and at the one past them, owner 1 absent; and at a row of an
 * owner of count 0 (`rowOfEmptyOwner`), which only the holding reference's guard refuses: one row at slot 0 of owner 0
 * of count 0, owner 1 absent.
 */
export const statesGen = aimed(stateGen, [
	[
		"a row just past a positive count",
		(source): StateSketch => {
			const count = source.draw(int(1, 2))
			return { counts: [count, undefined], cells: upTo(count + 1, (at) => [0, at] as const) }
		}
	],
	["a row of an owner of count 0", (): StateSketch => ({ counts: [0, undefined], cells: [[0, 0]] })]
])

/**
 * The stored state of a sketch: each present owner's count, and each row the successor the host draws at its slot in
 * its owner's count (theorem.ts successorOf), a row with no owner its own slot: the one value of ‹s› a lawful state
 * holds, so the state commits exactly when the theorem holds of its slots.
 */
export const storedOfSketch = (sketch: StateSketch): Stored => {
	const owners = new Map<number, number>()
	for (const [o, count] of sketch.counts.entries()) {
		if (count !== undefined) {
			owners.set(o, count)
		}
	}
	return {
		owners,
		rows: Arr.map(sketch.cells, ([group, at], member): FamilyRow => {
			const count = owners.get(group)
			return { group, at, next: count === undefined ? at : successorOf(at, count), member }
		})
	}
}

/** One transaction from no state that writes a stored state: its owners, then its rows in descending slot order. */
export const writeStatements = (stored: Stored): ReadonlyArray<MutationStatement> => {
	const rows = Arr.sort(stored.rows, (a: FamilyRow, b: FamilyRow) =>
		a.at > b.at ? -1 : a.at < b.at ? 1 : 0
	)
	return [
		...Arr.map([...stored.owners], ([owner, count]): MutationStatement => ({
			kind: "create",
			owner,
			count
		})),
		...(Arr.isReadonlyArrayNonEmpty(rows)
			? [{ kind: "insert", rows } satisfies MutationStatement]
			: [])
	]
}

/** What a seat's model settles a transaction over a stored state to: grizzle's every constraint. */
export const settledOn = (
	family: FamilySeat,
	before: Stored,
	statements: ReadonlyArray<MutationStatement>
): Settled => settledUnder(family.shape, () => true, before, statements)

export type StateFeature =
	| `${Shape} ${"committed" | `refused ${Constraint}`}`
	| "a row just past a positive count"
	| "a row of an owner of count 0"
	| EndFeature

/**
 * Whether a state holds an owner of a positive count whose every slot holds one row and so does the slot just past
 * them: the breach only the successor the predecessor and last axes pair refuses, the row there naming the last
 * member its predecessor, which the slots alone would admit.
 */
export const rowJustPastCount = (stored: Stored): boolean =>
	Arr.some([...stored.owners], ([owner, count]) => {
		const slots = Arr.filter(stored.rows, (r) => r.group === owner)
		return (
			count > 0 &&
			slots.length === count + 1 &&
			Arr.every(
				upTo(count + 1, (at) => at),
				(at) => Arr.some(slots, (r) => r.at === at)
			)
		)
	})

/**
 * Whether a state holds a row of an owner of count 0: the breach only the holding reference's guard refuses, its owner
 * stored, at no slot a closure or the last axis reaches from slot 0.
 */
export const rowOfEmptyOwner = (stored: Stored): boolean =>
	Arr.some(stored.rows, (r) => stored.owners.get(r.group) === 0)

export const lemmaOracle: Oracle = {
	kind: "specification",
	name: "the families theorem (test/support/families/theorem.ts) as a checker, beside the families model of each transaction (mutate.ts) judging each installed constraint at its moment"
}

/** The programs' space: one to eight steps over up to three owners, three to five long. */
const programSpace: ProgramSpace = {
	families: { owners: { min: 0, max: 3 }, long: { min: 3, max: 5 } },
	steps: { min: 1, max: 8 }
}

/** A random program of family mutations over a drawn shape. */
export const programs: Gen<Program> = (source) =>
	source.draw(programGen(source.draw(element(SHAPES)), programSpace))

export type ProgramFeature = `${Shape} ${Form} ${"committed" | "refused"}` | EndFeature

/** Each lawful form committed and each breaking form and misorder refused, on each shape, and both ends. */
export const programSituations: ReadonlyArray<Reached<ProgramFeature>> = nonEmpty(
	[
		"a case ended by COMMIT",
		"a case ended by SET CONSTRAINTS and ROLLBACK",
		...Arr.flatMap(SHAPES, (shape): ReadonlyArray<ProgramFeature> => [
			...Arr.map(
				Arr.filter(LAWFUL_FORMS, (f) => shape === "ordered" || (f !== "insert-at" && f !== "swap")),
				(f): ProgramFeature => `${shape} ${f} committed`
			),
			...Arr.map(BREAKING_FORMS, (f): ProgramFeature => `${shape} ${f} refused`),
			`${shape} misorder committed`,
			`${shape} misorder refused`
		])
	],
	"the program situations"
)

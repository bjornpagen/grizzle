/** What the properties of lemmas.test.ts read: the box of states, the seats' families and the model's settling. */

import type { Reached } from "@bjornpagen/testing/features"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Oracle } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"

import { nonEmpty } from "@bjornpagen/testing/assert"
import { quoteString } from "#compiler/core/text.ts"
import { cataloguedOf, type FamilySeat, familyTemplates } from "#test/pg/fin/family.ts"
import { type EndFeature } from "#test/pg/fin/installed.ts"
import { predicted as substratePredicted } from "#test/pg/substrate/fin.ts"
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
	type Stored
} from "#test/support/families/theorem.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** A seat: grizzle's family of a shape, and how its closure's ‹p› is restricted. */
export interface LemmaSeat {
	readonly family: FamilySeat
	/**
	 * Whether the installed closure's ‹p› is restricted below the copy, `CASE WHEN i > 0 AND i < ‹n› THEN i − 1 END` as
	 * fin.md §5.2 states it, or plain pred(i), read off its generation expression: the two judge alike while the bound
	 * stands, and apart once the bound is dropped, since an unrestricted ‹p› also refuses a gap above the count.
	 */
	readonly restriction: "restricted" | "unrestricted"
}

/** A family seat's lemma seat, its closure's ‹p› read off the catalog's generation expression of ‹p›. */
export const lemmaSeatOf = (f: FamilySeat) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const closure = cataloguedOf(f, "closure")
		const p = Option.getOrThrow(Arr.findFirst(closure.columns, (c) => c !== "g"))
		const [row] = yield* s.admin.queryValues(
			`SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) FROM pg_catalog.pg_attrdef AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = '${f.seat.table("Member")}'::regclass AND a.attname = ${quoteString(Str.slice(1, -1)(f.seat.column("Member", p)))}`,
			[]
		)
		const expr = typeof row?.[0] === "string" ? row[0] : ""
		const seat: LemmaSeat = {
			family: f,
			restriction: Str.includes(Str.slice(1, -1)(f.seat.column("Member", "‹n›")))(expr)
				? "restricted"
				: "unrestricted"
		}
		return seat
	})

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

export const stateGen: Gen<StateSketch> = (source) => ({
	counts: Arr.map(box.owners, () =>
		source.draw(element<number | undefined>([undefined, ...box.counts]))
	),
	cells: Arr.map(source.draw(multisetGen(box.rows, 0)), (i) => Arr.getUnsafe(CELLS, i))
})

/**
 * The stored state of a sketch: each present owner's count, each row its owner's count's copy, and a row with no owner
 * a copy above every slot, 5, so its bound holds and the copy's foreign key is what refuses it.
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
		rows: Arr.map(sketch.cells, ([group, at], member): FamilyRow => ({
			group,
			at,
			copy: owners.get(group) ?? 5,
			member
		}))
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
	seat: LemmaSeat,
	before: Stored,
	statements: ReadonlyArray<MutationStatement>
): Settled => {
	if (seat.restriction === "restricted") {
		return settledUnder(seat.family.shape, () => true, before, statements)
	}
	/** An unrestricted closure: G2's substrate model of every constraint, the closure read as plain pred. */
	const model = substratePredicted(
		{
			direction: "mirrors",
			copy: "statement",
			last: "commit",
			closure: seat.family.shape === "ordered" ? "statement" : "commit",
			restriction: "unrestricted"
		},
		before,
		statements
	)
	return model.kind === "committed" ? { kind: "committed", stored: model.after } : model
}

export type StateFeature = `${Shape} ${"committed" | `refused ${Constraint}`}` | EndFeature

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

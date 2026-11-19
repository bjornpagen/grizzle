/** What the properties of bits.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Option } from "effect"
import { indices } from "#compiler/core/array.ts"

/** PostgreSQL's, the host's or the reference's answer differs from another's, with all three spelt out. */
export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The widths where a word or a byte of either representation begins or ends. */
export const WIDTHS = [0, 1, 7, 8, 9, 31, 32, 33, 63, 64, 65] as const

/** The widest width a case draws past the named ones. */
const drawnWidths = { min: 0, max: 200 } as const

/** How a set is drawn against A, so each law is met both ways. */
const RELATIONS = ["independent", "superset", "disjoint", "one of A"] as const

type Relation = (typeof RELATIONS)[number]

/** One case: a width, three sets, a substring's start and length, a cell read, and the sets a fold folds. */
interface BitCase {
	readonly width: number
	readonly a: ReadonlyArray<boolean>
	readonly b: ReadonlyArray<boolean>
	readonly k: ReadonlyArray<boolean>
	readonly from: number
	readonly length: number
	readonly cellWidth: number
	readonly cellIndex: number
	readonly folded: ReadonlyArray<ReadonlyArray<boolean>>
}

/** A set of `width` positions at a drawn density: each position a member with probability ⌈density⌉ of four. */
const setGen =
	(width: number): Gen<ReadonlyArray<boolean>> =>
	(source) => {
		const density = source.draw(int(0, 4))
		return Arr.map(indices(width), () => source.draw(int(1, 4)) <= density)
	}

/** A set drawn against `a` by a relation. */
const relatedGen =
	(a: ReadonlyArray<boolean>): Gen<ReadonlyArray<boolean>> =>
	(source) => {
		const relation: Relation = source.draw(element(RELATIONS))
		const drawnSet = source.draw(setGen(a.length))
		switch (relation) {
			case "independent":
				return drawnSet
			case "superset":
				return Arr.map(a, (m, i) => m || drawnSet[i] === true)
			case "disjoint":
				return Arr.map(a, (m, i) => !m && drawnSet[i] === true)
			case "one of A": {
				const own = Arr.filter(indices(a.length), (i) => a[i] === true)
				const one = Arr.isReadonlyArrayNonEmpty(own) ? source.draw(element(own)) : -1
				return Arr.map(a, (m, i) => i === one || (!m && drawnSet[i] === true))
			}
		}
	}

/** The cell widths that divide a width, one to 32: a constant is a whole number of cells. */
const cellWidths = (width: number): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(indices(32), (i) => i + 1),
		(w) => width % w === 0
	)

export const caseGen: Gen<BitCase> = (source) => {
	const width = source.draw(element([...WIDTHS, -1] as const))
	const n = width >= 0 ? width : source.draw(int(drawnWidths.min, drawnWidths.max))
	const a = source.draw(setGen(n))
	const widths = cellWidths(n)
	const w = Arr.isReadonlyArrayNonEmpty(widths) ? source.draw(element(widths)) : 1
	return {
		width: n,
		a,
		b: source.draw(relatedGen(a)),
		k: source.draw(relatedGen(a)),
		from: source.draw(int(-2, n + 2)),
		length: source.draw(int(0, n + 2)),
		cellWidth: w,
		cellIndex: source.draw(int(-1, Math.floor(n / w) + 1)),
		folded: source.draw(array(setGen(n), { min: 0, max: 4 }))
	}
}

export const textOf = (set: ReadonlyArray<boolean>): string =>
	Arr.join(
		Arr.map(set, (m) => (m ? "1" : "0")),
		""
	)

export const literalOf = (set: ReadonlyArray<boolean>): string => `B'${textOf(set)}'`

/** The reference: a set's members, as a Set of positions. */
export const positions = (set: ReadonlyArray<boolean>): ReadonlySet<number> =>
	new Set(Arr.filter(indices(set.length), (i) => set[i] === true))

/** A reference set's text over `width` positions. */
export const spelt = (width: number, members: (i: number) => boolean): string =>
	Arr.join(
		Arr.map(indices(width), (i) => (members(i) ? "1" : "0")),
		""
	)

/** The planes of a fold as unrolled SQL: each set's step `twos | (ones & x)`, then `ones | x`, from the empty planes. */
export const foldSql = (
	width: number,
	sets: ReadonlyArray<ReadonlyArray<boolean>>
): readonly [string, string] =>
	Arr.reduce(
		sets,
		[
			literalOf(Arr.map(indices(width), () => false)),
			literalOf(Arr.map(indices(width), () => false))
		] as const,
		([ones, twos], set): readonly [string, string] => [
			`(${ones} | ${literalOf(set)})`,
			`(${twos} | (${ones} & ${literalOf(set)}))`
		]
	)

/** A width as a feature: one of the named widths, or a drawn one. */
export const widthFeature = (n: number): BitFeature =>
	Option.match(
		Arr.findFirst(WIDTHS, (w) => w === n),
		{ onNone: (): BitFeature => "a drawn width", onSome: (w): BitFeature => `width ${w}` }
	)

export type BitFeature =
	| `width ${(typeof WIDTHS)[number]}`
	| "a drawn width"
	| `subset ${boolean}`
	| `disjoint ${boolean}`
	| `at least one ${boolean}`
	| `at most one ${boolean}`
	| `at most one through the fold ${boolean}`
	| "a substring past either end"
	| "a cell past either end"

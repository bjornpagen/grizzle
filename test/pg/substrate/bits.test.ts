/**
 * The bit algebra of fin.md §16 on PostgreSQL 19rc1, differentially: PostgreSQL's `bit(n)` operators (`&`, `|`, `#`,
 * `~`, `bit_count`, `substring`), the set laws written with them (subset, disjointness, at least one, at most one), and
 * the saturating two-plane fold, against the host bitsets (packages/engine/src/codec/bits.ts) where the host has the
 * operation, and a naive reference, a `Set<number>` of positions.
 *
 * Oracles: a second implementation twice over. Every operation the host has (and, or, the difference, the count, the
 * members, a cell read) must agree with PostgreSQL and with the reference; those PostgreSQL has and the host has not
 * (`#`, `~`, the two-plane fold) agree with the reference; and each law PostgreSQL evaluates agrees with the law read off
 * the reference: A ⊆ B, A ∩ B = ∅, A ∩ K ≠ ∅, |A ∩ K| ≤ 1, and, through the twos plane, no member of K in two of the
 * folded sets. The fold is commutative, so both orders of the sets must give the same planes.
 *
 * The widths are where a word or a byte begins or ends (doctrine rule 10): 0, 1, 7, 8, 9, 31, 32, 33, 63, 64 and 65, and
 * one drawn up to 200. Sets are drawn at a density the case draws, and B and K are drawn against A as a superset, a
 * disjoint set, one member of A, or independently, so every law is met both ways.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import {
	and,
	andNot,
	cell,
	copy,
	count,
	fromText,
	members,
	or,
	toText
} from "#compiler/codec/bits.ts"
import { indices } from "#compiler/core/array.ts"
import { deepEquals } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** PostgreSQL's, the host's or the reference's answer differs from another's, with all three spelt out. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The widths where a word or a byte of either representation begins or ends. */
const WIDTHS = [0, 1, 7, 8, 9, 31, 32, 33, 63, 64, 65] as const

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

const caseGen: Gen<BitCase> = (source) => {
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

const textOf = (set: ReadonlyArray<boolean>): string =>
	Arr.join(
		Arr.map(set, (m) => (m ? "1" : "0")),
		""
	)

const literalOf = (set: ReadonlyArray<boolean>): string => `B'${textOf(set)}'`

/** The reference: a set's members, as a Set of positions. */
const positions = (set: ReadonlyArray<boolean>): ReadonlySet<number> =>
	new Set(Arr.filter(indices(set.length), (i) => set[i] === true))

/** A reference set's text over `width` positions. */
const spelt = (width: number, members: (i: number) => boolean): string =>
	Arr.join(
		Arr.map(indices(width), (i) => (members(i) ? "1" : "0")),
		""
	)

/** The planes of a fold as unrolled SQL: each set's step `twos | (ones & x)`, then `ones | x`, from the empty planes. */
const foldSql = (
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
const widthFeature = (n: number): BitFeature =>
	Option.match(
		Arr.findFirst(WIDTHS, (w) => w === n),
		{ onNone: (): BitFeature => "a drawn width", onSome: (w): BitFeature => `width ${w}` }
	)

type BitFeature =
	| `width ${(typeof WIDTHS)[number]}`
	| "a drawn width"
	| `subset ${boolean}`
	| `disjoint ${boolean}`
	| `at least one ${boolean}`
	| `at most one ${boolean}`
	| `at most one through the fold ${boolean}`
	| "a substring past either end"
	| "a cell past either end"

layer(Substrate.layer)("the bit algebra of fin.md §16 on PostgreSQL 19rc1", (it) => {
	it.effect(
		"compute every bit(n) operator, law and twos fold as the host bitsets and the reference set do",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const db = yield* s.session({ ...ownerSession(), label: "bits" })
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "a Set<number> of positions, and the host bitsets (packages/engine/src/codec/bits.ts) wherever the host has the operation"
							},
							suite: "substrate/bits",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<BitFeature>(
								[
									...Arr.map(WIDTHS, (w): BitFeature => `width ${w}`),
									"a drawn width",
									"subset true",
									"subset false",
									"disjoint true",
									"disjoint false",
									"at least one true",
									"at least one false",
									"at most one true",
									"at most one false",
									"at most one through the fold true",
									"at most one through the fold false",
									"a substring past either end",
									"a cell past either end"
								],
								{ cases: 2000, sense: notesOnly }
							),
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const n = c.width
								const [A, B, K] = [positions(c.a), positions(c.b), positions(c.k)]
								const [ones, twos] = foldSql(n, c.folded)
								const [onesBack, twosBack] = foldSql(n, Arr.reverse(c.folded))
								const read = `substring(a FROM ${c.cellIndex * c.cellWidth + 1} FOR ${c.cellWidth})::int4`
								const [row = []] = yield* db.values(
									`SELECT (a & b)::text, (a | b)::text, (a # b)::text, (~a)::text, bit_count(a)::int4, substring(a FROM ${c.from} FOR ${c.length})::text, bit_count(a & ~b) = 0, bit_count(a & b) = 0, bit_count(a & k) <> 0, bit_count(a & k) <= 1, ${read}, ${ones}::text, ${twos}::text, ${onesBack}::text, ${twosBack}::text, bit_count(${twos} & k) = 0 FROM (SELECT ${literalOf(c.a)} AS a, ${literalOf(c.b)} AS b, ${literalOf(c.k)} AS k) AS v`,
									[]
								)
								const counts = Arr.map(
									indices(n),
									(i) => Arr.filter(c.folded, (set) => set[i] === true).length
								)
								const first = Math.max(c.from, 1)
								const last = Math.min(c.from + c.length - 1, n)
								const reference = {
									and: spelt(n, (i) => A.has(i) && B.has(i)),
									or: spelt(n, (i) => A.has(i) || B.has(i)),
									xor: spelt(n, (i) => A.has(i) !== B.has(i)),
									not: spelt(n, (i) => !A.has(i)),
									count: A.size,
									members: Arr.filter(indices(n), (i) => A.has(i)),
									substring: Str.slice(
										first - 1,
										Math.max(last, first - 1)
									)(spelt(n, (i) => A.has(i))),
									subset: Arr.every(Array.from(A), (i) => B.has(i)),
									disjoint: Arr.every(Array.from(A), (i) => !B.has(i)),
									least: Arr.some(Array.from(A), (i) => K.has(i)),
									most: Arr.filter(Array.from(A), (i) => K.has(i)).length <= 1,
									cell: Arr.reduce(
										Arr.filter(
											indices(c.cellWidth),
											(j) => c.cellIndex >= 0 && c.cellIndex * c.cellWidth + j < n
										),
										0,
										(value, j) =>
											A.has(c.cellIndex * c.cellWidth + j)
												? value | (1 << (c.cellWidth - 1 - j))
												: value
									),
									ones: spelt(n, (i) => (counts[i] ?? 0) >= 1),
									twos: spelt(n, (i) => (counts[i] ?? 0) >= 2),
									foldMost: Arr.every(Array.from(K), (i) => (counts[i] ?? 0) <= 1)
								}
								const hostAnd = copy(fromText(textOf(c.a)))
								and(hostAnd, fromText(textOf(c.b)))
								const hostOr = copy(fromText(textOf(c.a)))
								or(hostOr, fromText(textOf(c.b)))
								const hostDiff = copy(fromText(textOf(c.a)))
								andNot(hostDiff, fromText(textOf(c.b)))
								const hostA = fromText(textOf(c.a))
								const [
									andPg,
									orPg,
									xorPg,
									notPg,
									countPg,
									substringPg,
									subsetPg,
									disjointPg,
									leastPg,
									mostPg,
									cellPg,
									onesPg,
									twosPg,
									onesBackPg,
									twosBackPg,
									foldMostPg
								] = row
								/** Each answer beside the reference's: PostgreSQL's for every operation, the host's for each it has. */
								const checks: ReadonlyArray<
									readonly [what: string, actual: unknown, expected: unknown]
								> = [
									["PostgreSQL's &", andPg, reference.and],
									["PostgreSQL's |", orPg, reference.or],
									["PostgreSQL's #", xorPg, reference.xor],
									["PostgreSQL's ~", notPg, reference.not],
									["PostgreSQL's bit_count", countPg, reference.count],
									["PostgreSQL's substring", substringPg, reference.substring],
									["PostgreSQL's subset law", subsetPg, reference.subset],
									["PostgreSQL's disjointness law", disjointPg, reference.disjoint],
									["PostgreSQL's at-least-one law", leastPg, reference.least],
									["PostgreSQL's at-most-one law", mostPg, reference.most],
									["PostgreSQL's cell read", cellPg, reference.cell],
									["PostgreSQL's ones plane", onesPg, reference.ones],
									["PostgreSQL's twos plane", twosPg, reference.twos],
									["PostgreSQL's ones plane, the sets reversed", onesBackPg, reference.ones],
									["PostgreSQL's twos plane, the sets reversed", twosBackPg, reference.twos],
									[
										"PostgreSQL's at-most-one law through the twos plane",
										foldMostPg,
										reference.foldMost
									],
									["the host's and", toText(hostAnd), reference.and],
									["the host's or", toText(hostOr), reference.or],
									["the host's count", count(hostA), reference.count],
									["the host's members", members(hostA), reference.members],
									["the host's subset law", count(hostDiff) === 0, reference.subset],
									["the host's cell read", cell(hostA, c.cellIndex, c.cellWidth), reference.cell]
								]
								for (const [what, actual, expected] of checks) {
									if (!deepEquals(actual, expected)) {
										return yield* new Disagreed({
											message: `${what} is ${Formatter.format(actual)}, the reference's ${Formatter.format(expected)}, for ${Formatter.format(c)}`
										})
									}
								}
								k.note(widthFeature(n))
								k.note(`subset ${reference.subset}`)
								k.note(`disjoint ${reference.disjoint}`)
								k.note(`at least one ${reference.least}`)
								k.note(`at most one ${reference.most}`)
								k.note(`at most one through the fold ${reference.foldMost}`)
								if (c.from < 1 || c.from + c.length - 1 > n) {
									k.note("a substring past either end")
								}
								if (c.cellIndex < 0 || (c.cellIndex + 1) * c.cellWidth > n) {
									k.note("a cell past either end")
								}
							})
					)
				})
			)
	)
})

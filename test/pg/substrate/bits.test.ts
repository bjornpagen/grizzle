/**
 * The bit algebra of fin.md §16 on PostgreSQL 19, differentially: PostgreSQL's `bit(n)` operators (`&`, `|`, `#`,
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

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
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
import {
	type BitFeature,
	caseGen,
	Disagreed,
	foldSql,
	literalOf,
	positions,
	spelt,
	textOf,
	widthFeature,
	WIDTHS
} from "#test/pg/substrate/bits.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The bit algebra of fin.md §16 on PostgreSQL 19 compute every bit(n) operator, law and twos fold as the host bitsets and the reference set do.
 *
 * Its pre-conversion budget: runs 400, coverage cases 2000 (test/pg/substrate/bits.test.ts at d8eed1786).
 */
export const theBitAlgebraOfFinMd16OnPostgreSQL19ComputeEveryBitNOperatorLawAndTwosFoldAsTheHostBitsetsAndTheReferenceSetDo =
	property.explore(caseGen, {
		needs: { tx: Substrate.transaction },
		situations: [
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
		] satisfies ReadonlyArray<Reached<BitFeature>>,
		check:
			({ tx }, k: Case<BitFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx

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
						substring: Str.slice(first - 1, Math.max(last, first - 1))(spelt(n, (i) => A.has(i))),
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
								A.has(c.cellIndex * c.cellWidth + j) ? value | (1 << (c.cellWidth - 1 - j)) : value
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
					const checks: ReadonlyArray<readonly [what: string, actual: unknown, expected: unknown]> =
						[
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
				}),
		oracle: {
			kind: "second-implementation",
			name: "a Set<number> of positions, and the host bitsets (packages/engine/src/codec/bits.ts) wherever the host has the operation"
		},
		budget: { runs: 400, steered: 2000 },
		kept: [],
		kills: []
	})

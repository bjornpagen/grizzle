import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { agreementCounts, deliveredAgree, within } from "#bench/query/support/kit.ts"
import { assert, defined } from "#test/support/assert.ts"

/**
 * The query kit's agreement judgments, against independent models.
 *
 * - `within(tolerance)` agrees on two keyed lists of numeric texts exactly when every key occurs once on each side and
 *   its two values are equal texts or within the tolerance as numbers: a repeated key, a key on one side only, or a
 *   difference above the tolerance disagrees. `agreementCounts` counts as unmatched exactly the keys on one side only.
 * - `deliveredAgree` compares delivered values as multisets of rows: a permutation of the rows agrees, a permutation
 *   inside a nested array agrees as a multiset and disagrees in order unless it changed nothing, and a changed field
 *   disagrees.
 */
type KeyedRows = ReadonlyArray<readonly [string, string]>

const keys = ["a", "b", "c", "d"] as const

/**
 * Decimal texts whose numbers are equal, near, apart or not numbers at all: "1" and "1.0000000001" agree within 1e-9,
 * "1" and "1.001" within 1e-3 only, "0" and "-0" as numbers, "NaN" only with itself.
 */
const valueGen = element(["0", "1", "1.0000000001", "1.001", "-0", "NaN", "2"])

/** At most six rows over four keys: enough for a key repeated on a side, a key on one side only and a key on both. */
const keyedRowsGen: Gen<KeyedRows> = array(
	(source) => [source.draw(element(keys)), source.draw(valueGen)] as const,
	{ min: 0, max: 6 }
)

const valuesOf = (rows: KeyedRows, key: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(rows, ([k]) => k === key),
		([, v]) => v
	)

const close = (a: string, b: string, tolerance: number): boolean =>
	a === b || Math.abs(Number(a) - Number(b)) <= tolerance

type WithinFeature =
	| "repeated key left"
	| "repeated key right"
	| "key only left"
	| "key only right"
	| "difference above tolerance"
	| "agree within tolerance"
	| "agree exactly"

describe("the query kit's keyed numeric agreement", () => {
	it.effect("within agrees exactly when the keyed values match within the tolerance", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/bench/within",
					draw: drawn(
						(source) =>
							[
								source.draw(keyedRowsGen),
								source.draw(keyedRowsGen),
								source.draw(element([0, 1e-9, 1e-3]))
							] as const
					),
					literal: Formatter.format,
					features: features<WithinFeature>([
						"repeated key left",
						"repeated key right",
						"key only left",
						"key only right",
						"difference above tolerance",
						"agree within tolerance",
						"agree exactly"
					]),
					kept: [],
					runs: 200,
					shrink: { kind: "bounded", candidates: 150 },
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				([left, right, tolerance], c) =>
					Effect.sync(() => {
						let agrees = true
						let unmatched = 0
						for (const key of keys) {
							const l = valuesOf(left, key)
							const r = valuesOf(right, key)
							if (l.length > 1) {
								c.note("repeated key left")
							}
							if (r.length > 1) {
								c.note("repeated key right")
							}
							if (l.length > 0 && r.length === 0) {
								c.note("key only left")
								unmatched++
							}
							if (r.length > 0 && l.length === 0) {
								c.note("key only right")
								unmatched++
							}
							const [a] = l
							const [b] = r
							if (l.length !== r.length || l.length > 1) {
								agrees = false
							} else if (a !== undefined && b !== undefined) {
								if (a === b) {
									c.note("agree exactly")
								} else if (close(a, b, tolerance)) {
									c.note("agree within tolerance")
								} else {
									c.note("difference above tolerance")
									agrees = false
								}
							}
						}
						assert.equal(Option.isNone(within(tolerance)(left, right)), agrees)
						assert.equal(agreementCounts(tolerance, left, right).unmatched, unmatched)
					})
			)
		)
	)
})

interface Delivered {
	readonly id: bigint
	readonly xs: ReadonlyArray<number>
}

type DeliveredFeature = "permutation" | "nested permutation" | "changed field"

const sameOrder = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

describe("the query kit's delivered agreement", () => {
	it.effect("deliveredAgree is multiset equality of delivered values", (ctx) =>
		Effect.gen(function* () {
			const rowsGen: Gen<ReadonlyArray<Delivered>> = array(
				(source) => ({
					id: source.draw(bigint(0n, 3n)),
					xs: source.draw(array(int(0, 2), { min: 0, max: 3 }))
				}),
				{ min: 0, max: 5 }
			)
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/bench/delivered-agree",
						draw: drawn(
							(source) =>
								[
									source.draw(rowsGen),
									source.draw(int(0, 2 ** 31 - 1)),
									source.draw(boolean)
								] as const
						),
						literal: Formatter.format,
						features: features<DeliveredFeature>([
							"permutation",
							"nested permutation",
							"changed field"
						]),
						kept: [],
						runs: 200,
						shrink: { kind: "bounded", candidates: 150 },
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					([rows, n, reverse], c) =>
						Effect.sync(() => {
							const ordered = deliveredAgree("ordered")
							const multiset = deliveredAgree("multiset")
							if (rows.length === 0) {
								return
							}
							/** A permutation: the rows rotated by n, reversed when drawn so. */
							const at = n % rows.length
							const rotated = [...rows.slice(at), ...rows.slice(0, at)]
							const permuted = reverse ? Arr.reverse(rotated) : rotated
							if (Arr.some(permuted, (r, i) => r !== rows[i])) {
								c.note("permutation")
							}
							assert.deepEqual(multiset(rows, permuted), Option.none())
							assert.deepEqual(ordered(rows, permuted), Option.none())
							/** A nested permutation: the n-th row's array reversed. */
							const nested = Arr.map(rows, (r, i) =>
								i === at ? { id: r.id, xs: Arr.reverse(r.xs) } : r
							)
							const target = defined(rows[at])
							const unchanged = sameOrder(target.xs, Arr.reverse(target.xs))
							if (!unchanged) {
								c.note("nested permutation")
							}
							assert.deepEqual(multiset(rows, nested), Option.none())
							assert.equal(Option.isNone(ordered(rows, nested)), unchanged)
							/** A changed field: the n-th row's id, or its first element, moved outside every drawn value. */
							const changed = Arr.map(rows, (r, i) =>
								i !== at
									? r
									: reverse || r.xs.length === 0
										? { id: r.id + 4n, xs: r.xs }
										: { id: r.id, xs: Arr.map(r.xs, (x, j) => (j === 0 ? x + 3 : x)) }
							)
							c.note("changed field")
							assert.notDeepEqual(multiset(rows, changed), Option.none())
							assert.notDeepEqual(ordered(rows, changed), Option.none())
						})
				)
			)
		})
	)
})

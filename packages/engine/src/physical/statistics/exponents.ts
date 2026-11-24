import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"

/**
 * The exponents of a relation's declared statistics (physical/statistics/declared.ts), found by a raise from all ones
 * whose work is polynomial in the system's size.
 *
 * Each anchor `a` of a relation, a column whose values PostgreSQL is told are a fixed number of rows each at any size of
 * the table, holds 2^y_a rows a value; each other column `c` the planner multiplies by halves a bound set's rows
 * 2^x_c times. A bound is one column set over one anchor, the anchor among its columns and no other, its other
 * columns `columns`; a pair of anchors a declared dependency ties is an anchor of its own here, its exponent the
 * pair's (declared.ts):
 * - a key binds at most one row: Σ x_c ≥ y_a;
 * - a set apart, which holds no key, binds two rows or more: Σ x_c ≤ y_a − 1 (an anchor that is no key alone is a set
 *   apart with no other column, y_a ≥ 1; one that is a key alone a key with none, y_a = 0).
 * The unknowns are integers, y_a ≥ 0 and x_c ≥ 1: PostgreSQL rounds a declared absolute number of distinct values to an
 * integer (selfuncs.c get_variable_numdistinct, clamp_row_est), and every column at least halves the rows it binds.
 *
 * The least such integers, the least largest anchor exponent first, are no search to make in polynomial work: the
 * system is an integer program over sums of columns, a threshold realization of bounded weights, and a search of its
 * box, each column from 1 to the largest exponent, is exponential in its columns, as e2abf18f2's was. So the exponents
 * are what a raise reaches, each step polynomial and the steps bounded:
 * - every column starts at 1, and each anchor's exponent is 1 more than its largest set apart's sum, or 0;
 * - a key whose sum falls short of its anchor's exponent, against its largest set apart `S`, raises one of its columns
 *   `S` does not hold by the shortfall (`raiser`): the last whose raise leaves every other key meeting its anchor's
 *   exponent and the largest exponent where it stands, else the last that leaves every other key meeting it, else the
 *   last. A raise of a key's column lowers no bound of that key, so each key meets all its anchor's sets apart after at
 *   most one raise for each;
 * - the keys are raised in order, round after round, until a round raises none: a raise is felt only by the sets apart
 *   that hold its column, so a chain of raises, each felt by the next key, ends within as many rounds as the system has
 *   keys where it holds no cycle; past that many rounds and one more the raise is ended.
 * What the raise cannot meet is refused in one of two ways:
 * - a crossing, which holds no solution at all, by its proof: a key held whole by a set apart over its anchor
 *   (Σ_K x ≤ Σ_S x ≤ y − 1 < y ≤ Σ_K x); or the key and set apart pairs of the raise's last round, where their
 *   differences 1_K − 1_S sum to no positive column: then no x > 0 meets them all (Gordan's alternative);
 * - otherwise an unsettled raise: grizzle's raise found no exponents within its rounds, which the system may hold all the
 *   same, so it is a limitation of grizzle's, refused as one.
 * The work is at most keys + 1 rounds, each raising every key at most once for each set apart over its anchor, each
 * raise weighing each of the key's columns against every bound: polynomial in the system's bounds and columns. Over
 * metis's, edullm's and den's 621 tables the raise declares what e2abf18f2's exact search did, table for table.
 */

/** One bound of a system, over an anchor and other columns by their positions (see the module's doc). */
export interface Bound {
	readonly kind: "key" | "apart"
	readonly anchor: number
	readonly columns: ReadonlyArray<number>
}

/** A system of bounds over `anchors` anchors and `columns` other columns, each by its position. */
export interface ExponentSystem {
	readonly anchors: number
	readonly columns: number
	readonly bounds: ReadonlyArray<Bound>
}

/**
 * The exponents the raise reaches, each anchor's and each column's by position; a crossing: the system holds none, and
 * `bounds`, by their positions in the system, hold none together; or an unsettled raise: `bounds`, the keys and sets
 * apart of the raise's last round, which grizzle's raise did not meet within its rounds (see the module's doc). Each
 * with the raises made, the work the module's doc bounds.
 */
export type Exponents =
	| {
			readonly kind: "exponents"
			readonly anchors: ReadonlyArray<number>
			readonly columns: ReadonlyArray<number>
			readonly raises: number
	  }
	| {
			readonly kind: "crossing"
			readonly bounds: NonEmptyReadonlyArray<number>
			readonly raises: number
	  }
	| {
			readonly kind: "unsettled"
			readonly bounds: NonEmptyReadonlyArray<number>
			readonly raises: number
	  }

/** Two bounds are one where they hold one kind, one anchor and one set of columns. */
const boundKey = (b: Bound): string =>
	`${b.kind}\u0000${b.anchor}\u0000${[...new Set(b.columns)].toSorted((x, y) => x - y).join(",")}`

/** A bound of the system, by its position, with its set of columns. */
interface Placed {
	readonly at: number
	readonly bound: Bound
	readonly columns: ReadonlySet<number>
}

/** The positions of `placed`, ascending, as a refusal names them. */
const positions = (placed: ReadonlyArray<Placed>): NonEmptyReadonlyArray<number> => {
	const [first, ...rest] = [...new Set(placed.map((p) => p.at))].toSorted((x, y) => x - y)
	if (first === undefined) {
		throw defect("a refusal names a bound")
	}
	return [first, ...rest]
}

/** The sum of `x` over `columns`. */
const sumOf = (columns: ReadonlySet<number>, x: ReadonlyArray<number>): number => {
	let s = 0
	for (const c of columns) {
		s += defined(x[c], "a column's exponent")
	}
	return s
}

/** The set apart over an anchor of the largest sum under `x`, the first of them; none where the anchor holds none. */
const largest = (aparts: ReadonlyArray<Placed>, x: ReadonlyArray<number>): Placed | undefined => {
	let top: Placed | undefined
	let most = -1
	for (const p of aparts) {
		const s = sumOf(p.columns, x)
		if (s > most) {
			top = p
			most = s
		}
	}
	return top
}

/** Each anchor's exponent under `x`: 1 more than its largest set apart's sum, or 0. */
const floors = (
	aparts: ReadonlyArray<ReadonlyArray<Placed>>,
	x: ReadonlyArray<number>
): ReadonlyArray<number> =>
	aparts.map((overA) => {
		const top = largest(overA, x)
		return top === undefined ? 0 : 1 + sumOf(top.columns, x)
	})

/**
 * The column a short key `k` raises by `shortfall` against its largest set apart `top`: of its columns `top` does not
 * hold, the last whose raise leaves every key meeting its anchor's exponent and the largest exponent where it stands;
 * else the last whose raise leaves every key meeting its anchor's exponent; else the last.
 */
const raiser = (
	keys: ReadonlyArray<ReadonlyArray<Placed>>,
	aparts: ReadonlyArray<ReadonlyArray<Placed>>,
	x: ReadonlyArray<number>,
	k: Placed,
	top: Placed,
	shortfall: number
): number => {
	const open = [...k.columns].filter((c) => !top.columns.has(c)).toSorted((p, q) => p - q)
	const before = floors(aparts, x)
	const most = before.reduce((m, y) => Math.max(m, y), 0)
	const effect = (c: number) => {
		const after = x.map((v, i) => (i === c ? v + shortfall : v))
		const raised = floors(aparts, after)
		const short = keys.some((overA, a) =>
			overA.some(
				(other) =>
					other !== k &&
					sumOf(other.columns, x) >= defined(before[a], "a floor") &&
					sumOf(other.columns, after) < defined(raised[a], "a floor")
			)
		)
		return { short, higher: raised.some((y) => y > most) }
	}
	const effects = open.map((c) => ({ c, ...effect(c) }))
	return defined(
		effects.findLast((e) => !e.short && !e.higher)?.c ??
			effects.findLast((e) => !e.short)?.c ??
			open.at(-1),
		"a key no set apart over its anchor holds whole holds a column it does not"
	)
}

/** The crossing a key and a set apart over its anchor holding it whole prove (see the module's doc), or none. */
const staticCrossing = (
	keys: ReadonlyArray<ReadonlyArray<Placed>>,
	aparts: ReadonlyArray<ReadonlyArray<Placed>>
): NonEmptyReadonlyArray<number> | undefined => {
	for (const [a, overA] of keys.entries()) {
		for (const k of overA) {
			const holding = defined(aparts[a], "an anchor's sets apart").find((s) =>
				[...k.columns].every((c) => s.columns.has(c))
			)
			if (holding !== undefined) {
				return positions([k, holding])
			}
		}
	}
	return undefined
}

/**
 * Whether the differences 1_K − 1_S of `raised`'s key and set apart pairs sum to no positive column: then no exponents
 * above 0 meet them all (Gordan's alternative).
 */
const certified = (raised: ReadonlyArray<readonly [Placed, Placed]>, columns: number): boolean => {
	const sum = Array.from({ length: columns }, () => 0)
	for (const [k, s] of raised) {
		for (const c of k.columns) {
			sum[c] = defined(sum[c], "a column") + 1
		}
		for (const c of s.columns) {
			sum[c] = defined(sum[c], "a column") - 1
		}
	}
	return sum.every((v) => v <= 0)
}

/** The exponents the raise reaches, a crossing, or an unsettled raise (see the module's doc). */
export const exponentsOf = (system: ExponentSystem): Exponents => {
	const unique = new Map<string, number>()
	for (const [i, b] of system.bounds.entries()) {
		unique.set(boundKey(b), unique.get(boundKey(b)) ?? i)
	}
	const placed: ReadonlyArray<Placed> = [...unique.values()]
		.toSorted((x, y) => x - y)
		.map((at) => {
			const bound = defined(system.bounds[at], "a bound")
			return { at, bound, columns: new Set(bound.columns) }
		})
	const overAnchor = (kind: Bound["kind"]): ReadonlyArray<ReadonlyArray<Placed>> =>
		Array.from({ length: system.anchors }, (_, a) =>
			placed.filter((p) => p.bound.kind === kind && p.bound.anchor === a)
		)
	const keys = overAnchor("key")
	const aparts = overAnchor("apart")
	const crossing = staticCrossing(keys, aparts)
	if (crossing !== undefined) {
		return { kind: "crossing", bounds: crossing, raises: 0 }
	}
	const x = Array.from({ length: system.columns }, () => 1)
	const rounds = keys.reduce((n, overA) => n + overA.length, 0) + 1
	let raised: Array<readonly [Placed, Placed]> = []
	let raises = 0
	for (let round = 0; round < rounds; round++) {
		raised = []
		for (const [a, overA] of keys.entries()) {
			const apartsOfA = defined(aparts[a], "an anchor's sets apart")
			for (const k of overA) {
				for (;;) {
					const top = largest(apartsOfA, x)
					const shortfall = top === undefined ? 0 : 1 + sumOf(top.columns, x) - sumOf(k.columns, x)
					if (top === undefined || shortfall <= 0) {
						break
					}
					const r = raiser(keys, aparts, x, k, top, shortfall)
					x[r] = defined(x[r], "a column's exponent") + shortfall
					raised.push([k, top])
					raises++
				}
			}
		}
		if (raised.length === 0) {
			return { kind: "exponents", anchors: floors(aparts, x), columns: x, raises }
		}
	}
	const named = positions(raised.flat())
	return certified(raised, system.columns)
		? { kind: "crossing", bounds: named, raises }
		: { kind: "unsettled", bounds: named, raises }
}

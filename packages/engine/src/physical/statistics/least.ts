import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"

/**
 * The least exponents of a relation's declared statistics (physical/statistics/declared.ts), found exactly.
 *
 * Each anchor `a` of a relation, a column whose values PostgreSQL is told are a fixed number of rows each at any size of
 * the table, holds 2^y_a rows a value; each other column `c` the planner multiplies by halves a bound set's rows
 * 2^x_c times. A bound is one column set over one anchor, the anchor among its columns and no other, its other
 * columns `columns`:
 * - a key binds at most one row: Σ x_c ≥ y_a;
 * - a set apart, which holds no key, binds two rows or more: Σ x_c ≤ y_a − 1 (an anchor that is no key alone is a set
 *   apart with no other column, y_a ≥ 1; one that is a key alone a key with none, y_a = 0).
 * The unknowns are integers, y_a ≥ 0 and x_c ≥ 1: PostgreSQL rounds a declared absolute number of distinct values to an
 * integer (selfuncs.c get_variable_numdistinct, clamp_row_est), and every column at least halves the rows it binds.
 *
 * The least solution is canonical: the least largest anchor exponent Y, then the columns' exponents least in column
 * order (lexicographically), then each anchor's least exponent under them, 1 more than its largest set apart's sum, or
 * 0. Exactly:
 * - the system holds integer solutions iff it holds rational ones: a rational solution (x, y) scaled by any t ≥ 1 stays
 *   one (t·Σx ≥ t·y; t·Σx ≤ t·y − t ≤ t·y − 1; t·x ≥ 1), and scaled by its denominators' least common multiple it is
 *   an integer one. So an exact rational simplex decides it (`feasible`, Bland's rule over exact fractions, which
 *   terminates), and a system with none is refused with a least set of bounds that holds none (`crossing`, the
 *   deletion filter: each bound in order dropped where the rest still holds no solution);
 * - with Y fixed, every column's exponent is at most the greater of Y and 1 in some least solution: one in a set apart
 *   is below its anchor's exponent, one in keys alone serves them at that, one in no bound is 1. So the solutions at Y lie in a finite box, which
 *   a depth-first search walks in lexicographic order, pruning each partial assignment no completion meets (`atMost`);
 *   its first leaf is the least. Y runs up from its least possible value and stops by the scaled rational solution's
 *   largest anchor exponent (`ceiling`), where the system holds an integer solution: the search is bounded by that
 *   box.
 */

/** One bound of a system, over an anchor by its position and other columns by theirs (see the module's doc). */
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
 * The least solution of a system, each anchor's and each column's exponent by position; or a crossing: the system holds
 * none, and `bounds`, by their positions in the system, is a least set of its bounds that holds none.
 */
export type Least =
	| {
			readonly kind: "least"
			readonly anchors: ReadonlyArray<number>
			readonly columns: ReadonlyArray<number>
	  }
	| { readonly kind: "crossing"; readonly bounds: NonEmptyReadonlyArray<number> }

/** An exact rational, its denominator positive and coprime to its numerator. */
interface Fraction {
	readonly n: bigint
	readonly d: bigint
}

const gcd = (a: bigint, b: bigint): bigint => {
	let x = a < 0n ? -a : a
	let y = b < 0n ? -b : b
	while (y !== 0n) {
		const r = x % y
		x = y
		y = r
	}
	return x
}

const fraction = (n: bigint, d: bigint): Fraction => {
	const sign = d < 0n ? -1n : 1n
	const g = gcd(n, d)
	return { n: (sign * n) / g, d: (sign * d) / g }
}

const zero: Fraction = { n: 0n, d: 1n }
const whole = (n: bigint): Fraction => ({ n, d: 1n })
const add = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d + b.n * a.d, a.d * b.d)
const sub = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d - b.n * a.d, a.d * b.d)
const mul = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.n, a.d * b.d)
const div = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d, a.d * b.n)
const sign = (a: Fraction): number => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0)
const less = (a: Fraction, b: Fraction): boolean => a.n * b.d < b.n * a.d

/**
 * The bounds as rows over the rational unknowns z ≥ 0, each `Σ coefficients·z ≤ limit`: z holds each anchor's exponent
 * first, then each column's exponent less 1, so z ≥ 0 states x ≥ 1. A key's row is y_a − Σ (x_c − 1) ≤ |columns|, a set
 * apart's Σ (x_c − 1) − y_a ≤ −1 − |columns|.
 */
const rowsOf = (
	system: ExponentSystem,
	bounds: ReadonlyArray<Bound>
): ReadonlyArray<{ readonly coefficients: ReadonlyArray<bigint>; readonly limit: bigint }> =>
	bounds.map((b) => {
		const coefficients = Array.from({ length: system.anchors + system.columns }, () => 0n)
		const sense = b.kind === "key" ? -1n : 1n
		coefficients[b.anchor] = -sense
		for (const c of b.columns) {
			coefficients[system.anchors + c] =
				defined(coefficients[system.anchors + c], "a column") + sense
		}
		const width = BigInt(b.columns.length)
		return { coefficients, limit: b.kind === "key" ? width : -1n - width }
	})

/**
 * A rational point of the bounds, z ≥ 0 as `rowsOf` states them, or none: phase 1 of the simplex over exact fractions,
 * Bland's rule choosing the entering and the leaving column, so it terminates. A row of negative limit is negated and
 * given a surplus and an artificial column, the artificial basic; any other a slack, basic. The point is feasible iff
 * the artificial columns' least sum is 0.
 */
const feasible = (
	system: ExponentSystem,
	bounds: ReadonlyArray<Bound>
): ReadonlyArray<Fraction> | undefined => {
	const rows = rowsOf(system, bounds)
	const unknowns = system.anchors + system.columns
	const negative = rows.flatMap((r, i) => (r.limit < 0n ? [i] : []))
	const width = unknowns + rows.length + negative.length
	const tableau: Array<Array<Fraction>> = rows.map((r, i) => {
		const negated = r.limit < 0n
		const s = negated ? -1n : 1n
		const line = Array.from({ length: width + 1 }, () => zero)
		for (const [j, a] of r.coefficients.entries()) {
			line[j] = whole(s * a)
		}
		line[unknowns + i] = whole(s)
		const artificial = negative.indexOf(i)
		if (artificial >= 0) {
			line[unknowns + rows.length + artificial] = whole(1n)
		}
		line[width] = whole(s * r.limit)
		return line
	})
	const basis = rows.map((r, i) =>
		r.limit < 0n ? unknowns + rows.length + negative.indexOf(i) : unknowns + i
	)
	const cost = (j: number): Fraction => (j >= unknowns + rows.length ? whole(1n) : zero)
	const at = (i: number, j: number): Fraction =>
		defined(defined(tableau[i], "a tableau row")[j], "a tableau cell")
	for (;;) {
		const reduced = (j: number): Fraction =>
			basis.reduce((r, column, i) => sub(r, mul(cost(column), at(i, j))), cost(j))
		const entering = Array.from({ length: width }, (_, j) => j).find(
			(j) => !basis.includes(j) && sign(reduced(j)) < 0
		)
		if (entering === undefined) {
			break
		}
		let leaving: number | undefined
		let ratio: Fraction | undefined
		for (const [i, column] of basis.entries()) {
			const a = at(i, entering)
			if (sign(a) <= 0) {
				continue
			}
			const r = div(at(i, width), a)
			const leavingColumn = leaving === undefined ? undefined : basis[leaving]
			if (
				ratio === undefined ||
				less(r, ratio) ||
				(!less(ratio, r) && leavingColumn !== undefined && column < leavingColumn)
			) {
				leaving = i
				ratio = r
			}
		}
		if (leaving === undefined) {
			throw defect("phase 1 of the simplex is bounded below by 0, so no column enters unboundedly")
		}
		const pivotRow = defined(tableau[leaving], "the leaving row")
		const pivot = defined(pivotRow[entering], "the pivot")
		const normalized = pivotRow.map((v) => div(v, pivot))
		tableau[leaving] = normalized
		for (const [i, line] of tableau.entries()) {
			if (i === leaving) {
				continue
			}
			const factor = defined(line[entering], "a cell of the entering column")
			if (sign(factor) !== 0) {
				tableau[i] = line.map((v, j) => sub(v, mul(factor, defined(normalized[j], "a cell"))))
			}
		}
		basis[leaving] = entering
	}
	const artificials = basis.reduce(
		(s, column, i) => (column >= unknowns + rows.length ? add(s, at(i, width)) : s),
		zero
	)
	if (sign(artificials) !== 0) {
		return undefined
	}
	return Array.from({ length: unknowns }, (_, j) => {
		const row = basis.indexOf(j)
		return row >= 0 ? at(row, width) : zero
	})
}

/** Two bounds are one where they hold one kind, one anchor and one set of columns. */
const boundKey = (b: Bound): string =>
	`${b.kind}\u0000${b.anchor}\u0000${[...new Set(b.columns)].toSorted((x, y) => x - y).join(",")}`

/**
 * The largest anchor exponent of an integer solution: the rational point (x, y) scaled by its denominators' least common
 * multiple, which is one (see the module's doc).
 */
const ceiling = (system: ExponentSystem, point: ReadonlyArray<Fraction>): number => {
	const lcm = point.reduce((m, v) => (m * v.d) / gcd(m, v.d), 1n)
	const exponents = point.slice(0, system.anchors).map((v) => (v.n * lcm) / v.d)
	return Number(exponents.reduce((m, v) => (v > m ? v : m), 0n))
}

/**
 * The bounds of each anchor, `apart` and `key`, by anchor position, and of each column, by column position, the sets
 * apart it is in, which bound its exponent below its anchor's.
 */
interface Indexed {
	readonly apart: ReadonlyArray<ReadonlyArray<Bound>>
	readonly key: ReadonlyArray<ReadonlyArray<Bound>>
}

const indexed = (system: ExponentSystem, bounds: ReadonlyArray<Bound>): Indexed => ({
	apart: Array.from({ length: system.anchors }, (_, a) =>
		bounds.filter((b) => b.kind === "apart" && b.anchor === a)
	),
	key: Array.from({ length: system.anchors }, (_, a) =>
		bounds.filter((b) => b.kind === "key" && b.anchor === a)
	)
})

/**
 * Each anchor's least exponent under the columns' exponents `x` (the lowest a partial assignment's completion can take
 * where `low` gives each column's least): 1 more than the largest sum of its sets apart, or 0.
 */
const anchorFloor = (ix: Indexed, anchor: number, low: (c: number) => number): number =>
	defined(ix.apart[anchor], "an anchor's sets apart").reduce(
		(m, b) => Math.max(m, 1 + b.columns.reduce((s, c) => s + low(c), 0)),
		0
	)

/**
 * Whether a partial assignment of the columns' exponents may complete under the largest anchor exponent `Y`: each
 * anchor's least exponent, every unassigned column at 1, at most the least of `Y` and each of its keys' sums, every
 * unassigned column at the most a set apart it is in leaves it (`Y` − 1 less the rest of the set at their least) or
 * the greater of `Y` and 1. At a full assignment it is exact.
 */
const atMost = (
	ix: Indexed,
	anchors: number,
	Y: number,
	assigned: ReadonlyArray<number | undefined>
): boolean => {
	const low = (c: number): number => assigned[c] ?? 1
	const high = (c: number): number => {
		const v = assigned[c]
		if (v !== undefined) {
			return v
		}
		let most = Math.max(1, Y)
		for (const sets of ix.apart) {
			for (const b of sets) {
				if (b.columns.includes(c)) {
					const rest = b.columns.reduce((s, other) => (other === c ? s : s + low(other)), 0)
					most = Math.min(most, Y - 1 - rest)
				}
			}
		}
		return most
	}
	for (let a = 0; a < anchors; a++) {
		const floor = anchorFloor(ix, a, low)
		const keys = defined(ix.key[a], "an anchor's keys")
		const top = keys.reduce(
			(m, b) =>
				Math.min(
					m,
					b.columns.reduce((s, c) => s + high(c), 0)
				),
			Y
		)
		if (floor > top) {
			return false
		}
	}
	return true
}

/**
 * The least columns' exponents under the largest anchor exponent `Y`, lexicographically, or none: a depth-first walk of
 * the box, each column from 1 up to the greater of `Y` and 1 in column order, the columns in no bound held at 1.
 */
const leastAt = (
	system: ExponentSystem,
	ix: Indexed,
	bounded: ReadonlyArray<number>,
	Y: number
): ReadonlyArray<number> | undefined => {
	const assigned: Array<number | undefined> = Array.from({ length: system.columns }, (_, c) =>
		bounded.includes(c) ? undefined : 1
	)
	const walk = (depth: number): boolean => {
		const c = bounded[depth]
		if (c === undefined) {
			return atMost(ix, system.anchors, Y, assigned)
		}
		for (let v = 1; v <= Math.max(1, Y); v++) {
			assigned[c] = v
			if (atMost(ix, system.anchors, Y, assigned) && walk(depth + 1)) {
				return true
			}
		}
		assigned[c] = undefined
		return false
	}
	return walk(0) ? assigned.map((v) => defined(v, "an assigned exponent")) : undefined
}

/** The least solution of a system, or a least set of its bounds that holds none (see the module's doc). */
export const leastExponents = (system: ExponentSystem): Least => {
	const unique = new Map<string, number>()
	for (const [i, b] of system.bounds.entries()) {
		unique.set(boundKey(b), unique.get(boundKey(b)) ?? i)
	}
	const positions = [...unique.values()].toSorted((x, y) => x - y)
	const bounds = positions.map((i) => defined(system.bounds[i], "a bound"))
	const point = feasible(system, bounds)
	if (point === undefined) {
		let kept = positions
		for (const i of positions) {
			const without = kept.filter((k) => k !== i)
			if (
				feasible(
					system,
					without.map((k) => defined(system.bounds[k], "a bound"))
				) === undefined
			) {
				kept = without
			}
		}
		const [first, ...rest] = kept
		if (first === undefined) {
			throw defect("a system holding no solution holds a bound")
		}
		return { kind: "crossing", bounds: [first, ...rest] }
	}
	const ix = indexed(system, bounds)
	const bounded = Array.from({ length: system.columns }, (_, c) => c).filter((c) =>
		bounds.some((b) => b.columns.includes(c))
	)
	const most = ceiling(system, point)
	const lowest = Array.from({ length: system.anchors }, (_, a) =>
		anchorFloor(ix, a, () => 1)
	).reduce((m, v) => Math.max(m, v), 0)
	for (let Y = lowest; Y <= Math.max(lowest, most); Y++) {
		const columns = leastAt(system, ix, bounded, Y)
		if (columns !== undefined) {
			const low = (c: number): number => defined(columns[c], "a column's exponent")
			return {
				kind: "least",
				anchors: Array.from({ length: system.anchors }, (_, a) => anchorFloor(ix, a, low)),
				columns
			}
		}
	}
	throw defect("a system holding a rational solution holds an integer one by its scaled ceiling")
}

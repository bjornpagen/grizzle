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
 * - a set apart, which holds no key, binds 2^l rows or more, l ≥ 1 its `least`: Σ x_c ≤ y_a − l (an anchor that is no
 *   key alone is a set apart with no other column, y_a ≥ 1; one that is a key alone a key with none, y_a = 0). A set
 *   apart binds two rows or more, l = 1; and an anchor of a pair each of whose anchors binds more rows than the pair (a
 *   unit's anchor and a column a binding spanning its units leads an index with, declared.ts) binds four rows or more
 *   over the columns of each set apart over the pair, l = 2, twice that set's, so y_a ≥ y_pair + 1.
 * The unknowns are integers, y_a ≥ 0 and 1 ≤ x_c ≤ cap_c: PostgreSQL rounds a declared absolute number of distinct
 * values to an integer (selfuncs.c get_variable_numdistinct, clamp_row_est), every column at least halves the rows it
 * binds, and none is declared more values than its type holds, a column of few values' 2^cap_c at most its handles (a
 * boolean's 2), any other's cap none.
 *
 * A key's bound is the one its columns may fall short of: where every column of the key its anchor's largest set apart
 * lacks stands at its cap, no exponent its type allows lifts the key's sum, and the key is carried by its own index
 * (Exponents `carried`): PostgreSQL prices a unique index all of whose columns an equality binds at one tuple whatever
 * the statistics (selfuncs.c btcostestimate), below every index whose equalities stop at a set apart, which binds two
 * rows or more, so the key's index still ranks first for every binding holding the key, and only the key's estimate of
 * rows exceeds one. Rel0x0 keyed (Bool, field0), Bool a boolean, beside an equality lookup on (field0, field1, tick0)
 * that stops at (field0, tick0) on a join key's index: the set apart asks field0 for 4 rows a value, and Bool, which
 * holds 2, halves them once; e637d8a3d refused the relation, asking Bool for 4 values.
 *
 * The least such integers, the least largest anchor exponent first, are no search to make in polynomial work: the
 * system is an integer program over sums of columns, a threshold realization of bounded weights, and a search of its
 * box, each column from 1 to the largest exponent, is exponential in its columns, as e2abf18f2's was. So the exponents
 * are what a raise reaches, each step polynomial and the steps bounded:
 * - every column starts at 1, and each anchor's exponent is its largest set apart's sum and least, or 0;
 * - a key whose sum falls short of its anchor's exponent, against its largest set apart `S`, raises one of its columns
 *   `S` does not hold by the shortfall, of those whose caps leave room for it (`raiser`): the last whose raise leaves
 *   every other key meeting its anchor's exponent and the largest exponent where it stands, else the last that leaves
 *   every other key meeting it, else the last; where no cap leaves room for the whole shortfall, one with room is raised
 *   to its cap the same way, and where none has room the key is carried by its index. A raise of a key's column lowers
 *   no bound of that key, so each key meets all its anchor's sets apart after at most one raise for each, and one more
 *   for each of its columns a raise fills to its cap;
 * - the keys are raised in order, round after round, until a round raises none: a raise is felt only by the sets apart
 *   that hold its column, so a chain of raises, each felt by the next key, ends within as many rounds as the system has
 *   keys where it holds no cycle; past that many rounds and one more the raise is ended.
 * What the raise cannot meet is refused in one of two ways:
 * - a crossing, which holds no solution at all, by its proof: a key held whole by a set apart over its anchor
 *   (Σ_K x ≤ Σ_S x ≤ y − l < y ≤ Σ_K x); or the key and set apart pairs of the raise's last round, where their
 *   differences 1_K − 1_S sum to no positive column: then no x > 0 meets them all (Gordan's alternative, each pair
 *   asking (1_K − 1_S) · x ≥ l ≥ 1);
 * - otherwise an unsettled raise: grizzle's raise found no exponents within its rounds, which the system may hold all the
 *   same, so it is a limitation of grizzle's, refused as one.
 * The work is at most keys + 1 rounds, each raising every key at most once for each set apart over its anchor and once
 * for each of its columns, each raise weighing each of the key's columns against every bound: polynomial in the
 * system's bounds and columns. Over
 * metis's, edullm's and den's 621 tables the raise declares what e2abf18f2's exact search did, table for table.
 */

/** One bound of a system, over an anchor and other columns by their positions (see the module's doc): a key's, or a set
 * apart's, which binds 2^`least` rows or more. */
export type Bound =
	| { readonly kind: "key"; readonly anchor: number; readonly columns: ReadonlyArray<number> }
	| {
			readonly kind: "apart"
			readonly anchor: number
			readonly columns: ReadonlyArray<number>
			readonly least: number
	  }

/** A system of bounds over `anchors` anchors and `columns` other columns, each by its position, and each column's cap,
 * the largest exponent its type holds (Infinity for a column of many values). */
export interface ExponentSystem {
	readonly anchors: number
	readonly columns: number
	readonly caps: ReadonlyArray<number>
	readonly bounds: ReadonlyArray<Bound>
}

/**
 * The exponents the raise reaches, each anchor's and each column's by position, with the keys their own indexes carry
 * (see the module's doc), by their positions; a crossing: the system holds none, and `bounds`, by their positions in the
 * system, hold none together; or an unsettled raise: `bounds`, the keys and sets apart of the raise's last round, which
 * grizzle's raise did not meet within its rounds (see the module's doc). Each with the raises made, the work the
 * module's doc bounds.
 */
export type Exponents =
	| {
			readonly kind: "exponents"
			readonly anchors: ReadonlyArray<number>
			readonly columns: ReadonlyArray<number>
			readonly carried: ReadonlyArray<number>
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

/** Two bounds are one where they hold one kind, one anchor and one set of columns, and a set apart one least. */
const boundKey = (b: Bound): string =>
	`${b.kind === "key" ? "key" : `apart ${b.least}`}\u0000${b.anchor}\u0000${[...new Set(b.columns)].toSorted((x, y) => x - y).join(",")}`

/** A bound of the system, by its position, with its set of columns and the exponent of the fewest rows it binds: a set
 * apart's `least`, a key's 0. */
interface Placed {
	readonly at: number
	readonly bound: Bound
	readonly columns: ReadonlySet<number>
	readonly least: number
}

/** The positions of `placed`, ascending, as a refusal names them. */
const positions = (placed: ReadonlyArray<Placed>): NonEmptyReadonlyArray<number> => {
	const [first, ...rest] = [...new Set(placed.map((p) => p.at))].toSorted((x, y) => x - y)
	if (first === undefined) {
		defect("a refusal names a bound")
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

/** The set apart over an anchor of the largest sum and least under `x`, the first of them; none where the anchor holds
 * none. */
const largest = (aparts: ReadonlyArray<Placed>, x: ReadonlyArray<number>): Placed | undefined => {
	let top: Placed | undefined
	let most = -1
	for (const p of aparts) {
		const s = p.least + sumOf(p.columns, x)
		if (s > most) {
			top = p
			most = s
		}
	}
	return top
}

/** Each anchor's exponent under `x`: its largest set apart's sum and least, or 0. */
const floors = (
	aparts: ReadonlyArray<ReadonlyArray<Placed>>,
	x: ReadonlyArray<number>
): ReadonlyArray<number> =>
	aparts.map((overA) => {
		const top = largest(overA, x)
		return top === undefined ? 0 : top.least + sumOf(top.columns, x)
	})

/**
 * The raise of a short key `k` against its largest set apart `top`, a column and by how much: of its columns `top` does
 * not hold whose caps leave room for the whole `shortfall`, else of those with any room, raised to their caps, the last
 * whose raise leaves every key meeting its anchor's exponent and the largest exponent where it stands; else the last
 * whose raise leaves every key meeting its anchor's exponent; else the last. None where no such column has room: the
 * key is carried by its index (see the module's doc).
 */
const raiser = (
	keys: ReadonlyArray<ReadonlyArray<Placed>>,
	aparts: ReadonlyArray<ReadonlyArray<Placed>>,
	x: ReadonlyArray<number>,
	caps: ReadonlyArray<number>,
	k: Placed,
	top: Placed,
	shortfall: number
): { readonly column: number; readonly by: number } | undefined => {
	const room = (c: number): number =>
		defined(caps[c], "a column's cap") - defined(x[c], "a column's exponent")
	const open = [...k.columns].filter((c) => !top.columns.has(c)).toSorted((p, q) => p - q)
	const whole = open.filter((c) => room(c) >= shortfall)
	const candidates = whole.length > 0 ? whole : open.filter((c) => room(c) > 0)
	const by = (c: number): number => Math.min(shortfall, room(c))
	const before = floors(aparts, x)
	const most = before.reduce((m, y) => Math.max(m, y), 0)
	const effect = (c: number) => {
		const after = x.map((v, i) => (i === c ? v + by(c) : v))
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
	const effects = candidates.map((c) => ({ c, ...effect(c) }))
	const column =
		effects.findLast((e) => !e.short && !e.higher)?.c ??
		effects.findLast((e) => !e.short)?.c ??
		candidates.at(-1)
	return column === undefined ? undefined : { column, by: by(column) }
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
			return {
				at,
				bound,
				columns: new Set(bound.columns),
				least: bound.kind === "apart" ? bound.least : 0
			}
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
					const shortfall =
						top === undefined ? 0 : top.least + sumOf(top.columns, x) - sumOf(k.columns, x)
					if (top === undefined || shortfall <= 0) {
						break
					}
					const r = raiser(keys, aparts, x, system.caps, k, top, shortfall)
					if (r === undefined) {
						break
					}
					x[r.column] = defined(x[r.column], "a column's exponent") + r.by
					raised.push([k, top])
					raises++
				}
			}
		}
		if (raised.length === 0) {
			const anchors = floors(aparts, x)
			const carried = keys.flatMap((overA, a) =>
				overA.flatMap((k) => (sumOf(k.columns, x) < defined(anchors[a], "a floor") ? [k.at] : []))
			)
			return { kind: "exponents", anchors, columns: x, carried, raises }
		}
	}
	const named = positions(raised.flat())
	return certified(raised, system.columns)
		? { kind: "crossing", bounds: named, raises }
		: { kind: "unsettled", bounds: named, raises }
}

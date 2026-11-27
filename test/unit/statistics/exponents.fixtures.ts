/**
 * What the properties of exponents.test.ts read: their spaces of systems, whether exponents meet a system's bounds, and
 * e2abf18f2's exact search for the least exponents (`exactLeast`), the raise's oracle and nothing else's.
 */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, constant, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { Bound, ExponentSystem } from "#compiler/physical/statistics/exponents.ts"

export type ExponentsFeature =
	| "exponents"
	| "a crossing"
	| "a crossing the raise's last round proves"
	| "an unsettled raise"
	| "an anchor above 1"
	| "a column above 1"
	| "two anchors"
	| "a key carried by its index"
	| "a column at its cap"
	| "a set apart of four rows"
	| "edullm's Instance at a5f2531ed"
	| "edullm's Instance at 71bd2dfc5"

/** The exponent of the fewest rows a drawn set apart binds (Bound `least`): two rows three times in four, a set apart's;
 * else four, a spanning pair's anchor's over a set apart over the pair (declared.ts). */
const leastGen: Gen<number> = weighted([
	[3, constant(1)],
	[1, constant(2)]
])

/** A drawn bound: a key, or a set apart binding 2^`least` rows or more. */
const boundOf = (
	key: boolean,
	anchor: number,
	columns: ReadonlyArray<number>,
	least: number
): Bound => (key ? { kind: "key", anchor, columns } : { kind: "apart", anchor, columns, least })

/** The exponent of the fewest rows a bound binds: a set apart's `least`, a key's none. */
const leastOf = (b: Bound): number => (b.kind === "apart" ? b.least : 0)

/** A column's cap (ExponentSystem `caps`): none three times in four, a column of many values; else a column of few
 * values', 1 to 3, a boolean's or a roster's of up to 15 handles. */
const capGen: Gen<number> = weighted([
	[3, constant(Number.POSITIVE_INFINITY)],
	[1, int(1, 3)]
])

/**
 * A small system drawn free: one or two anchors, one to four columns, each with a drawn cap, one to six bounds over
 * them, each bound of its kind, its anchor and a subset of the columns, a set apart of its least (`leastGen`); most
 * cross.
 */
const freeSystemGen: Gen<ExponentSystem> = (source) => {
	const anchors = source.draw(int(1, 2))
	const columns = source.draw(int(1, 4))
	const caps = Array.from({ length: columns }, () => source.draw(capGen))
	const indexes = Array.from({ length: columns }, (_, c) => c)
	const bound: Gen<Bound> = (s) =>
		boundOf(
			s.draw(boolean),
			s.draw(int(0, anchors - 1)),
			s.draw(subset(indexes, { min: 0, max: columns })),
			s.draw(leastGen)
		)
	return { anchors, columns, caps, bounds: source.draw(array(bound, { min: 1, max: 6 })) }
}

/**
 * A system of exponents drawn first and bounds drawn after, each kept where the exponents meet it: one to `anchors`
 * anchors of exponents 0 to 11, one to `columns` columns, each with a drawn cap, of exponents 1 to the lesser of 5 and
 * its cap, up to `bounds` bounds, each a key or a set apart of its least (`leastGen`) over an anchor and a subset of at
 * most `width` columns.
 * Every such system holds a solution, the drawn one.
 */
const plantedSystemGen =
	(size: {
		readonly anchors: number
		readonly columns: number
		readonly bounds: number
		readonly width: number
	}): Gen<ExponentSystem> =>
	(source) => {
		const anchors = source.draw(int(1, size.anchors))
		const columns = source.draw(int(1, size.columns))
		const caps = Array.from({ length: columns }, () => source.draw(capGen))
		const x = Array.from({ length: columns }, (_, c) =>
			source.draw(int(1, Math.min(5, defined(caps[c], "a cap"))))
		)
		const y = Array.from({ length: anchors }, () => source.draw(int(0, 11)))
		const indexes = Array.from({ length: columns }, (_, c) => c)
		const drawn = source.draw(
			array<Bound>(
				(s) =>
					boundOf(
						s.draw(boolean),
						s.draw(int(0, anchors - 1)),
						s.draw(subset(indexes, { min: 0, max: Math.min(columns, size.width) })),
						s.draw(leastGen)
					),
				{ min: 1, max: size.bounds }
			)
		)
		const bounds = Arr.filter(drawn, (b) => meets({ anchors, columns, caps, bounds: [b] }, y, x))
		return {
			anchors,
			columns,
			caps,
			bounds: bounds.length > 0 ? bounds : [{ kind: "apart", anchor: 0, columns: [], least: 1 }]
		}
	}

/**
 * A planted system of up to four anchors, eight columns and twelve bounds with one key more over a boolean's column, its
 * cap 1, and the columns of one of its sets apart but the first: a key such as Rel0x0's (Bool, field0) beside the set
 * apart (field0, tick0), whose sum its boolean cannot lift above its set apart's, which its own index carries where no
 * raise of its other columns meets it.
 */
const carriedSystemGen: Gen<ExponentSystem> = (source) => {
	const planted = source.draw(plantedSystemGen({ anchors: 4, columns: 8, bounds: 12, width: 8 }))
	const aparts = Arr.filter(planted.bounds, (b) => b.kind === "apart")
	const apart = aparts[source.draw(int(0, aparts.length - 1))] ?? {
		kind: "apart",
		anchor: 0,
		columns: [],
		least: 1
	}
	const boolean = planted.columns
	return {
		anchors: planted.anchors,
		columns: planted.columns + 1,
		caps: [...planted.caps, 1],
		bounds: [
			...planted.bounds,
			{ kind: "key", anchor: apart.anchor, columns: [...apart.columns.slice(1), boolean] }
		]
	}
}

/**
 * The comparison's space: a free system one time in five, most of them crossing; a planted one of up to four anchors,
 * ten columns and eighteen bounds, which holds a solution, three times in five; and one time in five a planted one with
 * a key over a boolean beside a set apart (`carriedSystemGen`).
 */
export const systemGen: Gen<ExponentSystem> = weighted([
	[1, freeSystemGen],
	[3, plantedSystemGen({ anchors: 4, columns: 10, bounds: 18, width: 10 })],
	[1, carriedSystemGen]
])

/**
 * The work property's space, a wide schema's: a planted system of up to eight anchors, sixty-four columns and four
 * hundred bounds, each over at most eight columns.
 */
export const wideSystemGen: Gen<ExponentSystem> = plantedSystemGen({
	anchors: 8,
	columns: 64,
	bounds: 400,
	width: 8
})

/**
 * edullm's Instance relation as its app installation's declared statistics bound it, at a5f2531ed and at 71bd2dfc5
 * (edullm out/grading-sql/j1/cpuprof culprit-a5f2531ed.json, culprit-71bd2dfc5.json, each bound once): its anchors
 * package, __package_capwbknxpj and __package_y55am5j6k6 and 28 free columns, 41 and 46 bounds, the second adding the
 * sets apart over package (site), (site, siteDocument), (site, siteDocument, document), (document, assemblyKind) and
 * (start, document), on which e2abf18f2's exact search exhausted every solution at a largest exponent of 7 and spun at 8.
 * Each with the least largest anchor exponent: 7, which that search found for the first, and 8 for the second.
 */
export const instanceSystems: Arr.NonEmptyReadonlyArray<{
	readonly at: string
	readonly system: ExponentSystem
	readonly least: number
}> = [
	{
		at: "a5f2531ed",
		least: 7,
		system: {
			anchors: 3,
			columns: 28,
			caps: Array.from({ length: 28 }, () => Number.POSITIVE_INFINITY),
			bounds: [
				{ kind: "apart", anchor: 0, columns: [], least: 1 },
				{ kind: "apart", anchor: 1, columns: [], least: 1 },
				{ kind: "apart", anchor: 2, columns: [], least: 1 },
				{ kind: "key", anchor: 0, columns: [12, 27] },
				{ kind: "key", anchor: 1, columns: [18] },
				{ kind: "key", anchor: 2, columns: [12, 23, 25] },
				{ kind: "key", anchor: 0, columns: [12, 27, 22, 13, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 18, 13] },
				{ kind: "key", anchor: 0, columns: [12, 27, 20, 18] },
				{ kind: "key", anchor: 0, columns: [12, 3, 14] },
				{ kind: "key", anchor: 0, columns: [12, 3, 4] },
				{ kind: "key", anchor: 0, columns: [12, 27, 16, 13, 18] },
				{ kind: "key", anchor: 0, columns: [12, 3, 14, 19] },
				{ kind: "key", anchor: 0, columns: [12, 27, 21, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 17, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 15] },
				{ kind: "key", anchor: 0, columns: [18, 2] },
				{ kind: "key", anchor: 0, columns: [18, 11] },
				{ kind: "apart", anchor: 0, columns: [12], least: 1 },
				{ kind: "apart", anchor: 0, columns: [27], least: 1 },
				{ kind: "apart", anchor: 0, columns: [18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13], least: 1 },
				{ kind: "apart", anchor: 0, columns: [18, 22], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 3], least: 1 },
				{ kind: "apart", anchor: 0, columns: [26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23, 26, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26, 18, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23, 25, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 25, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [26, 25, 13], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13], least: 1 }
			]
		}
	},
	{
		at: "71bd2dfc5",
		least: 8,
		system: {
			anchors: 3,
			columns: 28,
			caps: Array.from({ length: 28 }, () => Number.POSITIVE_INFINITY),
			bounds: [
				{ kind: "apart", anchor: 0, columns: [], least: 1 },
				{ kind: "apart", anchor: 1, columns: [], least: 1 },
				{ kind: "apart", anchor: 2, columns: [], least: 1 },
				{ kind: "key", anchor: 0, columns: [12, 27] },
				{ kind: "key", anchor: 1, columns: [18] },
				{ kind: "key", anchor: 2, columns: [12, 23, 25] },
				{ kind: "key", anchor: 0, columns: [12, 27, 22, 13, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 18, 13] },
				{ kind: "key", anchor: 0, columns: [12, 27, 20, 18] },
				{ kind: "key", anchor: 0, columns: [12, 3, 14] },
				{ kind: "key", anchor: 0, columns: [12, 3, 4] },
				{ kind: "key", anchor: 0, columns: [12, 27, 16, 13, 18] },
				{ kind: "key", anchor: 0, columns: [12, 3, 14, 19] },
				{ kind: "key", anchor: 0, columns: [12, 27, 21, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 17, 18] },
				{ kind: "key", anchor: 0, columns: [12, 27, 15] },
				{ kind: "key", anchor: 0, columns: [18, 2] },
				{ kind: "key", anchor: 0, columns: [18, 11] },
				{ kind: "apart", anchor: 0, columns: [12], least: 1 },
				{ kind: "apart", anchor: 0, columns: [27], least: 1 },
				{ kind: "apart", anchor: 0, columns: [18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13], least: 1 },
				{ kind: "apart", anchor: 0, columns: [18, 22], least: 1 },
				{ kind: "apart", anchor: 0, columns: [18, 13], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [27, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 3], least: 1 },
				{ kind: "apart", anchor: 0, columns: [26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13, 12, 18, 23, 26, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26, 18, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 23, 25, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 25, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [25, 26, 18], least: 1 },
				{ kind: "apart", anchor: 0, columns: [26, 25, 13], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [25, 26], least: 1 },
				{ kind: "apart", anchor: 0, columns: [12, 13, 25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [25], least: 1 },
				{ kind: "apart", anchor: 0, columns: [13], least: 1 }
			]
		}
	}
]

/** Whether exponents meet every bound of `system`, each column within its cap. */
export const meets = (
	system: ExponentSystem,
	anchors: ReadonlyArray<number>,
	columns: ReadonlyArray<number>
): boolean =>
	Arr.every(anchors, (y) => y >= 0) &&
	Arr.every(columns, (x, c) => x >= 1 && x <= defined(system.caps[c], "a cap")) &&
	Arr.every(system.bounds, (b) => {
		const sum = Arr.reduce(b.columns, 0, (s, c) => s + (columns[c] ?? 0))
		const y = anchors[b.anchor] ?? 0
		return b.kind === "key" ? sum >= y : sum <= y - b.least
	})

/**
 * Whether exponents meet `system` but for the keys `carried`, each of which its own index carries (exponents.ts): it is
 * a key whose sum falls short of its anchor's exponent, and each of its columns below its cap lies in a set apart over
 * its anchor whose sum and least are the anchor's exponent, a largest, so no exponent its type allows lifts the key's sum
 * above every largest set apart's; and every other key and every set apart is met, each column within its cap.
 */
export const admits = (
	system: ExponentSystem,
	anchors: ReadonlyArray<number>,
	columns: ReadonlyArray<number>,
	carried: ReadonlyArray<number>
): boolean => {
	const sum = (b: Bound): number => Arr.reduce(b.columns, 0, (s, c) => s + (columns[c] ?? 0))
	const y = (b: Bound): number => anchors[b.anchor] ?? 0
	return (
		meets(
			{ ...system, bounds: Arr.filter(system.bounds, (_, i) => !carried.includes(i)) },
			anchors,
			columns
		) &&
		Arr.every(carried, (i) => {
			const k = defined(system.bounds[i], "a carried bound")
			const tops = Arr.filter(
				system.bounds,
				(b) => b.kind === "apart" && b.anchor === k.anchor && sum(b) + b.least === y(k)
			)
			return (
				k.kind === "key" &&
				sum(k) < y(k) &&
				Arr.every(
					k.columns,
					(c) =>
						(columns[c] ?? 0) >= defined(system.caps[c], "a cap") ||
						Arr.some(tops, (t) => t.columns.includes(c))
				)
			)
		})
	)
}

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
 * apart's Σ (x_c − 1) − y_a ≤ −least − |columns|, and each column of a finite cap's x_c − 1 ≤ cap_c − 1.
 */
const rowsOf = (
	system: ExponentSystem,
	bounds: ReadonlyArray<Bound>
): ReadonlyArray<{ readonly coefficients: ReadonlyArray<bigint>; readonly limit: bigint }> => [
	...Arr.flatMap(system.caps, (cap, c) => {
		if (!Number.isFinite(cap)) {
			return []
		}
		const coefficients = Array.from({ length: system.anchors + system.columns }, () => 0n)
		coefficients[system.anchors + c] = 1n
		return [{ coefficients, limit: BigInt(cap - 1) }]
	}),
	...Arr.map(bounds, (b) => {
		const coefficients = Array.from({ length: system.anchors + system.columns }, () => 0n)
		const sense = b.kind === "key" ? -1n : 1n
		coefficients[b.anchor] = -sense
		for (const c of b.columns) {
			coefficients[system.anchors + c] =
				defined(coefficients[system.anchors + c], "a column") + sense
		}
		const width = BigInt(b.columns.length)
		return { coefficients, limit: b.kind === "key" ? width : -BigInt(leastOf(b)) - width }
	})
]

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
	const negative = Arr.flatMap(rows, (r, i) => (r.limit < 0n ? [i] : []))
	const width = unknowns + rows.length + negative.length
	const tableau: Array<Array<Fraction>> = Arr.map(rows, (r, i) => {
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
	const basis = Arr.map(rows, (r, i) =>
		r.limit < 0n ? unknowns + rows.length + negative.indexOf(i) : unknowns + i
	)
	const cost = (j: number): Fraction => (j >= unknowns + rows.length ? whole(1n) : zero)
	const at = (i: number, j: number): Fraction =>
		defined(defined(tableau[i], "a tableau row")[j], "a tableau cell")
	for (;;) {
		const reduced = (j: number): Fraction =>
			Arr.reduce(basis, cost(j), (r, column, i) => sub(r, mul(cost(column), at(i, j))))
		const entering = Option.getOrUndefined(
			Arr.findFirst(
				Array.from({ length: width }, (_, j) => j),
				(j) => !basis.includes(j) && sign(reduced(j)) < 0
			)
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
			throw new Error(
				"phase 1 of the simplex is bounded below by 0, so no column enters unboundedly"
			)
		}
		const pivotRow = defined(tableau[leaving], "the leaving row")
		const pivot = defined(pivotRow[entering], "the pivot")
		const normalized = Arr.map(pivotRow, (v) => div(v, pivot))
		tableau[leaving] = normalized
		for (const [i, line] of tableau.entries()) {
			if (i === leaving) {
				continue
			}
			const factor = defined(line[entering], "a cell of the entering column")
			if (sign(factor) !== 0) {
				tableau[i] = Arr.map(line, (v, j) => sub(v, mul(factor, defined(normalized[j], "a cell"))))
			}
		}
		basis[leaving] = entering
	}
	const artificials = Arr.reduce(basis, zero, (s, column, i) =>
		column >= unknowns + rows.length ? add(s, at(i, width)) : s
	)
	if (sign(artificials) !== 0) {
		return undefined
	}
	return Array.from({ length: unknowns }, (_, j) => {
		const row = basis.indexOf(j)
		return row >= 0 ? at(row, width) : zero
	})
}

/**
 * The largest anchor exponent of an integer solution: the rational point (x, y) scaled by its denominators' least common
 * multiple, which is one (see the module's doc).
 */
const ceiling = (system: ExponentSystem, point: ReadonlyArray<Fraction>): number => {
	const lcm = Arr.reduce(point, 1n, (m, v) => (m * v.d) / gcd(m, v.d))
	const exponents = Arr.map(point.slice(0, system.anchors), (v) => (v.n * lcm) / v.d)
	return Number(Arr.reduce(exponents, 0n, (m, v) => (v > m ? v : m)))
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
		Arr.filter(bounds, (b) => b.kind === "apart" && b.anchor === a)
	),
	key: Array.from({ length: system.anchors }, (_, a) =>
		Arr.filter(bounds, (b) => b.kind === "key" && b.anchor === a)
	)
})

/**
 * Each anchor's least exponent under the columns' exponents `x` (the lowest a partial assignment's completion can take
 * where `low` gives each column's least): the largest sum and least of its sets apart, or 0.
 */
const anchorFloor = (ix: Indexed, anchor: number, low: (c: number) => number): number =>
	Arr.reduce(defined(ix.apart[anchor], "an anchor's sets apart"), 0, (m, b) =>
		Math.max(m, leastOf(b) + Arr.reduce(b.columns, 0, (s, c) => s + low(c)))
	)

/**
 * Whether a partial assignment of the columns' exponents may complete under the largest anchor exponent `Y`: each
 * anchor's least exponent, every unassigned column at 1, at most the least of `Y` and each of its keys' sums, every
 * unassigned column at the most a set apart it is in leaves it (`Y` less its least and the rest of the set at their least), or the
 * lesser of its cap and the greater of `Y` and 1. At a full assignment it is exact.
 */
const atMost = (
	ix: Indexed,
	anchors: number,
	caps: ReadonlyArray<number>,
	Y: number,
	assigned: ReadonlyArray<number | undefined>
): boolean => {
	const low = (c: number): number => assigned[c] ?? 1
	const high = (c: number): number => {
		const v = assigned[c]
		if (v !== undefined) {
			return v
		}
		let most = Math.min(Math.max(1, Y), defined(caps[c], "a cap"))
		for (const family of ix.apart) {
			for (const b of family) {
				if (b.columns.includes(c)) {
					const rest = Arr.reduce(b.columns, 0, (s, other) => (other === c ? s : s + low(other)))
					most = Math.min(most, Y - leastOf(b) - rest)
				}
			}
		}
		return most
	}
	for (let a = 0; a < anchors; a++) {
		const floor = anchorFloor(ix, a, low)
		const keys = defined(ix.key[a], "an anchor's keys")
		const top = Arr.reduce(keys, Y, (m, b) =>
			Math.min(
				m,
				Arr.reduce(b.columns, 0, (s, c) => s + high(c))
			)
		)
		if (floor > top) {
			return false
		}
	}
	return true
}

/**
 * The least columns' exponents under the largest anchor exponent `Y`, lexicographically, or none: a depth-first walk of
 * the box, each column from 1 up to the lesser of its cap and the greater of `Y` and 1 in column order, the columns in no
 * bound held at 1.
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
			return atMost(ix, system.anchors, system.caps, Y, assigned)
		}
		for (let v = 1; v <= Math.min(Math.max(1, Y), defined(system.caps[c], "a cap")); v++) {
			assigned[c] = v
			if (atMost(ix, system.anchors, system.caps, Y, assigned) && walk(depth + 1)) {
				return true
			}
		}
		assigned[c] = undefined
		return false
	}
	return walk(0) ? Arr.map(assigned, (v) => defined(v, "an assigned exponent")) : undefined
}

/**
 * The least exponents of a system, e2abf18f2's exact search (physical/statistics/least.ts there): the least largest
 * anchor exponent, then the columns' least in column order, then each anchor's least; none where the system holds no
 * solution, which an exact rational simplex decides (a rational solution scaled is an integer one). Exponential in the
 * columns at worst, so it serves small systems alone, as the raise's oracle.
 */
export const exactLeast = (
	system: ExponentSystem
):
	| {
			readonly kind: "least"
			readonly anchors: ReadonlyArray<number>
			readonly columns: ReadonlyArray<number>
	  }
	| { readonly kind: "none" } => {
	const point = feasible(system, system.bounds)
	if (point === undefined) {
		return { kind: "none" }
	}
	const ix = indexed(system, system.bounds)
	const bounded = Arr.filter(
		Array.from({ length: system.columns }, (_, c) => c),
		(c) => Arr.some(system.bounds, (b) => b.columns.includes(c))
	)
	const most = ceiling(system, point)
	const lowest = Arr.reduce(
		Array.from({ length: system.anchors }, (_, a) => anchorFloor(ix, a, () => 1)),
		0,
		(m, v) => Math.max(m, v)
	)
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
	throw new Error("a system holding a rational solution holds an integer one by its scaled ceiling")
}

import { Array as Arr, String as Str } from "effect"
import {
	type AllenFormula,
	allenAtomCount,
	allenAtoms,
	atomIndexable,
	atomOperands,
	conjunctionHolds,
	literalAtom,
	literalNegated
} from "#compiler/allen/atoms.ts"
import { AllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { type SpanCarrier, spanCarriers } from "#compiler/ir/scalar.ts"
import { elementAt } from "#test/support/oracle/pick.ts"

/** A stored span: the canonical half-open [lo, hi) with lo < hi. */
export interface HalfOpen {
	readonly lo: bigint
	readonly hi: bigint
}

export type RangeType = "int4range" | "int8range"

/** The range type of each span carrier. */
const rangeTypeOf: Readonly<Record<SpanCarrier, RangeType>> = {
	range4: "int4range",
	range8: "int8range"
}

/** The range type of every span carrier the engine declares, in its order. */
export const rangeTypes: Arr.NonEmptyReadonlyArray<RangeType> = Arr.map(
	spanCarriers,
	(carrier) => rangeTypeOf[carrier]
)

export const rangeLimits: Readonly<
	Record<RangeType, { readonly min: bigint; readonly max: bigint }>
> = {
	int4range: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
	int8range: { min: -(2n ** 63n), max: 2n ** 63n - 1n }
}

export const spanText = (span: HalfOpen): string => `[${span.lo},${span.hi})`

const converse = (f: (a: HalfOpen, b: HalfOpen) => boolean) => (a: HalfOpen, b: HalfOpen) => f(b, a)

const equals = (a: HalfOpen, b: HalfOpen) => a.lo === b.lo && a.hi === b.hi

const finishes = (a: HalfOpen, b: HalfOpen) => b.lo < a.lo && a.hi === b.hi

const during = (a: HalfOpen, b: HalfOpen) => b.lo < a.lo && a.hi < b.hi

const overlaps = (a: HalfOpen, b: HalfOpen) => a.lo < b.lo && b.lo < a.hi && a.hi < b.hi

const meets = (a: HalfOpen, b: HalfOpen) => a.hi === b.lo

const before = (a: HalfOpen, b: HalfOpen) => a.hi < b.lo

/**
 * The endpoint condition of each basic relation, A = [a0, a1) and B = [b0, b1). A converse swaps
 * the operands.
 */
const endpointConditions: ReadonlyArray<
	readonly [AllenRelation, (a: HalfOpen, b: HalfOpen) => boolean]
> = (() => {
	const starts = (a: HalfOpen, b: HalfOpen) => a.lo === b.lo && a.hi < b.hi
	return [
		["before", before],
		["meets", meets],
		["overlaps", overlaps],
		["starts", starts],
		["during", during],
		["finishes", finishes],
		["equals", equals],
		["after", converse(before)],
		["metBy", converse(meets)],
		["overlappedBy", converse(overlaps)],
		["startedBy", converse(starts)],
		["contains", converse(during)],
		["finishedBy", converse(finishes)]
	]
})()

/** Every relation whose endpoint condition holds for the pair. */
export const relationsHolding = (a: HalfOpen, b: HalfOpen): ReadonlyArray<AllenRelation> =>
	Arr.map(
		Arr.filter(endpointConditions, ([, holds]) => holds(a, b)),
		([relation]) => relation
	)

/**
 * The Allen oracle: a brute-force classifier, PostgreSQL's range operators evaluated from bounds, and the
 * verification universe that test/unit/allen and test/pg/allen check over.
 *
 * Three independent pieces, none of which reads the compiler's atom sets:
 *
 * - `classify` computes the basic relation of a pair from its endpoints, by the endpoint conditions that define them,
 *   and refuses a pair that satisfies no condition or more than one, so the thirteen relations are checked to be
 *   pairwise disjoint and exhaustive on every pair it sees.
 * - `atomTruth` evaluates the eleven atoms as PostgreSQL does: each operator is transcribed from rangetypes.c
 *   (range_eq, range_contains, range_before, range_overleft, range_overlaps, range_adjacent, ...) over range bounds
 *   compared with range_cmp_bounds, so the result follows PostgreSQL's definitions rather than an atom table.
 * - `canonicalize` reads a range literal the way range_in, range_serialize and int4range_canonical /
 *   int8range_canonical do, so a spelling such as '(a, b]' is checked on the value PostgreSQL stores.
 *
 * The universe: every span with endpoints in [-3, 8]; spans at the int4 and int8 limits, including a
 * start at the type's minimum and an exclusive end at its maximum; and every span supplied in the spellings [a, b],
 * (a, b] and (a, b) that normalize to it.
 *
 * The one basic relation of a valid pair. Throws when the conditions are not exactly one, which would mean the
 * relations are not disjoint and exhaustive or the pair is not two valid spans.
 */
export const classify = (a: HalfOpen, b: HalfOpen): AllenRelation => {
	if (!(a.lo < a.hi && b.lo < b.hi)) {
		throw new Error(`not a pair of spans: ${spanText(a)}, ${spanText(b)}`)
	}
	const holding = relationsHolding(a, b)
	if (holding.length !== 1) {
		throw new Error(
			`${spanText(a)} vs ${spanText(b)} satisfies ${holding.length} relations: ${Arr.join(holding, ", ")}`
		)
	}
	return elementAt(holding, 0, "the holding relations")
}

export const relationBit = (relation: AllenRelation): number => allenRelations.indexOf(relation)

/** A finite range bound (rangetypes.h RangeBound; spans have no infinite bounds). */
interface Bound {
	readonly val: bigint
	readonly inclusive: boolean
	readonly lower: boolean
}

/** range_cmp_bounds for finite bounds. */
const cmpBounds = (b1: Bound, b2: Bound): number => {
	if (b1.val !== b2.val) {
		return b1.val < b2.val ? -1 : 1
	}
	if (!b1.inclusive && !b2.inclusive) {
		if (b1.lower === b2.lower) {
			return 0
		}
		return b1.lower ? 1 : -1
	}
	if (!b1.inclusive) {
		return b1.lower ? 1 : -1
	}
	if (!b2.inclusive) {
		return b2.lower ? -1 : 1
	}
	return 0
}

interface Range {
	readonly lower: Bound
	readonly upper: Bound
}

/** A stored span as PostgreSQL deserializes it: a canonical discrete range, '[' lower and ')' upper. */
const toRange = (span: HalfOpen): Range => ({
	lower: { val: span.lo, inclusive: true, lower: true },
	upper: { val: span.hi, inclusive: false, lower: false }
})

/**
 * bounds_adjacent for a discrete type with a canonical function: adjacent when equal with different inclusivity, or
 * when nothing lies strictly between, which for canonical integer bounds is the empty range [upper, lower).
 */
const boundsAdjacent = (upperA: Bound, lowerB: Bound): boolean => {
	const cmp = upperA.val === lowerB.val ? 0 : upperA.val < lowerB.val ? -1 : 1
	if (cmp < 0) {
		/**
		 * make_range(lower = upperA with inclusivity flipped, upper = lowerB with inclusivity flipped), canonicalized.
		 */
		const lo = upperA.inclusive ? upperA.val + 1n : upperA.val
		const hi = lowerB.inclusive ? lowerB.val : lowerB.val + 1n
		return lo >= hi
	}
	if (cmp === 0) {
		return upperA.inclusive !== lowerB.inclusive
	}
	return false
}

/** The PostgreSQL function behind each operator, for two nonempty finite ranges (rangetypes.c). */
const pgOperator: Readonly<Record<string, (r1: Range, r2: Range) => boolean>> = {
	/** range_overlaps_internal */
	"&&": (r1, r2) =>
		(cmpBounds(r1.lower, r2.lower) >= 0 && cmpBounds(r1.lower, r2.upper) <= 0) ||
		(cmpBounds(r2.lower, r1.lower) >= 0 && cmpBounds(r2.lower, r1.upper) <= 0),
	/** range_contains_internal */
	"@>": (r1, r2) => cmpBounds(r1.lower, r2.lower) <= 0 && cmpBounds(r1.upper, r2.upper) >= 0,
	/** range_contained_by_internal */
	"<@": (r1, r2) => cmpBounds(r2.lower, r1.lower) <= 0 && cmpBounds(r2.upper, r1.upper) >= 0,
	/** range_before_internal */
	"<<": (r1, r2) => cmpBounds(r1.upper, r2.lower) < 0,
	/** range_after_internal */
	">>": (r1, r2) => cmpBounds(r1.lower, r2.upper) > 0,
	/** range_overleft_internal */
	"&<": (r1, r2) => cmpBounds(r1.upper, r2.upper) <= 0,
	/** range_overright_internal */
	"&>": (r1, r2) => cmpBounds(r1.lower, r2.lower) >= 0,
	/** range_adjacent_internal */
	"-|-": (r1, r2) => boundsAdjacent(r1.upper, r2.lower) || boundsAdjacent(r2.upper, r1.lower),
	/** range_eq_internal */
	"=": (r1, r2) => cmpBounds(r1.lower, r2.lower) === 0 && cmpBounds(r1.upper, r2.upper) === 0
}

/** The truth of each of the eleven atoms for (A, B), as bit `atom`, evaluated as PostgreSQL evaluates the operator. */
const atomTruth = (a: HalfOpen, b: HalfOpen): number => {
	const ra = toRange(a)
	const rb = toRange(b)
	let bits = 0
	for (let atom = 0; atom < allenAtomCount; atom++) {
		const info = elementAt(allenAtoms, atom, "the Allen atoms")
		const fn = pgOperator[info.op]
		if (fn === undefined) {
			throw new Error(`no PostgreSQL operator model for ${info.op}`)
		}
		if (fn(...atomOperands(info, ra, rb))) {
			bits |= 1 << atom
		}
	}
	return bits
}

/** A range literal with explicit bound forms, '[' or '(' then lower, upper, then ']' or ')'. */
export interface Spelling {
	readonly lowerInc: boolean
	readonly lo: bigint
	readonly hi: bigint
	readonly upperInc: boolean
}

export const spellingText = (s: Spelling): string =>
	`${s.lowerInc ? "[" : "("}${s.lo},${s.hi}${s.upperInc ? "]" : ")"}`

/** What PostgreSQL makes of a literal: the stored span, the empty range, or the SQLSTATE it raises. */
export type Canonical =
	| { readonly kind: "span"; readonly span: HalfOpen }
	| { readonly kind: "empty" }
	| { readonly kind: "error"; readonly sqlstate: "22000" | "22003" }

/**
 * range_in: range_serialize refuses lower > upper (22000) and makes equal bounds empty unless both are inclusive;
 * int4range_canonical / int8range_canonical then make the lower bound inclusive and the upper exclusive, raising
 * 22003 when the adjustment leaves the type, and serialize again, which can yield the empty range.
 */
export const canonicalize = (type: RangeType, s: Spelling): Canonical => {
	const { min, max } = rangeLimits[type]
	if (s.lo < min || s.lo > max || s.hi < min || s.hi > max) {
		return { kind: "error", sqlstate: "22003" }
	}
	if (s.lo > s.hi) {
		return { kind: "error", sqlstate: "22000" }
	}
	if (s.lo === s.hi && !(s.lowerInc && s.upperInc)) {
		return { kind: "empty" }
	}
	let lo = s.lo
	let hi = s.hi
	if (!s.lowerInc) {
		if (lo === max) {
			return { kind: "error", sqlstate: "22003" }
		}
		lo += 1n
	}
	if (s.upperInc) {
		if (hi === max) {
			return { kind: "error", sqlstate: "22003" }
		}
		hi += 1n
	}
	if (lo >= hi) {
		return { kind: "empty" }
	}
	return { kind: "span", span: { lo, hi } }
}

/**
 * The spellings of one span besides its canonical '[a,b)': '[a,b-1]', '(a-1,b-1]' and '(a-1,b)', each where it is a
 * valid literal of the type.
 */
const alternateSpellings = (type: RangeType, span: HalfOpen): ReadonlyArray<Spelling> => {
	const { min } = rangeLimits[type]
	const out: Array<Spelling> = [
		{ lowerInc: true, lo: span.lo, hi: span.hi, upperInc: false },
		{ lowerInc: true, lo: span.lo, hi: span.hi - 1n, upperInc: true }
	]
	if (span.lo > min) {
		out.push({ lowerInc: false, lo: span.lo - 1n, hi: span.hi - 1n, upperInc: true })
		out.push({ lowerInc: false, lo: span.lo - 1n, hi: span.hi, upperInc: false })
	}
	return out
}

const windowLow = -3n
const windowHigh = 8n

/** Every span [a, b) with -3 <= a < b <= 8. */
export const windowSpans = (): ReadonlyArray<HalfOpen> => {
	const out: Array<HalfOpen> = []
	for (let lo = windowLow; lo <= windowHigh; lo++) {
		for (let hi = lo + 1n; hi <= windowHigh; hi++) {
			out.push({ lo, hi })
		}
	}
	return out
}

/**
 * Spans at a type's limits: starting at the minimum, ending exclusively at the maximum, the whole type,
 * and the narrowest spans at each end, plus spans reaching from each limit into the window.
 */
export const limitSpans = (type: RangeType): ReadonlyArray<HalfOpen> => {
	const { min, max } = rangeLimits[type]
	const ends = [min + 1n, min + 2n, windowLow, 0n, windowHigh, max - 1n, max]
	const starts = [min, min + 1n, windowLow, 0n, windowHigh, max - 2n, max - 1n]
	const out: Array<HalfOpen> = []
	for (const hi of ends) {
		out.push({ lo: min, hi })
	}
	for (const lo of starts) {
		out.push({ lo, hi: max })
	}
	out.push(
		{ lo: min + 1n, hi: max - 1n },
		{ lo: max - 2n, hi: max - 1n },
		{ lo: min + 1n, hi: min + 2n }
	)
	return out
}

export const compareSpans = (a: HalfOpen, b: HalfOpen): -1 | 0 | 1 =>
	a.lo !== b.lo ? (a.lo < b.lo ? -1 : 1) : a.hi === b.hi ? 0 : a.hi < b.hi ? -1 : 1

/**
 * The spellings the universe is read from: every span of the window and the type's limits (and, for int8range, the
 * int4 limits too, which are ordinary int8 values) in each of its spellings.
 */
export const universeSpellings = (type: RangeType): ReadonlyArray<Spelling> => {
	const spans = [
		...windowSpans(),
		...limitSpans("int4range"),
		...(type === "int8range" ? limitSpans(type) : [])
	]
	return Arr.flatMap(spans, (span) => alternateSpellings(type, span))
}

/** The stored values of the universe's spellings, deduplicated in range order. Every spelling must store a span. */
export const universe = (type: RangeType): ReadonlyArray<HalfOpen> => {
	const byText = new Map<string, HalfOpen>()
	for (const spelling of universeSpellings(type)) {
		const stored = canonicalize(type, spelling)
		if (stored.kind !== "span") {
			throw new Error(`universe spelling ${spellingText(spelling)} stores no span`)
		}
		byText.set(spanText(stored.span), stored.span)
	}
	return Arr.sort(byText.values(), compareSpans)
}

/**
 * Literals around the window, valid or not, for checking the host's canonicalization against PostgreSQL's: every
 * bound form over a pair of endpoints in [-4, 9], and the limit spellings that overflow or empty.
 */
export const canonicalizationSurvey = (type: RangeType): ReadonlyArray<Spelling> => {
	const { min, max } = rangeLimits[type]
	const out: Array<Spelling> = []
	const forms = [
		[true, false],
		[true, true],
		[false, true],
		[false, false]
	] as const
	for (let lo = windowLow - 1n; lo <= windowHigh + 1n; lo++) {
		for (let hi = windowLow - 1n; hi <= windowHigh + 1n; hi++) {
			for (const [lowerInc, upperInc] of forms) {
				out.push({ lowerInc, lo, hi, upperInc })
			}
		}
	}
	for (const [lowerInc, upperInc] of forms) {
		out.push({ lowerInc, lo: min, hi: max, upperInc })
		out.push({ lowerInc, lo: max - 1n, hi: max, upperInc })
		out.push({ lowerInc, lo: max, hi: max, upperInc })
		out.push({ lowerInc, lo: min, hi: min, upperInc })
		out.push({ lowerInc, lo: min, hi: min + 1n, upperInc })
	}
	return out
}

export interface PairFacts {
	readonly a: HalfOpen
	readonly b: HalfOpen
	readonly relation: AllenRelation
	/** Bit `relation` of the thirteen-bit relation order. */
	readonly relationBit: number
	readonly atoms: number
}

/** Every ordered pair of the universe, classified and with its atom truths. */
export const universePairs = (spans: ReadonlyArray<HalfOpen>): ReadonlyArray<PairFacts> => {
	const out: Array<PairFacts> = []
	for (const a of spans) {
		for (const b of spans) {
			const relation = classify(a, b)
			out.push({ a, b, relation, relationBit: relationBit(relation), atoms: atomTruth(a, b) })
		}
	}
	return out
}

/** The relations a formula holds for, computed from the atoms' sets. The empty formula is false. */
export const formulaHolds = (formula: AllenFormula): AllenMask =>
	AllenMask(Arr.reduce(formula, 0, (mask, conjunction) => mask | conjunctionHolds(conjunction)))

/** A formula's truth for one pair, given the truth of each atom for that pair as bit `atom` of `atoms`. */
const evaluateFormula = (formula: AllenFormula, atoms: number): boolean =>
	Arr.some(formula, (conjunction) =>
		Arr.every(
			conjunction,
			(literal) => ((atoms & (1 << (literal >> 1))) !== 0) !== literalNegated(literal)
		)
	)

/** The number of atom occurrences in a formula: the generator's primary cost. */
export const formulaAtomCount = (formula: AllenFormula): number =>
	Arr.reduce(formula, 0, (count, conjunction) => count + conjunction.length)

/** Whether every disjunct carries an unnegated indexable atom. */
export const everyDisjunctIndexable = (formula: AllenFormula): boolean =>
	Arr.every(formula, (conjunction) =>
		Arr.some(
			conjunction,
			(literal) => !literalNegated(literal) && atomIndexable(literalAtom(literal))
		)
	)

/** The formula as text: `A && B AND NOT A @> B OR ...`. A negated equality is written `A <> B`. */
export const formulaText = (formula: AllenFormula): string =>
	Arr.join(
		Arr.map(formula, (conjunction) =>
			Arr.join(
				Arr.map(conjunction, (literal) => {
					const atom = literalAtom(literal)
					if (!literalNegated(literal)) {
						return atom.text
					}
					return atom.op === "=" ? Str.replace("=", "<>")(atom.text) : `NOT ${atom.text}`
				}),
				" AND "
			)
		),
		" OR "
	)

interface Mismatch {
	readonly mask: number
	readonly formula: string
	readonly a: string
	readonly b: string
	readonly relation: AllenRelation
	readonly formulaHolds: boolean
}

/** The most mismatches a verification returns beside their count. */
const mismatchLimit = 20

/**
 * For each mask in `masks` and each pair, whether the formula holds exactly when the pair's relation is in the mask.
 * Returns the number of checks and of mismatches, and the first mismatchLimit mismatches.
 */
export const verifyFormulas = (
	formulaOf: (mask: number) => AllenFormula,
	masks: Iterable<number>,
	pairs: ReadonlyArray<PairFacts>
): {
	readonly checks: number
	readonly mismatchCount: number
	readonly mismatches: ReadonlyArray<Mismatch>
} => {
	const mismatches: Array<Mismatch> = []
	let checks = 0
	let mismatchCount = 0
	for (const mask of masks) {
		const formula = formulaOf(mask)
		for (const pair of pairs) {
			checks += 1
			const holds = evaluateFormula(formula, pair.atoms)
			const expected = (mask & (1 << pair.relationBit)) !== 0
			if (holds === expected) {
				continue
			}
			mismatchCount += 1
			if (mismatches.length < mismatchLimit) {
				mismatches.push({
					mask,
					formula: formulaText(formula),
					a: spanText(pair.a),
					b: spanText(pair.b),
					relation: pair.relation,
					formulaHolds: holds
				})
			}
		}
	}
	return { checks, mismatchCount, mismatches }
}

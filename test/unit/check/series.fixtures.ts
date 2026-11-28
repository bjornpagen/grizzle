/** What the properties of series.test.ts read: their spaces, the queries they compile and the brute force they judge by. */

import { element, type FiniteSpace, finite, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Logic, Num, Time, Type } from "#compiler/public/compute.ts"
import { domain, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

/** A case: a series from lo within [a, b] to hi within [c, d], its element cast into a contract within [l, h]. */
export interface ElementCase {
	readonly a: number
	readonly b: number
	readonly c: number
	readonly d: number
	readonly l: number
	readonly h: number
}

/** The ends an interval is drawn from: -1, 0 and 1, an interval below, at or above any other. */
const end = int(-1, 1)

/**
 * Every series whose ends' intervals hold some element (a at most d), from lo within [a, b] to hi within [c, d], against
 * every target interval [l, h] of the ends.
 */
export const elementBox: FiniteSpace<ElementCase> = finite((source) => {
	const a = source.draw(end)
	const b = source.draw(int(a, 1))
	const c = source.draw(end)
	const d = source.draw(int(Math.max(a, c), 1))
	const l = source.draw(end)
	const h = source.draw(int(l, 1))
	return { a, b, c, d, l, h }
})

const hiKey = Symbol("Hi")
const loKey = Symbol("Lo")
const targetKey = Symbol("Target")
/**
 * Whether the engine compiles a rule over a row of lo within [a, b] and hi within [c, d] that matches the series from
 * lo to hi and delivers each element cast into the contract within [l, h], which the row's `target` installs: no guard,
 * so the cast stands only on the element's interval.
 */
export const compilesCast = (k: ElementCase): boolean => {
	const Lo = domain<typeof loKey>()("Lo", int8, (x) =>
		Logic.and([Logic.ge(x, BigInt(k.a)), Logic.le(x, BigInt(k.b))])
	)
	const Hi = domain<typeof hiKey>()("Hi", int8, (x) =>
		Logic.and([Logic.ge(x, BigInt(k.c)), Logic.le(x, BigInt(k.d))])
	)
	const Target = domain<typeof targetKey>()("Target", int8, (x) =>
		Logic.and([Logic.ge(x, BigInt(k.l)), Logic.le(x, BigInt(k.h))])
	)
	const Ends = relation("Ends", { id: int4, lo: Lo, hi: Hi, target: Target }, ["id"])
	const S = schema("Series", [Ends], [])
	const q = query(S).rule((r) => {
		const { id, lo, hi } = v(Ends, "ends")
		const elements = r.series(Type.base(lo), Type.base(hi))
		const { at } = v(elements, "element")
		return r
			.match(Ends, { id, lo, hi })
			.match(elements, { at })
			.find({ id, at: Type.cast(at, Target, targetKey) })
	})
	return compileTemplate(q, undefined, testCompile).ok
}

/**
 * Whether every element of every series from lo within [a, b] to hi within [c, d] lies within [l, h], by brute force:
 * each lo and hi, and each integer from lo to hi.
 */
export const everyElementWithin = (k: ElementCase): boolean => {
	const span = (low: number, high: number): ReadonlyArray<number> =>
		Array.from({ length: Math.max(high - low + 1, 0) }, (_, i) => low + i)
	return Arr.every(span(k.a, k.b), (lo) =>
		Arr.every(span(k.c, k.d), (hi) => Arr.every(span(lo, hi), (x) => x >= k.l && x <= k.h))
	)
}

/** The microseconds of one UTC day. */
const dayMicros = 86_400_000_000n

const momentKey = Symbol("Moment")
/** The ledger's clock: an instant before 10000-01-01, the instant after which no day a date holds begins. */
const Moment = domain<typeof momentKey>()("Moment", int8, (t) =>
	Num.within(t, 0n, 253_402_300_800_000_000n - 1n)
)

const stampKey = Symbol("Stamp")
/** An instant a candidate's application stamps, on a clock wider than the ledger's. */
const Stamp = domain<typeof stampKey>()("Stamp", int8, (t) => Num.within(t, 0n, 2n ** 62n))

/**
 * The ledger's piece of presence (qti-pie ledger delivery.ts presentPieces and PresentTime): a window's credit, from
 * its first beacon to its last, cut to a presentation's span, `from` the later of the window's start and the
 * presentation's instant, `to` the earlier of the window's end less 1 µs and the next moment.
 */
const Piece = relation("Piece", { id: int4, start: Moment, end: Moment, at: Stamp, next: Stamp }, [
	"id"
])

/** Which way the ledger's day split is written: as the series of its days, or with its days' ends unbounded. */
export const ledgerShapes = ["days of a piece", "days past the clock's top"] as const
export type LedgerShape = (typeof ledgerShapes)[number]

/** Every way the day split is written. */
export const ledgerBox: FiniteSpace<LedgerShape> = finite((source) =>
	source.draw(element(ledgerShapes))
)

/**
 * Whether the engine compiles the ledger's PresentTime over a piece: each UTC day the piece touches, the series from
 * the day of its first microsecond to the day of its last, as a date (Time.dateOfEpochDay) and the microseconds of it
 * the piece holds, with no guard; its days past the clock's top where the next moment's stamp, not the window's end,
 * bounds the last day.
 */
export const compilesLedger = (shape: LedgerShape): boolean => {
	const S = schema("Ledger", [Piece], [])
	const ofPiece = query(S).rule((r) => {
		const { id, start, end, at, next } = v(Piece, "piece")
		const from = Logic.greatest(Type.base(start), Type.base(at))
		const to = Logic.least(Type.cast(Num.sub(Type.base(end), 1n), int8), Type.base(next))
		const days = r.series(Num.div(from, dayMicros), Num.div(Num.sub(to, 1n), dayMicros))
		const { at: day } = v(days, "day")
		return r
			.match(Piece, { id, start, end, at, next })
			.match(days, { at: day })
			.find({
				id,
				day: Time.dateOfEpochDay(Type.cast(day, int8)),
				micros: Num.sub(
					Logic.least(Num.numeric(to), Num.numeric(Num.add(Num.mul(day, dayMicros), dayMicros))),
					Logic.greatest(Num.numeric(from), Num.numeric(Num.mul(day, dayMicros)))
				)
			})
	})
	const pastTop = query(S).rule((r) => {
		const { id, start, at, next } = v(Piece, "piece")
		const from = Logic.greatest(Type.base(start), Type.base(at))
		const to = Type.base(next)
		const days = r.series(Num.div(from, dayMicros), Num.div(Num.sub(to, 1n), dayMicros))
		const { at: day } = v(days, "day")
		return r
			.match(Piece, { id, start, at, next })
			.match(days, { at: day })
			.find({
				id,
				day: Time.dateOfEpochDay(Type.cast(day, int8)),
				micros: Num.sub(
					Logic.least(Num.numeric(to), Num.numeric(Num.add(Num.mul(day, dayMicros), dayMicros))),
					Logic.greatest(Num.numeric(from), Num.numeric(Num.mul(day, dayMicros)))
				)
			})
	})
	return compileTemplate(shape === "days of a piece" ? ofPiece : pastTop, undefined, testCompile).ok
}

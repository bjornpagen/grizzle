/** What the properties of mask.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ALLEN, AllenMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { query, v } from "#compiler/public/query.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { type HalfOpen, windowSpans } from "#test/support/oracle/allen.ts"
import { Booking, Schedule } from "#test/support/unit/query/fixtures.ts"

/** The relations a mask holds, in bit order: the relation of each set bit, by the declared order. */
export const relationsOf = (mask: number): ReadonlyArray<AllenRelation> =>
	Arr.filter(allenRelations, (r) => (mask & (1 << allenRelations.indexOf(r))) !== 0)

/** The named masks beyond the thirteen basic relations, and the complement of one. */
type Named = "intersects" | "covers" | "within" | "precedes" | "disjoint"

/**
 * What each named mask means of two half-open spans A = [a0, a1) and B = [b0, b1), stated over their points: A and B
 * share a point; every point of B is A's; every point of A is B's; every point of A is before every point of B; and no
 * point is both's, the complement of intersects.
 */
export const meanings: { readonly [N in Named]: (a: HalfOpen, b: HalfOpen) => boolean } = {
	intersects: (a, b) => a.lo < b.hi && b.lo < a.hi,
	covers: (a, b) => a.lo <= b.lo && b.hi <= a.hi,
	within: (a, b) => b.lo <= a.lo && a.hi <= b.hi,
	precedes: (a, b) => a.hi <= b.lo,
	disjoint: (a, b) => a.hi <= b.lo || b.hi <= a.lo
}

/** Each named mask: ALLEN's own, and the complement of intersects. */
export const named: { readonly [N in Named]: AllenMask } = {
	intersects: ALLEN.intersects,
	covers: ALLEN.covers,
	within: ALLEN.within,
	precedes: ALLEN.precedes,
	disjoint: ALLEN.complement(ALLEN.intersects)
}

export const namedMasks: Arr.NonEmptyReadonlyArray<Named> = [
	"intersects",
	"covers",
	"within",
	"precedes",
	"disjoint"
]

export type NamedFeature = `${Named} ${"held" | "failed"}`

/**
 * A value a mask entry point is given: any number a caller may write, or a value of another kind a JavaScript caller
 * may pass where the admission core takes anything.
 */
type Given =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "other"; readonly value: unknown }

/**
 * Every integer from one below the thirteen bits to one past them, every mask among them, and the numbers and values
 * that are no integer.
 */
export const given: Gen<Given> = oneOf([
	map(int(-1, fullAllenMask + 2), (value): Given => ({ kind: "number", value })),
	map(
		element([
			1.5,
			-0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			2 ** 40,
			-(2 ** 13)
		]),
		(value): Given => ({ kind: "number", value })
	),
	map(element<unknown>(["4", 4n, null, undefined, {}, [4]]), (value): Given => ({
		kind: "other",
		value
	}))
])

/** What the entry points' cases reach: each kind of mask, and each way a value is no mask. */
export type EntryFeature =
	| "a mask"
	| "the empty mask"
	| "the full mask"
	| "below the thirteen bits"
	| "past the thirteen bits"
	| "no integer"
	| "no number"

/** A mask by definition: an integer in [0, 8191], negative zero being zero. */
export const isMask = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= fullAllenMask

/** Whether `f` throws a MalformedDescription; anything but a CompileError thrown fails the test. */
export const refusedMalformed = (f: () => unknown): boolean => {
	const caught = catchCompileError(f)
	return !caught.ok && caught.error.reason._tag === "MalformedDescription"
}

/** r.allen between two spans of one booking's room, recorded by the builder. */
export const allenTerm = (mask: number) =>
	queryValueDesc(
		query(Schedule).rule((r) => {
			const a = v(Booking, "first")
			const b = v(Booking, "second")
			return r
				.match(Booking, { room: a.room, during: a.during })
				.match(Booking, { room: a.room, during: b.during })
				.where(r.allen(a.during, mask, b.during))
				.find({ room: a.room })
		})
	)

export const spans = nonEmpty(windowSpans(), "the window's spans")

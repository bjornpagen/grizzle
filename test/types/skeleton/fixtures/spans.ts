import type { AllenMask } from "#compiler/allen/mask.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { pg, span, type Uuid, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { ParamType, Term } from "#compiler/types/core/phantom.ts"
import type { Span } from "#compiler/types/fields/field.ts"
import type { HeadOf, ParamsOf } from "#compiler/types/query/query.ts"
import { query, v } from "#index.ts"
import { Cents } from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * Spans, Allen masks and the calendar utility over declare-only values. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * A booking schedule over integer ticks.
 */
export const RoomOpen = relation("RoomOpen", { room: uuid, during: span(pg.integer) }, [
	"room",
	"during"
])

export const Booking = relation("Booking", { room: uuid, during: span(pg.integer) }, [
	"room",
	"during"
])

export const Budgeted = relation(
	"Budgeted",
	{ id: uuid, range: span(Cents), raw: span(pg.bigint) },
	["id"]
)
export const Schedule = schema("Schedule", { RoomOpen, Booking, Budgeted }, [])

/** A window is a span parameter used with r.allen; it adopts the span type it meets. */
export const intersecting = query(Schedule).rule((r) => {
	const { room, during } = v(Booking, "booking")
	return r
		.match(Booking, { room, during })
		.where(r.allen(during, ALLEN.intersects, r.param("window", Booking.fields.during)))
		.find({ room, during })
})

export type IntersectingParams = Expect<
	Equals<ParamsOf<typeof intersecting>, { readonly window: ParamType<Span<number>, "range"> }>
>

/** A mask is any union of ALLEN's members: the bitwise OR of two masks is a valid mask. */
export const splitting = query(Schedule).rule((r) => {
	const booking = v(Booking, "booking")
	const open = v(RoomOpen, "roomOpen")
	return r
		.match(Booking, { room: booking.room, during: booking.during })
		.match(RoomOpen, { room: booking.room, during: open.during })
		.where(r.allen(booking.during, ALLEN.overlaps | ALLEN.overlappedBy, open.during))
		.find({ room: booking.room })
})
export const complemented: AllenMask = ALLEN.complement(ALLEN.before | ALLEN.meets)
export const conversed: AllenMask = ALLEN.converse(ALLEN.precedes)

/** The point-in-span test, `s @> t`, against a span parameter of the point's span type. */
declare const tick: Term<number>
export const windowed = query(Schedule).rule((r) => {
	const { room, during } = v(Booking, "booking")
	return r
		.match(Booking, { room, during })
		.where(r.pointIn(tick, r.param("window", Booking.fields.during)))
		.find({ room })
})

export type WindowedParams = Expect<
	Equals<ParamsOf<typeof windowed>, { readonly window: ParamType<Span<number>, "range"> }>
>

/**
 * Producers: intersection is zero or one fact, difference zero to two, pack the maximal covered segments; each keeps
 * the span type of its operands, and a parameter operand adopts it.
 */
export const produced = query(Schedule).rule((r) => {
	const booking = v(Booking, "booking")
	const open = v(RoomOpen, "roomOpen")
	return r
		.match(Booking, { room: booking.room, during: booking.during })
		.match(RoomOpen, { room: booking.room, during: open.during })
		.find({
			room: booking.room,
			shared: r.intersection(booking.during, open.during),
			outside: r.difference(booking.during, r.param("blackout", Booking.fields.during))
		})
})

export type ProducedHead = Expect<
	Equals<
		HeadOf<typeof produced>,
		{ readonly room: Uuid; readonly shared: Span<number>; readonly outside: Span<number> }
	>
>

export type ProducedParams = Expect<
	Equals<ParamsOf<typeof produced>, { readonly blackout: ParamType<Span<number>, "range"> }>
>

export const packed = query(Schedule).rule((r) => {
	const { room, during } = v(Booking, "booking")
	return r.match(Booking, { room, during }).find({ room, covered: r.pack(during) })
})
export type PackedHead = Expect<Equals<HeadOf<typeof packed>["covered"], Span<number>>>

/** Endpoints must agree: a span over a contract never meets a span over its bare base, and a mask needs spans. */
export const contractSpans = query(Schedule).rule((r) => {
	const { id, range, raw } = v(Budgeted, "budgeted")
	// @ts-expect-error -- TS2345: Span<Cents> and Span<bigint> do not meet
	const equal = r.allen(range, ALLEN.equals, raw)
	return r.match(Budgeted, { id, range, raw }).where(equal).find({ id })
})

export const notASpan = query(Schedule).rule((r) => {
	const { room } = v(Booking, "booking")
	// @ts-expect-error -- TS2345 refusal: a span term is required
	const equal = r.allen(room, ALLEN.equals, room)
	return r.match(Booking, { room }).where(equal).find({ room })
})

export const packNotASpan = query(Schedule).rule((r) => {
	const { room } = v(Booking, "booking")
	// @ts-expect-error -- TS2345: r.pack needs a span term
	return r.match(Booking, { room }).find({ room: r.pack(room) })
})

export const mixedIntersection = query(Schedule).rule((r) => {
	const { id, range, raw } = v(Budgeted, "budgeted")
	// @ts-expect-error -- TS2345: intersection keeps one endpoint type
	return r.match(Budgeted, { id, range, raw }).find({ id, both: r.intersection(raw, range) })
})

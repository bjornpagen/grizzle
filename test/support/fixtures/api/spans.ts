import { ALLEN } from "#compiler/public/allen.ts"
import { closedId, contract, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"

const RoomOpen = relation("RoomOpen", { room: Id, during: span(pg.bigint) }, ["room", "during"])
export const Booking = relation("Booking", { room: Id, during: span(pg.bigint), guest: Id }, [
	"room",
	"during"
])

/**
 * Spans and calendars in public-API form: the Schedule schema of room openings and bookings with its span keys and span
 * containment, an Allen-mask query, the point-in-span day lookup over a calendar relation, and a span-typed window
 * parameter.
 */
export const Schedule = schema(
	"Schedule",
	[RoomOpen, Booking],
	[contained(on(Booking, "room", "during"), on(RoomOpen, "room", "during"))]
)

/** Bookings sharing a point with a span-typed window parameter. */
export const intersecting = query(Schedule).rule((r) => {
	const { room, during } = v(Booking, "booking")
	return r
		.match(Booking, { room, during })
		.where(r.allen(during, ALLEN.intersects, r.param("window", Booking.fields.during)))
		.find({ room, during })
})

/**
 * Bookings that lie inside an opening of their room, neither starting nor ending with it: the mask the span
 * containment law is pointwise about, read as a query over the two relations.
 */
export const strictlyInside = query(Schedule).rule((r) => {
	const { room, during } = v(Booking, "booking")
	const { during: open } = v(RoomOpen, "roomOpen")
	return r
		.match(Booking, { room, during })
		.match(RoomOpen, { room, during: open })
		.where(r.allen(during, ALLEN.during, open))
		.find({ room, during, open })
})

const instantKey = Symbol("Instant")
/** A calendar as a span relation, its days keyed and its spans a nonoverlap key. */
const Instant = contract<typeof instantKey>()("Instant", pg.bigint)
const chicagoDayKey = Symbol("ChicagoDay")
const ChicagoDay = contract<typeof chicagoDayKey>()("ChicagoDay", pg.bigint)
const chicagoWeekKey = Symbol("ChicagoWeek")
const ChicagoWeek = contract<typeof chicagoWeekKey>()("ChicagoWeek", pg.bigint)
const Weekday = closed.ordered("Weekday", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
export const ChicagoCalendar = relation(
	"ChicagoCalendar",
	{ day: ChicagoDay, span: span(Instant), week: ChicagoWeek, weekday: closedId(Weekday) },
	["day"]
)
/** A fact that carries only an instant, bucketed into days by the calendar join. */
const Visit = relation("Visit", { id: Id, at: Instant }, ["id"])
export const Calendars = schema(
	"Calendars",
	[Weekday, ChicagoCalendar, Visit],
	[key(on(ChicagoCalendar, "span"))]
)

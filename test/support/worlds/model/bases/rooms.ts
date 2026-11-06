import type { Array as Arr } from "effect"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	ClosedSpec,
	EntrySpec,
	FieldDomain,
	InstallSpec,
	Occurrence,
	Rule,
	SideSpec,
	Term
} from "#test/support/worlds/model/types.ts"

const uuid: FieldDomain = { kind: "uuid" }

/** A subject: a booking's, an event's and a talk's author, and the session's user. */
const subject: FieldDomain = textDomain("^u_[a-z]{1,8}$", "u")

/** Hours, half-open: a room's opening hours and a booking's stay. */
const hours: FieldDomain = { kind: "span", bits: 32 }

/** A room's seats: a contract over a 32-bit integer whose domain holds 0 to 9. */
const seats: FieldDomain = { kind: "contract", name: "Seats", bits: 32, min: 0, max: 9 }

/** What an event is: a talk, which has its talk's details, or a meeting, which has none. */
const eventKind: ClosedSpec = { name: "Kind", members: ["Talk", "Meeting"] }

const kind: FieldDomain = { kind: "handle", closed: eventKind.name, members: eventKind.members }

const side = (relation: string, fields: Arr.NonEmptyReadonlyArray<string>): SideSpec => ({
	relation,
	fields,
	where: {}
})

/**
 * The rooms base, one relation per shape a write through a world meets and a law of every family README "Rules" lists:
 * rooms, whose seats are a contract (a domain CHECK) and at least one (a row check); each room's opening hours, a
 * mutable pure set keyed WITHOUT OVERLAPS, so a room's openings never share an hour, and each in a room (a containment,
 * deferred, since a room has a field outside its id); bookings, a mutable relation keyed WITHOUT OVERLAPS by room and
 * stay, each covered by its room's openings (a coverage, a PERIOD foreign key) and at most one per user and room (a
 * candidate key); events, each a talk or a meeting, a talk with exactly one talk row (alternatives: two containments,
 * each way, on a cycle and so deferred); the kinds of event a room suits, an immutable pure set, each of a room; and
 * which room adjoins which, an immutable pure set of two rooms, whose chains a recursive read walks.
 * A session's user is the token's `sub`.
 */
export const roomsBase: BaseSpec = {
	name: "Rooms",
	closed: [eventKind],
	relations: [
		{
			name: "Room",
			fields: [
				{ name: "id", domain: uuid },
				{ name: "seats", domain: seats }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Opening",
			fields: [
				{ name: "room", domain: uuid },
				{ name: "hours", domain: hours }
			],
			key: ["room", "hours"],
			mutability: "mutable"
		},
		{
			name: "Booking",
			fields: [
				{ name: "room", domain: uuid },
				{ name: "during", domain: hours },
				{ name: "by", domain: subject }
			],
			key: ["room", "during"],
			mutability: "mutable"
		},
		{
			name: "Event",
			fields: [
				{ name: "id", domain: uuid },
				{ name: "kind", domain: kind },
				{ name: "by", domain: subject }
			],
			key: ["id"],
			mutability: "mutable"
		},
		{
			name: "Talk",
			fields: [
				{ name: "event", domain: uuid },
				{ name: "by", domain: subject }
			],
			key: ["event"],
			mutability: "immutable"
		},
		{
			name: "Label",
			fields: [
				{ name: "room", domain: uuid },
				{ name: "kind", domain: kind }
			],
			key: ["room", "kind"],
			mutability: "immutable"
		},
		{
			name: "Adjoins",
			fields: [
				{ name: "room", domain: uuid },
				{ name: "next", domain: uuid }
			],
			key: ["room", "next"],
			mutability: "immutable"
		}
	],
	laws: [
		{
			kind: "check",
			name: "Seated",
			relation: "Room",
			predicate: { kind: "compare", field: "seats", op: ">=", value: 1 }
		},
		{ kind: "contained", source: side("Opening", ["room"]), target: side("Room", ["id"]) },
		{
			kind: "covered",
			source: side("Booking", ["room"]),
			target: side("Opening", ["room"]),
			span: { source: "during", target: "hours" }
		},
		{ kind: "key", relation: "Booking", fields: ["by", "room"] },
		{
			kind: "alternatives",
			relation: "Event",
			tag: "kind",
			closed: eventKind.name,
			arms: { Talk: "Talk" }
		},
		{ kind: "contained", source: side("Label", ["room"]), target: side("Room", ["id"]) },
		{ kind: "contained", source: side("Adjoins", ["room"]), target: side("Room", ["id"]) },
		{ kind: "contained", source: side("Adjoins", ["next"]), target: side("Room", ["id"]) }
	],
	contexts: [
		{ name: "Session", claim: { kind: "top-level" }, fields: [{ name: "sub", domain: subject }] }
	],
	derived: []
}

const variable = (name: string): Term => ({ kind: "var", name })
const sub: Term = { kind: "context", context: "Session", field: "sub" }
const talk: Term = { kind: "handle", closed: eventKind.name, member: "Talk" }
const of = (name: string, fields: Readonly<Record<string, Term>>): Occurrence => ({
	source: { kind: "ordinary", name },
	fields
})
const rule = (
	matches: Arr.NonEmptyReadonlyArray<Occurrence>,
	head: Readonly<Record<string, Term>>,
	comparisons: Rule["comparisons"]
): Rule => ({ matches, negations: [], comparisons, head })
const query = (one: Rule): EntrySpec => ({ kind: "query", rules: [one] })
const whole = (relation: string): EntrySpec => ({ kind: "whole", relation })

const id = variable("id")
const room = variable("room")
const during = variable("during")
const open = variable("hours")
const many = variable("seats")
const event = variable("event")
const what = variable("kind")

/**
 * The rooms base's worlds, two of them partial. The signed-in `booker`, in the login `web`, writes its own bookings,
 * events and talks, each `by` filled from the token's subject, and reads every opening whole: a booking meets another
 * user's booking it cannot see at the span key, its room's openings at the coverage and its own other booking of the
 * room at the candidate key; an event of kind Talk meets its talk at the alternatives; it reads which room adjoins
 * which whole. The `keeper`, in the login `ops`, writes rooms through a query entry of every room, the openings of
 * rooms of at least two seats and the rooms that suit talks (a pure set's entry whose kind its fill fixes), and reads
 * every booking whole without writing one. The `admin`, in `ops` too, holds every relation whole and writes each.
 */
export const roomsInstall: InstallSpec = {
	base: roomsBase,
	roles: [
		{
			name: "booker",
			entries: {
				MyBooking: query(rule([of("Booking", { room, during, by: sub })], { room, during }, [])),
				MyEvent: query(rule([of("Event", { id, kind: what, by: sub })], { id, kind: what }, [])),
				MyTalk: query(rule([of("Talk", { event, by: sub })], { event }, [])),
				Opening: whole("Opening"),
				Adjoins: whole("Adjoins"),
				Kind: whole("Kind")
			},
			write: ["MyBooking", "MyEvent", "MyTalk"],
			refresh: []
		},
		{
			name: "keeper",
			entries: {
				Rooms: query(rule([of("Room", { id, seats: many })], { id, seats: many }, [])),
				BigOpening: query(
					rule(
						[of("Opening", { room, hours: open }), of("Room", { id: room, seats: many })],
						{
							room,
							hours: open
						},
						[{ left: many, op: ">=", right: { kind: "literal", value: 2 } }]
					)
				),
				TalkRooms: query(rule([of("Label", { room, kind: talk })], { room }, [])),
				Booking: whole("Booking")
			},
			write: ["Rooms", "BigOpening", "TalkRooms"],
			refresh: []
		},
		{
			name: "admin",
			entries: {
				Room: whole("Room"),
				Opening: whole("Opening"),
				Booking: whole("Booking"),
				Event: whole("Event"),
				Talk: whole("Talk"),
				Label: whole("Label"),
				Adjoins: whole("Adjoins"),
				Kind: whole("Kind")
			},
			write: ["Room", "Opening", "Booking", "Event", "Talk", "Label", "Adjoins"],
			refresh: []
		}
	],
	logins: [
		{ name: "web", roles: ["booker"] },
		{ name: "ops", roles: ["keeper", "admin"] }
	]
}

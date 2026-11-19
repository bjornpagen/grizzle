/** What the properties of capacity-table.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import { accumulated, drawn, generated, natural, pg, span } from "#compiler/public/fields.ts"
import {
	check,
	contained,
	counted,
	fin,
	fold,
	key,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { type Seat as FinSeat, seatTemplate } from "#test/pg/fin/installed.ts"
import type { FixtureSchema } from "#test/support/compile.ts"

/** §6's rows. */
export const rows = [
	"at most one",
	"at least one",
	"exactly one",
	"count in [lo, hi]",
	"count ≥ a target field",
	"weighted",
	"duration",
	"counting a selection",
	"source equal to target"
] as const

type Row = (typeof rows)[number]

/**
 * A row and a state of its schema: club 1's seats by their lead flags; its count of seats and the count it needs; its
 * seats' weights or shift lengths; or one seat's club and home.
 */
type Sketch =
	| Readonly<{
			row: "at most one" | "exactly one" | "counting a selection"
			leads: ReadonlyArray<boolean>
	  }>
	| Readonly<{
			row: "at least one" | "count in [lo, hi]" | "count ≥ a target field"
			seats: number
			need: number
	  }>
	| Readonly<{ row: "weighted" | "duration"; amounts: ReadonlyArray<number> }>
	| Readonly<{ row: "source equal to target"; club: number; home: number }>

/** How a native refuses a state: its SQLSTATE, the relation whose constraint refuses, and the kinds of law it reports. */
interface Refusal {
	readonly sqlstate: string
	readonly relation: string
	readonly law: ReadonlyArray<string>
}

/** One INSERT of rows into a relation by its columns' roles. */
const insert = (
	seat: FinSeat,
	relation: string,
	roles: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string | number>>
): string =>
	`INSERT INTO ${seat.table(relation)} (${Arr.join(
		Arr.map(roles, (r) => seat.column(relation, r)),
		", "
	)}) VALUES ${Arr.join(
		Arr.map(rows, (row) => `(${Arr.join(Arr.map(row, String), ", ")})`),
		", "
	)}`

const Club = relation("Club", { id: pg.integer }, ["id"])

const Seat = relation("Seat", { id: pg.integer, club: pg.integer, lead: pg.boolean }, ["id"])

const leads = select(Seat, (s) => s.eq(s.lead, true))

const atMostOne = schema("fin_cap_at_most_one", [Club, Seat], [key(on(leads, "club"))])

const exactlyOne = schema(
	"fin_cap_exactly_one",
	[Club, Seat],
	[key(on(leads, "club")), contained(on(Club, "id"), on(leads, "club"))]
)

/** A club counting its seats, a counted family. */
const CountedClub = relation("Club", { id: pg.integer, n: drawn(natural), need: natural }, ["id"])

const CountedSeat = relation("Seat", { id: pg.integer, club: pg.integer }, ["id"])

const seats = counted(on(CountedSeat, "club"), fin(CountedClub, "n"))

const atLeastOne = schema(
	"fin_cap_at_least_one",
	[CountedClub, CountedSeat],
	[seats, check("AtLeastOne", CountedClub, (c) => c.ge(c.n, 1n))]
)

const countBetween = schema(
	"fin_cap_between",
	[CountedClub, CountedSeat],
	[seats, check("OneToThree", CountedClub, (c) => c.and(c.ge(c.n, 1n), c.le(c.n, 3n)))]
)

const countAtLeastField = schema(
	"fin_cap_at_least_field",
	[CountedClub, CountedSeat],
	[seats, check("Needed", CountedClub, (c) => c.ge(c.n, c.need))]
)

/** A club whose seats' weights a sum fold totals: the family ordered, its accumulators hidden. */
const WeighedClub = relation(
	"Club",
	{ id: pg.integer, n: drawn(natural), total: accumulated(pg.integer, 0) },
	["id"]
)

const WeighedSeat = relation(
	"Seat",
	{ id: pg.integer, club: pg.integer, at: drawn(natural), weight: pg.integer },
	["id"]
)

const weighed = ordered(on(WeighedSeat, "club", "at"), fin(WeighedClub, "n"))

const weightedSchema = schema(
	"fin_cap_weighted",
	[WeighedClub, WeighedSeat],
	[
		weighed,
		fold(weighed, Monoid.sum, on(WeighedSeat, "club", "weight"), on(WeighedClub, "id", "total")),
		check("AtMostTen", WeighedClub, (c) => c.le(c.total, 10))
	]
)

/** A club's shifts, each a span whose width is a generated field, summed: a duration made a weight. */
const Shift = relation.generated(
	"Seat",
	{ id: pg.integer, club: pg.integer, at: drawn(natural), during: span(pg.integer) },
	["id"],
	(r) => ({
		length: generated(
			pg.integer,
			Compute.when(
				Compute.within(Compute.width(r.during, pg.integer), 0n, 2_147_483_647n),
				(w) => Compute.cast(w, pg.integer),
				0
			)
		)
	})
)

const shifts = ordered(on(Shift, "club", "at"), fin(WeighedClub, "n"))

const durationSchema = schema(
	"fin_cap_duration",
	[WeighedClub, Shift],
	[
		shifts,
		fold(shifts, Monoid.sum, on(Shift, "club", "length"), on(WeighedClub, "id", "total")),
		check("AtMostEight", WeighedClub, (c) => c.le(c.total, 8))
	]
)

/** A club counting its lead seats by a count fold over a selection. */
const LedClub = relation(
	"Club",
	{ id: pg.integer, n: drawn(natural), leads: accumulated(natural, 0n) },
	["id"]
)

const LedSeat = relation(
	"Seat",
	{ id: pg.integer, club: pg.integer, at: drawn(natural), lead: pg.boolean },
	["id"]
)

const led = ordered(on(LedSeat, "club", "at"), fin(LedClub, "n"))

const countingSelection = schema(
	"fin_cap_counting",
	[LedClub, LedSeat],
	[
		led,
		fold(
			led,
			Monoid.count,
			on(
				select(LedSeat, (s) => s.eq(s.lead, true)),
				"club"
			),
			on(LedClub, "id", "leads")
		),
		check("OneLead", LedClub, (c) => c.le(c.leads, 1n))
	]
)

/** A seat whose club is its home: the row check the capacity's equal source and target always was. */
const HomeSeat = relation("Seat", { id: pg.integer, club: pg.integer, home: pg.integer }, ["id"])

const sourceEqualsTarget = schema(
	"fin_cap_equal",
	[HomeSeat],
	[check("AtHome", HomeSeat, (s) => s.eq(s.club, s.home))]
)

const clubSeats = ["id", "club", "lead"] as const

/** One INSERT of rows, or nothing for none. */
const insertSome = (
	seat: FinSeat,
	relation: string,
	roles: ReadonlyArray<string>,
	rows: ReadonlyArray<ReadonlyArray<string | number>>
): ReadonlyArray<string> => (rows.length === 0 ? [] : [insert(seat, relation, roles, rows)])

/**
 * The rows of a counted family of `n` seats of club 1: each seat its index and copy; the members of the counted family
 * the hidden index ‹i› holds.
 */
const countedRows = (seat: FinSeat, n: number, need: number): ReadonlyArray<string> => [
	insert(seat, "Club", ["id", "n", "need"], [[1, n, need]]),
	...insertSome(
		seat,
		"Seat",
		["id", "club", "‹i›", "‹n›"],
		Arr.map(indices(n), (i) => [10 + i, 1, i, n])
	)
]

/** An ordered family of club 1 whose sum fold's hidden accumulators the reference sum fills, its total the last. */
const summedRows = (
	seat: FinSeat,
	amounts: ReadonlyArray<number>,
	column: "weight" | "during"
): ReadonlyArray<string> => {
	const totals = Arr.scan(amounts, 0, (total, w) => total + w)
	return [
		insert(seat, "Club", ["id", "n", "total"], [[1, amounts.length, Arr.lastNonEmpty(totals)]]),
		...insertSome(
			seat,
			"Seat",
			["id", "club", "at", "‹n›", column, "‹before 0.0›", "‹after 0.0›"],
			Arr.map(amounts, (w, i) => [
				10 + i,
				1,
				i,
				amounts.length,
				column === "weight" ? w : `'[0,${w})'`,
				Arr.getUnsafe(totals, i),
				Arr.getUnsafe(totals, i + 1)
			])
		)
	]
}

/** An ordered family of club 1 whose count fold over its leads the reference counts. */
const ledRows = (seat: FinSeat, flags: ReadonlyArray<boolean>): ReadonlyArray<string> => {
	const counts = Arr.scan(flags, 0, (count, lead) => count + (lead ? 1 : 0))
	return [
		insert(seat, "Club", ["id", "n", "leads"], [[1, flags.length, Arr.lastNonEmpty(counts)]]),
		...insertSome(
			seat,
			"Seat",
			["id", "club", "at", "‹n›", "lead", "‹before 0.0›", "‹after 0.0›"],
			Arr.map(flags, (lead, i) => [
				10 + i,
				1,
				i,
				flags.length,
				lead ? "true" : "false",
				Arr.getUnsafe(counts, i),
				Arr.getUnsafe(counts, i + 1)
			])
		)
	]
}

/** Club 1's seats, numbered from 1, by their lead flags. */
const ledSeats = (flags: ReadonlyArray<boolean>): ReadonlyArray<ReadonlyArray<string | number>> =>
	Arr.map(flags, (lead, i) => [i + 1, 1, lead ? "true" : "false"])

/** Each row's schema and the relations it declares. */
export const schemas: Readonly<
	Record<Row, Readonly<{ schema: FixtureSchema; relations: Arr.NonEmptyReadonlyArray<string> }>>
> = {
	"at most one": { schema: atMostOne, relations: ["Club", "Seat"] },
	"at least one": { schema: atLeastOne, relations: ["Club", "Seat"] },
	"exactly one": { schema: exactlyOne, relations: ["Club", "Seat"] },
	"count in [lo, hi]": { schema: countBetween, relations: ["Club", "Seat"] },
	"count ≥ a target field": { schema: countAtLeastField, relations: ["Club", "Seat"] },
	weighted: { schema: weightedSchema, relations: ["Club", "Seat"] },
	duration: { schema: durationSchema, relations: ["Club", "Seat"] },
	"counting a selection": { schema: countingSelection, relations: ["Club", "Seat"] },
	"source equal to target": { schema: sourceEqualsTarget, relations: ["Seat"] }
}

export const sketchGen: Gen<Sketch> = (source) => {
	const row = source.draw(element(rows))
	switch (row) {
		case "at most one":
		case "exactly one":
		case "counting a selection":
			return { row, leads: source.draw(array(boolean, { min: 0, max: 4 })) }
		case "at least one":
		case "count in [lo, hi]":
		case "count ≥ a target field":
			return { row, seats: source.draw(int(0, 5)), need: source.draw(int(0, 5)) }
		case "weighted":
			return { row, amounts: source.draw(array(int(-1, 6), { min: 0, max: 3 })) }
		case "duration":
			return { row, amounts: source.draw(array(int(1, 6), { min: 0, max: 3 })) }
		case "source equal to target":
			return { row, club: source.draw(int(1, 3)), home: source.draw(int(1, 3)) }
	}
}

/** The statements that write a sketch's state, in one transaction. */
export const statementsOf = (seat: FinSeat, sketch: Sketch): ReadonlyArray<string> => {
	switch (sketch.row) {
		case "at most one":
			return [
				insert(seat, "Club", ["id"], [[1]]),
				...insertSome(seat, "Seat", clubSeats, ledSeats(sketch.leads))
			]
		case "exactly one":
			return [
				...insertSome(seat, "Seat", clubSeats, ledSeats(sketch.leads)),
				insert(seat, "Club", ["id"], [[1]])
			]
		case "counting a selection":
			return ledRows(seat, sketch.leads)
		case "at least one":
		case "count in [lo, hi]":
		case "count ≥ a target field":
			return countedRows(seat, sketch.seats, sketch.need)
		case "weighted":
			return summedRows(seat, sketch.amounts, "weight")
		case "duration":
			return summedRows(seat, sketch.amounts, "during")
		case "source equal to target":
			return [insert(seat, "Seat", ["id", "club", "home"], [[1, sketch.club, sketch.home]])]
	}
}

const projectedKey: Refusal = { sqlstate: "23505", relation: "Seat", law: ["key", "projectedKey"] }

const clubCheck: Refusal = { sqlstate: "23514", relation: "Club", law: ["check"] }

const sum = (amounts: ReadonlyArray<number>): number => Arr.reduce(amounts, 0, (t, w) => t + w)

const leadsOf = (flags: ReadonlyArray<boolean>): number => Arr.filter(flags, (lead) => lead).length

/**
 * Each row's law over its state, restated, and the native that refuses a state that breaks it: a club leads at most
 * once, and exactly once where a club must lead, its key on the seats refusing a second lead before the club's
 * containment into its leads refuses a club without one; a count of at least one, of one to three, or at least the
 * count needed; weights totalling at most ten, shifts at most eight, at most one lead counted; a seat at its home.
 */
export const capacityRefusalOf = (sketch: Sketch): Option.Option<Refusal> => {
	switch (sketch.row) {
		case "at most one":
			return leadsOf(sketch.leads) <= 1 ? Option.none() : Option.some(projectedKey)
		case "exactly one":
			return leadsOf(sketch.leads) > 1
				? Option.some(projectedKey)
				: leadsOf(sketch.leads) === 0
					? Option.some({ sqlstate: "23503", relation: "Club", law: ["containment"] })
					: Option.none()
		case "counting a selection":
			return leadsOf(sketch.leads) <= 1 ? Option.none() : Option.some(clubCheck)
		case "at least one":
			return sketch.seats >= 1 ? Option.none() : Option.some(clubCheck)
		case "count in [lo, hi]":
			return sketch.seats >= 1 && sketch.seats <= 3 ? Option.none() : Option.some(clubCheck)
		case "count ≥ a target field":
			return sketch.seats >= sketch.need ? Option.none() : Option.some(clubCheck)
		case "weighted":
			return sum(sketch.amounts) <= 10 ? Option.none() : Option.some(clubCheck)
		case "duration":
			return sum(sketch.amounts) <= 8 ? Option.none() : Option.some(clubCheck)
		case "source equal to target":
			return sketch.club === sketch.home
				? Option.none()
				: Option.some({ sqlstate: "23514", relation: "Seat", law: ["check"] })
	}
}

export type CapacityFeature = `${Row} ${"committed" | "refused natively"}`

/** Each row's schema installed once per member (installed.ts seatTemplate), which its cases' seats clone. */
export const capacitySeats = {
	"at most one": seatTemplate(import.meta, schemas["at most one"].schema, "capacity at most one"),
	"at least one": seatTemplate(
		import.meta,
		schemas["at least one"].schema,
		"capacity at least one"
	),
	"exactly one": seatTemplate(import.meta, schemas["exactly one"].schema, "capacity exactly one"),
	"count in [lo, hi]": seatTemplate(
		import.meta,
		schemas["count in [lo, hi]"].schema,
		"capacity count in [lo, hi]"
	),
	"count ≥ a target field": seatTemplate(
		import.meta,
		schemas["count ≥ a target field"].schema,
		"capacity count ≥ a target field"
	),
	weighted: seatTemplate(import.meta, schemas["weighted"].schema, "capacity weighted"),
	duration: seatTemplate(import.meta, schemas["duration"].schema, "capacity duration"),
	"counting a selection": seatTemplate(
		import.meta,
		schemas["counting a selection"].schema,
		"capacity counting a selection"
	),
	"source equal to target": seatTemplate(
		import.meta,
		schemas["source equal to target"].schema,
		"capacity source equal to target"
	)
} as const

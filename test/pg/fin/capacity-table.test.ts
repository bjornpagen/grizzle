/**
 * fin.md §6's capacity table through grizzle's lowering, on PostgreSQL 19rc1: every use of the deleted `capacity` is
 * a native law, and the violation the old capacity refused is refused natively, by PostgreSQL, with the SQLSTATE of the
 * native its row names, reporting that row's law.
 *
 * - **The specification turned into a checker:** §6's table, one case per row, each a schema stating the row's
 *   replacement over a club and its seats, a lawful state that must commit, and the old capacity's violation, which
 *   must be refused at its statement with the row's SQLSTATE by a constraint of the row's relation reporting a law of
 *   the row's kind (installed.ts reads the law off the installation's constraint map).
 *
 * One departure from §6's text, recorded in NP's report: "at least one" as a bare containment into `select(S, φ)` is no
 * native, because a containment's target must contain a key (laws/model/plan.ts, "a containment into an unkeyed side
 * is not admitted"); its replacement here is the counted family with `check(T, n ≥ 1)`, the count row with lo = 1.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
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
import { cleared, type Seat, seatOf } from "#test/pg/fin/installed.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** §6's rows. */
type Row =
	| "at most one"
	| "at least one"
	| "exactly one"
	| "count in [lo, hi]"
	| "count ≥ a target field"
	| "weighted"
	| "duration"
	| "counting a selection"
	| "source equal to target"

/** One row's case: its schema, its relations, a lawful state, the old capacity's violation and how it is refused. */
interface Case {
	readonly row: Row
	readonly schema: unknown
	readonly relations: Arr.NonEmptyReadonlyArray<string>
	readonly lawful: (seat: Seat) => ReadonlyArray<string>
	readonly violation: (seat: Seat) => ReadonlyArray<string>
	/** The SQLSTATE, the relation whose constraint refuses, and the kind of law it reports. */
	readonly refused: {
		readonly sqlstate: string
		readonly relation: string
		readonly law: ReadonlyArray<string>
	}
}

/** One INSERT of rows into a relation by its columns' roles. */
const insert = (
	seat: Seat,
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

const Club = relation("Club", { id: pg.int4 }, ["id"])
const Seat = relation("Seat", { id: pg.int4, club: pg.int4, lead: pg.bool }, ["id"])
const leads = select(Seat, (s) => s.eq(s.lead, true))

const atMostOne = schema("fin_cap_at_most_one", { Club, Seat }, [key(on(leads, "club"))])

const exactlyOne = schema("fin_cap_exactly_one", { Club, Seat }, [
	key(on(leads, "club")),
	contained(on(Club, "id"), on(leads, "club"))
])

/** A club counting its seats, a counted family. */
const CountedClub = relation("Club", { id: pg.int4, n: drawn(natural), need: natural }, ["id"])
const CountedSeat = relation("Seat", { id: pg.int4, club: pg.int4 }, ["id"])
const seats = counted(on(CountedSeat, "club"), fin(CountedClub, "n"))

const atLeastOne = schema("fin_cap_at_least_one", { Club: CountedClub, Seat: CountedSeat }, [
	seats,
	check("AtLeastOne", CountedClub, (c) => c.ge(c.n, 1n))
])

const countBetween = schema("fin_cap_between", { Club: CountedClub, Seat: CountedSeat }, [
	seats,
	check("OneToThree", CountedClub, (c) => c.and(c.ge(c.n, 1n), c.le(c.n, 3n)))
])

const countAtLeastField = schema(
	"fin_cap_at_least_field",
	{ Club: CountedClub, Seat: CountedSeat },
	[seats, check("Needed", CountedClub, (c) => c.ge(c.n, c.need))]
)

/** A club whose seats' weights a sum fold totals: the family ordered, its accumulators hidden. */
const WeighedClub = relation(
	"Club",
	{ id: pg.int4, n: drawn(natural), total: accumulated(pg.int4, 0) },
	["id"]
)
const WeighedSeat = relation(
	"Seat",
	{ id: pg.int4, club: pg.int4, at: drawn(natural), weight: pg.int4 },
	["id"]
)
const weighed = ordered(on(WeighedSeat, "club", "at"), fin(WeighedClub, "n"))

const weightedSchema = schema("fin_cap_weighted", { Club: WeighedClub, Seat: WeighedSeat }, [
	weighed,
	fold(weighed, Monoid.sum, on(WeighedSeat, "club", "weight"), on(WeighedClub, "id", "total")),
	check("AtMostTen", WeighedClub, (c) => c.le(c.total, 10))
])

/** A club's shifts, each a span whose width is a generated field, summed: a duration made a weight. */
const Shift = relation.generated(
	"Seat",
	{ id: pg.int4, club: pg.int4, at: drawn(natural), during: span(pg.int4) },
	["id"],
	(r) => ({
		length: generated(
			pg.int4,
			Compute.when(
				Compute.within(Compute.width(r.during, pg.int4), 0n, 2_147_483_647n),
				(w) => Compute.cast(w, pg.int4),
				0
			)
		)
	})
)
const shifts = ordered(on(Shift, "club", "at"), fin(WeighedClub, "n"))

const durationSchema = schema("fin_cap_duration", { Club: WeighedClub, Seat: Shift }, [
	shifts,
	fold(shifts, Monoid.sum, on(Shift, "club", "length"), on(WeighedClub, "id", "total")),
	check("AtMostEight", WeighedClub, (c) => c.le(c.total, 8))
])

/** A club counting its lead seats by a count fold over a selection. */
const LedClub = relation(
	"Club",
	{ id: pg.int4, n: drawn(natural), leads: accumulated(natural, 0n) },
	["id"]
)
const LedSeat = relation(
	"Seat",
	{ id: pg.int4, club: pg.int4, at: drawn(natural), lead: pg.bool },
	["id"]
)
const led = ordered(on(LedSeat, "club", "at"), fin(LedClub, "n"))

const countingSelection = schema("fin_cap_counting", { Club: LedClub, Seat: LedSeat }, [
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
])

/** A seat whose club is its home: the row check the capacity's equal source and target always was. */
const HomeSeat = relation("Seat", { id: pg.int4, club: pg.int4, home: pg.int4 }, ["id"])
const sourceEqualsTarget = schema("fin_cap_equal", { Seat: HomeSeat }, [
	check("AtHome", HomeSeat, (s) => s.eq(s.club, s.home))
])

const clubSeats = ["id", "club", "lead"] as const

/**
 * The rows of a counted family of `n` seats of club 1: each seat its index and copy; the members of the counted family
 * the hidden index ‹i› holds.
 */
const countedRows = (seat: Seat, n: number, need: number): ReadonlyArray<string> => [
	insert(seat, "Club", ["id", "n", "need"], [[1, n, need]]),
	...(n === 0
		? []
		: [
				insert(
					seat,
					"Seat",
					["id", "club", "‹i›", "‹n›"],
					Arr.map(Arr.range(0, n - 1), (i) => [10 + i, 1, i, n])
				)
			])
]

/** An ordered family of club 1 whose sum fold's hidden accumulators the reference sum fills, its total the last. */
const summedRows = (
	seat: Seat,
	weights: ReadonlyArray<number>,
	column: "weight" | "during"
): ReadonlyArray<string> => {
	let at = 0
	const rows = Arr.map(weights, (w, i) => {
		const before = at
		at += w
		return [10 + i, 1, i, weights.length, column === "weight" ? w : `'[0,${w})'`, before, at]
	})
	return [
		insert(seat, "Club", ["id", "n", "total"], [[1, weights.length, at]]),
		insert(seat, "Seat", ["id", "club", "at", "‹n›", column, "‹before 0.0›", "‹after 0.0›"], rows)
	]
}

/** An ordered family of club 1 whose count fold over its leads the reference counts. */
const ledRows = (seat: Seat, flags: ReadonlyArray<boolean>): ReadonlyArray<string> => {
	let at = 0
	const rows = Arr.map(flags, (lead, i) => {
		const before = at
		at += lead ? 1 : 0
		return [10 + i, 1, i, flags.length, lead ? "true" : "false", before, at]
	})
	return [
		insert(seat, "Club", ["id", "n", "leads"], [[1, flags.length, at]]),
		insert(seat, "Seat", ["id", "club", "at", "‹n›", "lead", "‹before 0.0›", "‹after 0.0›"], rows)
	]
}

const CASES: Arr.NonEmptyReadonlyArray<Case> = [
	{
		row: "at most one",
		schema: atMostOne,
		relations: ["Club", "Seat"],
		lawful: (s) => [
			insert(s, "Club", ["id"], [[1]]),
			insert(s, "Seat", clubSeats, [
				[1, 1, "true"],
				[2, 1, "false"]
			])
		],
		violation: (s) => [
			insert(s, "Seat", clubSeats, [
				[1, 1, "true"],
				[2, 1, "true"]
			])
		],
		refused: { sqlstate: "23505", relation: "Seat", law: ["key", "projectedKey"] }
	},
	{
		row: "at least one",
		schema: atLeastOne,
		relations: ["Club", "Seat"],
		lawful: (s) => countedRows(s, 1, 0),
		violation: (s) => countedRows(s, 0, 0),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "exactly one",
		schema: exactlyOne,
		relations: ["Club", "Seat"],
		lawful: (s) => [
			insert(s, "Seat", clubSeats, [
				[1, 1, "true"],
				[2, 1, "false"]
			]),
			insert(s, "Club", ["id"], [[1]])
		],
		violation: (s) => [
			insert(s, "Seat", clubSeats, [[2, 1, "false"]]),
			insert(s, "Club", ["id"], [[1]])
		],
		refused: { sqlstate: "23503", relation: "Club", law: ["containment"] }
	},
	{
		row: "count in [lo, hi]",
		schema: countBetween,
		relations: ["Club", "Seat"],
		lawful: (s) => countedRows(s, 3, 0),
		violation: (s) => countedRows(s, 4, 0),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "count ≥ a target field",
		schema: countAtLeastField,
		relations: ["Club", "Seat"],
		lawful: (s) => countedRows(s, 2, 2),
		violation: (s) => countedRows(s, 2, 3),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "weighted",
		schema: weightedSchema,
		relations: ["Club", "Seat"],
		lawful: (s) => summedRows(s, [4, 6], "weight"),
		violation: (s) => summedRows(s, [4, 7], "weight"),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "duration",
		schema: durationSchema,
		relations: ["Club", "Seat"],
		lawful: (s) => summedRows(s, [3, 5], "during"),
		violation: (s) => summedRows(s, [3, 6], "during"),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "counting a selection",
		schema: countingSelection,
		relations: ["Club", "Seat"],
		lawful: (s) => ledRows(s, [false, true, false]),
		violation: (s) => ledRows(s, [true, false, true]),
		refused: { sqlstate: "23514", relation: "Club", law: ["check"] }
	},
	{
		row: "source equal to target",
		schema: sourceEqualsTarget,
		relations: ["Seat"],
		lawful: (s) => [insert(s, "Seat", ["id", "club", "home"], [[1, 1, 1]])],
		violation: (s) => [insert(s, "Seat", ["id", "club", "home"], [[1, 1, 2]])],
		refused: { sqlstate: "23514", relation: "Seat", law: ["check"] }
	}
]

type CapacityFeature = `${Row} refused natively`

layer(Substrate.layer)(
	"fin.md §6's capacity table through grizzle's lowering on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"commit each row's lawful state and refuse the old capacity's violation natively, with the row's SQLSTATE and law",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "fin/capacity-table",
							generator: element(CASES),
							literal: (c: Case) => c.row,
							limit: CASES.length,
							box: "every row of fin.md §6's capacity table",
							oracle: {
								kind: "specification",
								name: "fin.md §6's capacity table as a checker: each row's native, SQLSTATE and law"
							},
							coverage: requiredInSpace<CapacityFeature>(
								Arr.map(CASES, (c): CapacityFeature => `${c.row} refused natively`)
							),
							caseHang
						},
						(c: Case, note) =>
							Effect.gen(function* () {
								const seat = yield* seatOf(c.schema, c.relations, `capacity ${c.row}`)
								const lawful = yield* attempt(seat.session, c.lawful(seat))
								assert.equal(
									lawful.kind,
									"committed",
									`${c.row}: the lawful state commits: ${Formatter.format(lawful)}`
								)
								yield* cleared(seat, c.relations)
								const real = yield* attempt(seat.session, c.violation(seat))
								yield* seat.session.resetStatements
								if (real.kind !== "refused") {
									return assert.fail(`${c.row}: the old capacity's violation committed`)
								}
								const named = seat.refusedBy(real.fields)
								const laws = Arr.flatMap(c.refused.law, seat.lawsOf)
								assert.ok(
									real.fields.code === c.refused.sqlstate &&
										Option.exists(
											named,
											(k) =>
												k.relation === c.refused.relation &&
												Option.exists(k.law, (l) => laws.includes(l))
										),
									`${c.row}: refused by ${refusalText(real.fields)}, not ${c.refused.sqlstate} by a ${Arr.join(c.refused.law, " or ")} law of ${c.refused.relation}`
								)
								note.note(`${c.row} refused natively`)
							}).pipe(Effect.scoped)
					)
				)
		)
	}
)

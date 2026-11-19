/** What the properties of candidate-key-race.test.ts read: its spaces, models and helpers. */

import type { Case } from "@bjornpagen/testing/explore"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int, constant } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { threeKeys, twoKeys } from "#test/schedules/write/support.ts"
import { answered, type WriteAnswer } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openActors, textOfValue } from "#test/support/schedules/actors.ts"
import { every, everyRelation } from "#test/support/schedules/interleave.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import {
	type Explained,
	type RaceTxn,
	runSerialRace,
	type SerialRaceFailed
} from "#test/support/schedules/serial.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)

const bookingSpan = key(on(Booking, "room", "during"))

const bookingRef = key(on(Booking, "ref"))

/** A booking keyed by its ref, whose id the database draws: a generated addition of it arbitrates at its primary key
 * ref (see the header). */
const Stay = relation(
	"Stay",
	{
		id: pg.uuidv7,
		room: pg.integer,
		during: span(pg.integer),
		ref: pg.integer,
		ticket: pg.integer
	},
	["ref"]
)

const staySpan = key(on(Stay, "room", "during"))

const stayTicket = key(on(Stay, "ticket"))

const relations = Object.freeze({ Booking, Stay })

const statements = Object.freeze([bookingSpan, bookingRef, staySpan, stayTicket])

/**
 * The schema under its installed name with its worlds: the full role `app` the grizzle writer opens, in the login
 * `server`, whose workload holds the empty ChangeSet a writer's first call applies, the insert and the put of a
 * booking, and the insert of a stay, each of the facts its call gives; and the full role `direct` the direct actors
 * take on, in the login `psql`.
 */
const renamed = (name: string) => {
	const base = schema(name, Rec.values(relations), statements)
	const app = role(base, "app", relations, { write: ["Booking", "Stay"] })
	const direct = role(base, "direct", relations, { write: ["Booking", "Stay"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app], {
			workload: [
				workload(app, {
					noop: ChangeSet.empty(base),
					insertBooking: ChangeSet.empty(base).insert(Booking, []),
					putBooking: ChangeSet.empty(base).put(Booking, []),
					insertStay: ChangeSet.empty(base).insert(Stay, [])
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

interface Booked {
	readonly id: number
	readonly room: number
	readonly during: { readonly start: number; readonly end: number }
	readonly ref: number
}

/** A booking race: the requested fact and how the apply writes it, the initial facts, the direct writer's fact and the
 * blocker. */
interface BookingRace {
	readonly requested: Booked
	readonly how: "insert" | "put"
	readonly initial: ReadonlyArray<Booked>
	readonly direct: Booked
	readonly blocker:
		| { readonly kind: "none" }
		| { readonly kind: "inserts"; readonly fact: Booked; readonly end: "commit" | "rollback" }
}

/** A stay as a call states it: every field but the id the database draws. */
interface Stayed {
	readonly room: number
	readonly during: { readonly start: number; readonly end: number }
	readonly ref: number
	readonly ticket: number
}

/** The keys beside a generated addition's arbiter that a stay race's direct writer meets it at: the span key, an
 * exclusion constraint PostgreSQL raises 23P01 at, and ticket's, a UNIQUE it raises 23505 at. */
const besides = ["the span key", "ticket"] as const

type Beside = (typeof besides)[number]

/** A stay race: the requested stay the apply's generated addition writes, and the direct writer's stay, which meets it
 * at one key beside its arbiter and at no other key, from no stored stay. */
interface StayRace {
	readonly requested: Stayed
	readonly direct: Stayed
}

/** A case: a booking race and a stay race at each key beside the arbiter, run one after the other on one installation. */
interface Races {
	readonly booking: BookingRace
	readonly stays: { readonly [B in Beside]: StayRace }
}

/** What a race reached: the apply waited, met a refusal and each reason, its answer, how each direct writer ended, and
 * each stay race's UnseenOccupant. */
export type BookingFeature =
	| `the generated apply retried after an UnseenOccupant at ${Beside}`
	| "the apply waited"
	| "the apply refused"
	| `refused: ${TransientTag}`
	| `the apply answered ${WriteAnswer<WriteOutcome<unknown>>["kind"]}`
	| `${"direct" | "blocker"} ${"committed" | "rolled back" | "aborted" | "failed"}`

/** A span: where it starts, and its width. */
const spanGen: Gen<Booked["during"]> = (source) => {
	const start = source.draw(int(-999, 999))
	return { start, end: start + source.draw(int(1, 99)) }
}

/** A span starting inside `during`. */
const overlappingGen =
	(during: Booked["during"]): Gen<Booked["during"]> =>
	(source) => {
		const start = during.start + (source.draw(int(0, 2 ** 31 - 1)) % (during.end - during.start))
		return { start, end: start + source.draw(int(1, 99)) }
	}

/** How a fact stands to the requested one, the dictionary of what the keys branch on. */
const standings = [
	"the same fact",
	"overlapping in its room",
	"at its ref",
	"at its id",
	"apart"
] as const

/** The values a race's facts are drawn among: the requested fact, other ids, another room and another ref. */
interface Values {
	readonly requested: Booked
	readonly ids: readonly [number, number]
	readonly room: number
	readonly ref: number
}

const valuesGen: Gen<Values> = (source) => {
	const [id, first, second] = source.draw(threeKeys)
	const [room, otherRoom] = source.draw(twoKeys)
	const [ref, otherRef] = source.draw(twoKeys)
	return {
		requested: { id, room, during: source.draw(spanGen), ref },
		ids: [first, second],
		room: otherRoom,
		ref: otherRef
	}
}

/** A fact standing to the requested one as drawn. */
const relatedGen =
	(x: Values): Gen<Booked> =>
	(source) => {
		const other = source.draw(element(x.ids))
		switch (source.draw(element(standings))) {
			case "the same fact":
				return x.requested
			case "overlapping in its room":
				return {
					id: other,
					room: x.requested.room,
					during: source.draw(overlappingGen(x.requested.during)),
					ref: x.ref
				}
			case "at its ref":
				return { id: other, room: x.room, during: source.draw(spanGen), ref: x.requested.ref }
			case "at its id":
				return { id: x.requested.id, room: x.room, during: source.draw(spanGen), ref: x.ref }
			case "apart":
				return { id: other, room: x.room, during: source.draw(spanGen), ref: x.ref }
		}
	}

const bookingRaceGen: Gen<BookingRace> = (source) => {
	const x = source.draw(valuesGen)
	return {
		requested: x.requested,
		how: source.draw(element(["insert", "put"])),
		initial: source.draw(boolean) ? [source.draw(relatedGen(x))] : [],
		direct: source.draw(relatedGen(x)),
		blocker: source.draw(boolean)
			? {
					kind: "inserts",
					fact: source.draw(relatedGen(x)),
					end: source.draw(element(["commit", "rollback"]))
				}
			: { kind: "none" }
	}
}

/** A stay race whose direct writer's stay meets the requested one at `beside` alone: overlapping it in its room, or at
 * its ticket in another room; at another ref either way, so the apply's arbiter never meets it. */
const stayRaceGen =
	(beside: Beside): Gen<StayRace> =>
	(source) => {
		const [room, otherRoom] = source.draw(twoKeys)
		const [ref, otherRef] = source.draw(twoKeys)
		const [ticket, otherTicket] = source.draw(twoKeys)
		const requested: Stayed = { room, during: source.draw(spanGen), ref, ticket }
		switch (beside) {
			case "the span key":
				return {
					requested,
					direct: {
						room,
						during: source.draw(overlappingGen(requested.during)),
						ref: otherRef,
						ticket: otherTicket
					}
				}
			case "ticket":
				return {
					requested,
					direct: { room: otherRoom, during: source.draw(spanGen), ref: otherRef, ticket }
				}
		}
	}

export const racesGen: Gen<Races> = (source) => ({
	booking: source.draw(bookingRaceGen),
	stays: {
		"the span key": source.draw(stayRaceGen("the span key")),
		ticket: source.draw(stayRaceGen("ticket"))
	}
})

const spanText = (b: { readonly during: Booked["during"] }) => `[${b.during.start},${b.during.end})`

const values = (b: Booked) => `(${b.id}, ${b.room}, '${spanText(b)}', ${b.ref})`

/** The features one explained run reached (see BookingFeature). */
const featuresOf = (
	e: Explained<WriteAnswer<WriteOutcome<unknown>>>
): ReadonlyArray<BookingFeature> => {
	const waited = Arr.some(e.run.moves, (m) => m.session === "app" && m.observed._tag === "Waited")
	return [
		...(waited ? ["the apply waited" as const] : []),
		...Arr.flatMap([...e.ends], ([session, end]): ReadonlyArray<BookingFeature> => {
			switch (end.kind) {
				case "answered":
					return [
						`the apply answered ${end.retried.answered.kind}`,
						...(end.retried.refused.length > 0 ? ["the apply refused" as const] : []),
						...Arr.map(end.retried.refused, (reason): BookingFeature => `refused: ${reason}`)
					]
				case "committed":
				case "rolled back":
				case "aborted":
				case "failed":
					return session === "direct" || session === "blocker" ? [`${session} ${end.kind}`] : []
			}
		})
	]
}

/** The features one explained run of a stay race at `beside` reached: a run's, and the generated addition's retry after
 * an UnseenOccupant, which its direct writer's stay, meeting the requested one at `beside` alone, raised there. */
const stayFeaturesOf =
	(beside: Beside) =>
	(e: Explained<WriteAnswer<WriteOutcome<unknown>>>): ReadonlyArray<BookingFeature> => [
		...featuresOf(e),
		...(Arr.some(
			[...e.ends],
			([session, end]) =>
				session === "app" &&
				end.kind === "answered" &&
				end.retried.refused.includes("UnseenOccupant")
		)
			? [`the generated apply retried after an UnseenOccupant at ${beside}` as const]
			: [])
	]

/** A race as the serial race runs it: its name, its transactions, the statements that store its initial state, the
 * rows of its relation, every column the run and its reference both decide read as text, and what one explained run of
 * it reached. */
interface Staged {
	readonly name: string
	readonly txns: Arr.NonEmptyReadonlyArray<RaceTxn<WriteAnswer<WriteOutcome<unknown>>>>
	readonly initial: ReadonlyArray<string>
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly features: (
		e: Explained<WriteAnswer<WriteOutcome<unknown>>>
	) => ReadonlyArray<BookingFeature>
}

/**
 * Installs Booking with the owner's rebuilt key order (see the header), opens the apply's writer and the two direct
 * writers, and runs the booking race and then the stay race, every run judged by its serial reference.
 */
export const runRaces = (
	races: Races,
	c: Case<BookingFeature>
): Effect.Effect<
	void,
	CompileError | SqlError | TransactionRolledBack | OpenError | PsqlProcessError | SerialRaceFailed,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* openRig(renamed)
		const names = namesOf(rig.installed)
		const booking = names.table(Booking)
		for (const [law, kind, definition] of [
			[names.lawOf(bookingRef), "Unique", `UNIQUE (${names.column(Booking, "ref")})`],
			[names.primaryKeyLaw(Booking), "PrimaryKey", `PRIMARY KEY (${names.column(Booking, "id")})`]
		] as const) {
			const constraint = quoteIdent(names.constraintOf(law, kind))
			yield* rig.owner([
				`ALTER TABLE ${booking} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${definition}`
			])
		}
		const app = yield* rig.servedWriter(
			"app",
			(context) => openServed(rig.served.roles.app, {}).pipe(Effect.provideContext(context)),
			(db) => answered(db.workload.noop.once({ params: {}, facts: {} }))
		)
		const direct = yield* openActors(s, {
			direct: { kind: "raw", as: rig.direct },
			blocker: { kind: "raw", as: rig.direct }
		})
		/** A direct writer's transaction of one statement. */
		const directTxn = (
			session: "direct" | "blocker",
			sql: string,
			end: "commit" | "rollback"
		): RaceTxn<WriteAnswer<WriteOutcome<unknown>>> => ({
			kind: "direct",
			begin: beginSerializableAction,
			session,
			statements: [{ sql, footprint: everyRelation }],
			end
		})
		const bookingStaged = (race: BookingRace): Staged => {
			const listed = Arr.map(["id", "room", "during", "ref"] as const, (f) =>
				names.column(Booking, f)
			)
			const insert = (b: Booked) =>
				`INSERT INTO ${booking} (${Arr.join(listed, ", ")}) VALUES ${values(b)}`
			return {
				name: `an apply ${race.how} at the span key`,
				txns: [
					{
						kind: "grizzle",
						session: "app",
						label: `apply ${race.how}`,
						call:
							race.how === "insert"
								? answered(
										app.db.workload.insertBooking.once({
											params: {},
											facts: { insert: { Booking: [race.requested] } }
										})
									)
								: answered(
										app.db.workload.putBooking.once({
											params: {},
											facts: { put: { Booking: [race.requested] } }
										})
									),
						footprint: everyRelation
					},
					directTxn("direct", insert(race.direct), "commit"),
					...(race.blocker.kind === "none"
						? []
						: [directTxn("blocker", insert(race.blocker.fact), race.blocker.end)])
				],
				initial: Arr.map(race.initial, insert),
				table: booking,
				columns: listed,
				features: featuresOf
			}
		}
		const stayStaged = (beside: Beside, race: StayRace): Staged => {
			const stays = names.table(Stay)
			const listed = Arr.map(["room", "during", "ref", "ticket"] as const, (f) =>
				names.column(Stay, f)
			)
			const insert = (b: Stayed) =>
				`INSERT INTO ${stays} (${Arr.join(listed, ", ")}) VALUES (${b.room}, '${spanText(b)}', ${b.ref}, ${b.ticket})`
			return {
				name: `a generated addition of a stay beside one at ${beside}`,
				txns: [
					{
						kind: "grizzle",
						session: "app",
						label: "apply generated",
						call: answered(
							app.db.workload.insertStay.once({
								params: {},
								facts: { insert: { Stay: [race.requested] } }
							})
						),
						footprint: everyRelation
					},
					directTxn("direct", insert(race.direct), "commit")
				],
				initial: [],
				table: stays,
				columns: listed,
				features: stayFeaturesOf(beside)
			}
		}
		for (const staged of [
			bookingStaged(races.booking),
			...Arr.map(besides, (beside) => stayStaged(beside, races.stays[beside]))
		]) {
			yield* runSerialRace(
				rig.env,
				{ direct, grizzle: { app: app.actor } },
				{
					name: staged.name,
					txns: staged.txns,
					reset: rig.replace(staged.initial),
					state: Effect.map(
						rig.env.observer.queryValues(
							`SELECT ${Arr.join(
								Arr.map(staged.columns, (column) => `${column}::text`),
								", "
							)} FROM ${staged.table}`,
							[]
						),
						(rows) => Arr.map(rows, (row) => Arr.map(row, textOfValue))
					)
				},
				every,
				(e) => c.noteAll(staged.features(e))
			)
		}
	})

/** The cases of the rotating stream; its floor runs a quarter of them. */
export const runs = 8

const requested: Booked = { id: 1, room: 1, during: { start: 0, end: 10 }, ref: 1 }

const requestedStay: Stayed = { room: 1, during: { start: 0, end: 10 }, ref: 1, ticket: 1 }

/** The stay races of every kept case: the direct writer's stay overlapping the requested one at another ref and
 * ticket, and at its ticket in another room at another ref. */
const keptStays: Races["stays"] = {
	"the span key": {
		requested: requestedStay,
		direct: { room: 1, during: { start: 5, end: 15 }, ref: 2, ticket: 2 }
	},
	ticket: {
		requested: requestedStay,
		direct: { room: 2, during: { start: 0, end: 10 }, ref: 2, ticket: 1 }
	}
}

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const raceCases: ReadonlyArray<{
	readonly why: string
	readonly value: Races
	readonly reaches: ReadonlyArray<BookingFeature>
}> = [
	{
		why: "an identical insert committed while the apply waits at the span key: the blocker holds the requested ref in another room, the direct writer's span entry waits there, and the apply's waits on it, so its exclusion check meets the committed repeat",
		value: {
			booking: {
				requested,
				how: "insert",
				initial: [],
				direct: requested,
				blocker: {
					kind: "inserts",
					fact: { id: 2, room: 2, during: { start: 0, end: 10 }, ref: 1 },
					end: "rollback"
				}
			},
			stays: keptStays
		},
		reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
	},
	{
		why: "an identical put committed while the apply waits at the span key, the same window",
		value: {
			booking: {
				requested,
				how: "put",
				initial: [],
				direct: requested,
				blocker: {
					kind: "inserts",
					fact: { id: 2, room: 2, during: { start: 0, end: 10 }, ref: 1 },
					end: "rollback"
				}
			},
			stays: keptStays
		},
		reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
	},
	{
		why: "an overlapping fact committed while the apply waits at the span key: the retry's probe finds it, the span key's law; and a stay overlapping the requested one, and a stay at its ticket in another room, each at another ref and committed while the generated addition waits at that key, which its arbiter ref never meets: 23P01 at the span key or 23505 at ticket, the UnseenOccupant it is retried after, then that key's law",
		value: {
			booking: {
				requested,
				how: "insert",
				initial: [],
				direct: { id: 3, room: 1, during: { start: 5, end: 15 }, ref: 2 },
				blocker: { kind: "none" }
			},
			stays: keptStays
		},
		reaches: [
			"the apply waited",
			"the apply refused",
			"the apply answered refused",
			"the generated apply retried after an UnseenOccupant at the span key",
			"the generated apply retried after an UnseenOccupant at ticket"
		]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<BookingFeature>, Gen<Races>]> = Arr.flatMap(
	raceCases,
	(c) => Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
)

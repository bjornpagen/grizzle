/**
 * Races at a span candidate key: an apply of a Booking racing direct writers of Booking, at its span key, its other
 * candidate key and its primary key; and a generated addition of a Stay racing a direct writer of Stay at the span key
 * its arbiter does not meet.
 *
 * Booking(id, room, during, ref) is keyed by id, with the span candidate key (room, during), a UNIQUE ... WITHOUT
 * OVERLAPS that PostgreSQL enforces as an exclusion constraint, and the candidate key ref. The insert protocol probes
 * every key under its snapshot, so a refusal at a key can only come from an occupant that snapshot did not see: the
 * attempt fails as a TransientFailure, and the retry finds the committed fact equal, a repeat, or another at the key,
 * that key's law. An insert of complete facts at SERIALIZABLE arbitrates every object (ON CONFLICT DO NOTHING, no
 * target: write/insert/protocol.ts arbitrationOf), so PostgreSQL 19rc2 refuses an occupant its snapshot cannot see with
 * 40001 (nodeModifyTable.c ExecCheckTIDVisible), a SerializationFailure, and never with a 23P01 or 23505.
 *
 * Stay(id, room, during, ref) draws `id` by its `uuidv7()` default, with the span candidate key (room, during) and the
 * candidate key ref. A generated addition of a Stay leaves the id out, so it arbitrates at ref, the first declared key
 * that holds no drawn field and no span (write/insert/unique.ts generatedArbiter), and the span key is an object beside
 * its arbiter, which PostgreSQL checks as it inserts: an overlapping stay its snapshot cannot see, committed while the
 * apply waits there, fails the statement with 23P01 (execIndexing.c check_exclusion_or_unique_constraint, which asks
 * SSI nothing first). The insert lists the span key as an UnseenOccupant abort (write/program/compile.ts
 * uniqueAbortsOf), so the attempt fails as a TransientFailure, and the retry's probe finds the occupant, the span key's
 * law, as the serial order with the direct writer first says.
 *
 * An exclusion constraint inserts the row's entry before it checks, so a second writer of an overlapping fact waits on
 * the apply's entry while the apply waits on its own, a deadlock: the window one writer opens at a plain candidate key
 * cannot be opened by one here. Two open it: the owner rebuilds ref's key and then the primary key, so PostgreSQL inserts
 * into the span key's index first, then ref's, then the primary key's; a blocker holds an uncommitted fact at the
 * requested ref in another room; a direct writer inserting the requested fact keeps its span entry and waits at that
 * ref on the blocker before it reaches the primary key; and the apply's span entry waits on the writer's.
 *
 * Property: every run of a race, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the apply (retried after each TransientFailure until it answers), the direct
 * writer's and the blocker's transactions, each run alone from the race's initial state in an order that respects
 * real time, show what they showed in the run (the apply's outcome, each statement's SQLSTATE on its constraint) and
 * leave its state. The races draw the requested fact, an insert or a put of it, an initial fact, the direct writer's
 * fact and the blocker's, each standing to the requested one as a dictionary of what the keys branch on says (the same
 * fact, overlapping it in its room, at its ref, at its id, or apart), and how the blocker ends. Every case then runs a
 * stay race on its installation: a requested Stay and the direct writer's Stay overlapping it in its room at another
 * ref, its state read without the ids the database drew.
 *
 * The kept races are the windows the races were first planted for: an identical insert, and an identical put,
 * committed by the direct writer while the apply waits at the span key, each a repeat, unchanged; and an overlapping
 * fact committed while the apply waits at the span key, the span key's law, beside an overlapping Stay committed while
 * the generated addition waits at the span key, the UnseenOccupant it is retried after.
 *
 * Features: the apply waited, the apply refused, and the generated addition retried after an UnseenOccupant.
 *
 * @plant test/plants/schedules/spans/candidate-key-exclusion-not-transient.patch A span key's exclusion violation from
 * an occupant the snapshot did not see is classified as the key's law, not a TransientFailure (adapter/outcomes/index.ts
 * transientFailureOf), so the generated addition is refused at once by the native violation, never retried into the
 * probe's refusal its serial order shows; the property fails.
 * @plant test/plants/schedules/laws/payroll-race-span-abort-not-transient.patch SERIALIZABLE's 40001 is read as no
 * TransientFailure (adapter/errors/execution.ts serializableRefusal), so an apply that met an unseen occupant fails
 * where its serial reference answers; the property fails.
 */

import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { threeKeys, twoKeys } from "#test/schedules/write/support.ts"
import { type WriteAnswer, answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
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
/** A booking whose id the database draws: a generated addition of it arbitrates at ref (see the header). */
const Stay = relation(
	"Stay",
	{ id: pg.uuidv7, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)
const staySpan = key(on(Stay, "room", "during"))
const stayRef = key(on(Stay, "ref"))
const relations = Object.freeze({ Booking, Stay })
const statements = Object.freeze([bookingSpan, bookingRef, staySpan, stayRef])

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
}

/** A stay race: the requested stay the apply's generated addition writes, and the direct writer's stay, overlapping it
 * in its room at another ref, which the apply's arbiter never meets, from no stored stay. */
interface StayRace {
	readonly requested: Stayed
	readonly direct: Stayed
}

/** A case: a booking race and a stay race, run one after the other on one installation. */
interface Races {
	readonly booking: BookingRace
	readonly stay: StayRace
}

/** What a race reached: the apply waited, met a refusal and each reason, its answer, how each direct writer ended, and
 * the stay race's UnseenOccupant. */
type BookingFeature =
	| "the generated apply retried after an UnseenOccupant"
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

const stayRaceGen: Gen<StayRace> = (source) => {
	const room = source.draw(int(1, 3))
	const [ref, otherRef] = source.draw(twoKeys)
	const requested: Stayed = { room, during: source.draw(spanGen), ref }
	return {
		requested,
		direct: { room, during: source.draw(overlappingGen(requested.during)), ref: otherRef }
	}
}

const racesGen: Gen<Races> = (source) => ({
	booking: source.draw(bookingRaceGen),
	stay: source.draw(stayRaceGen)
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

/** The features one explained run of a stay race reached: a run's, and the generated addition's retry after an
 * UnseenOccupant. */
const stayFeaturesOf = (
	e: Explained<WriteAnswer<WriteOutcome<unknown>>>
): ReadonlyArray<BookingFeature> => [
	...featuresOf(e),
	...(Arr.some(
		[...e.ends],
		([session, end]) =>
			session === "app" && end.kind === "answered" && end.retried.refused.includes("UnseenOccupant")
	)
		? ["the generated apply retried after an UnseenOccupant" as const]
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
const runRaces = (
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
		const stayStaged = (race: StayRace): Staged => {
			const stays = names.table(Stay)
			const listed = Arr.map(["room", "during", "ref"] as const, (f) => names.column(Stay, f))
			const insert = (b: Stayed) =>
				`INSERT INTO ${stays} (${Arr.join(listed, ", ")}) VALUES (${b.room}, '${spanText(b)}', ${b.ref})`
			return {
				name: "a generated addition of a stay beside an overlapping one",
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
				features: stayFeaturesOf
			}
		}
		for (const staged of [bookingStaged(races.booking), stayStaged(races.stay)]) {
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
const runs = 8

const requested: Booked = { id: 1, room: 1, during: { start: 0, end: 10 }, ref: 1 }
/** A stay race whose direct writer's stay overlaps the requested one at another ref. */
const overlappedStay: StayRace = {
	requested: { room: 1, during: { start: 0, end: 10 }, ref: 1 },
	direct: { room: 1, during: { start: 5, end: 15 }, ref: 2 }
}

layer(Substrate.layer, { excludeTestServices: true })(
	"races at a span candidate key, an apply beside direct writers",
	(it) => {
		it.effect(
			"every race of an apply and direct writers at a span candidate key is serializable",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "specification",
								name: "serializability: the apply and the direct transactions run alone in a real-time order show and leave what the run did"
							},
							suite: "schedules/spans/candidate-key-race",
							draw: drawn(racesGen),
							literal: Formatter.format,
							coverage: required<BookingFeature>(
								[
									"the apply waited",
									"the apply refused",
									"the generated apply retried after an UnseenOccupant"
								],
								{ cases: runs, sense: notesOnly }
							),
							kept: [
								{
									note: "an identical insert committed while the apply waits at the span key: the blocker holds the requested ref in another room, the direct writer's span entry waits there, and the apply's waits on it, so its exclusion check meets the committed repeat",
									sketch: {
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
										stay: overlappedStay
									},
									draws: "",
									reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
								},
								{
									note: "an identical put committed while the apply waits at the span key, the same window",
									sketch: {
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
										stay: overlappedStay
									},
									draws: "",
									reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
								},
								{
									note: "an overlapping fact committed while the apply waits at the span key: the retry's probe finds it, the span key's law; and a stay overlapping the requested one at another ref, committed while the generated addition waits at the span key, which its arbiter ref never meets: 23P01 there, the UnseenOccupant it is retried after, then the span key's law",
									sketch: {
										booking: {
											requested,
											how: "insert",
											initial: [],
											direct: { id: 3, room: 1, during: { start: 5, end: 15 }, ref: 2 },
											blocker: { kind: "none" }
										},
										stay: overlappedStay
									},
									draws: "",
									reaches: [
										"the apply waited",
										"the apply refused",
										"the apply answered refused",
										"the generated apply retried after an UnseenOccupant"
									]
								}
							],
							runs,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: runs,
							caseHang
						},
						(races, c) => Effect.scoped(runRaces(races, c))
					)
				)
		)
	}
)

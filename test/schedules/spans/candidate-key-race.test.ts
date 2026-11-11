/**
 * Races at a span candidate key: an apply of a Booking racing direct writers of Booking, at its span key, its other
 * candidate key and its primary key.
 *
 * Booking(id, room, during, ref) is keyed by id, with the span candidate key (room, during), a UNIQUE ... WITHOUT
 * OVERLAPS that PostgreSQL enforces as an exclusion constraint, and the candidate key ref. The insert protocol probes
 * every key under its snapshot, so a refusal at a key can only come from an occupant that snapshot did not see: the
 * attempt fails as a TransientFailure, and the retry finds the committed fact equal, a repeat, or another at the key,
 * that key's law.
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
 * fact, overlapping it in its room, at its ref, at its id, or apart), and how the blocker ends.
 *
 * The kept races are the windows the races were first planted for: an identical insert, and an identical put,
 * committed by the direct writer while the apply waits at the span key, each a repeat, unchanged; and an overlapping
 * fact committed while the apply waits at the span key, the span key's law.
 *
 * Features: the apply waited, the apply refused.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): candidate-key-exclusion-not-transient.patch (a span key's exclusion
 * violation from an occupant the snapshot did not see classified as the key's law, not a TransientFailure, so a
 * committed repeat is refused rather than retried into an unchanged answer).
 */

import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, type Scope } from "effect"
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
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)
const bookingSpan = key(on(Booking, "room", "during"))
const bookingRef = key(on(Booking, "ref"))
const relations = Object.freeze({ Booking })
const statements = Object.freeze([bookingSpan, bookingRef])

/**
 * The schema under its installed name with its worlds: the full role `app` the grizzle writer opens, in the login
 * `server`, whose workload holds the empty ChangeSet a writer's first call applies, and the insert and the put of a
 * booking, each of the facts its call gives; and the full
 * role `direct` the direct actors take on, in the login `psql`.
 */
const renamed = (name: string) => {
	const base = schema(name, relations, statements)
	const app = role(base, "app", relations, { write: ["Booking"] })
	const direct = role(base, "direct", relations, { write: ["Booking"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app], {
			workload: [
				workload(app, {
					noop: ChangeSet.empty(base),
					insertBooking: ChangeSet.empty(base).insert(Booking, []),
					putBooking: ChangeSet.empty(base).put(Booking, [])
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

/** A race: the requested fact and how the apply writes it, the initial facts, the direct writer's fact and the blocker. */
interface BookingRace {
	readonly requested: Booked
	readonly how: "insert" | "put"
	readonly initial: ReadonlyArray<Booked>
	readonly direct: Booked
	readonly blocker:
		| { readonly kind: "none" }
		| { readonly kind: "inserts"; readonly fact: Booked; readonly end: "commit" | "rollback" }
}

/** What a race reached: the apply waited, met a refusal and each reason, its answer, and how each direct writer ended. */
type BookingFeature =
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
			case "overlapping in its room": {
				const width = x.requested.during.end - x.requested.during.start
				const start = x.requested.during.start + (source.draw(int(0, 2 ** 31 - 1)) % width)
				return {
					id: other,
					room: x.requested.room,
					during: { start, end: start + source.draw(int(1, 99)) },
					ref: x.ref
				}
			}
			case "at its ref":
				return { id: other, room: x.room, during: source.draw(spanGen), ref: x.requested.ref }
			case "at its id":
				return { id: x.requested.id, room: x.room, during: source.draw(spanGen), ref: x.ref }
			case "apart":
				return { id: other, room: x.room, during: source.draw(spanGen), ref: x.ref }
		}
	}

const raceGen: Gen<BookingRace> = (source) => {
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

const spanText = (b: Booked) => `[${b.during.start},${b.during.end})`
const values = (b: Booked) => `(${b.id}, ${b.room}, '${spanText(b)}', ${b.ref})`

/** The features one explained run reached (see BookingFeature). */
const featuresOf = (e: Explained<WriteAnswer<WriteOutcome<unknown>>>): ReadonlyArray<BookingFeature> => {
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

/**
 * Installs Booking with the owner's rebuilt key order (see the header), opens the apply's writer and the two direct
 * writers, and runs the race, every run judged by its serial reference.
 */
const runRace = (
	race: BookingRace,
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
		const listed = Arr.map(["id", "room", "during", "ref"] as const, (f) =>
			names.column(Booking, f)
		)
		const insert = (b: Booked) =>
			`INSERT INTO ${booking} (${Arr.join(listed, ", ")}) VALUES ${values(b)}`
		const blocker: ReadonlyArray<RaceTxn<WriteAnswer<WriteOutcome<unknown>>>> =
			race.blocker.kind === "none"
				? []
				: [
						{
							kind: "direct",
							session: "blocker",
							statements: [{ sql: insert(race.blocker.fact), footprint: everyRelation }],
							end: race.blocker.end
						}
					]
		const apply: RaceTxn<WriteAnswer<WriteOutcome<unknown>>> = {
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
		}
		yield* runSerialRace(
			rig.env,
			{ direct, grizzle: { app: app.actor } },
			{
				name: `an apply ${race.how} at the span key`,
				txns: [
					apply,
					{
						kind: "direct",
						session: "direct",
						statements: [{ sql: insert(race.direct), footprint: everyRelation }],
						end: "commit"
					},
					...blocker
				],
				reset: rig.replace(Arr.map(race.initial, insert)),
				state: Effect.map(
					rig.env.observer.queryValues(
						`SELECT ${Arr.join(
							Arr.map(listed, (column) => `${column}::text`),
							", "
						)} FROM ${booking}`,
						[]
					),
					(rows) => Arr.map(rows, (row) => Arr.map(row, textOfValue))
				)
			},
			every,
			(e) => c.noteAll(featuresOf(e))
		)
	})

/** The cases of the rotating stream; its floor runs a quarter of them. */
const runs = 8

const requested: Booked = { id: 1, room: 1, during: { start: 0, end: 10 }, ref: 1 }

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
							draw: drawn(raceGen),
							literal: Formatter.format,
							coverage: required<BookingFeature>(["the apply waited", "the apply refused"], {
								cases: runs,
								sense: notesOnly
							}),
							kept: [
								{
									note: "an identical insert committed while the apply waits at the span key: the blocker holds the requested ref in another room, the direct writer's span entry waits there, and the apply's waits on it, so its exclusion check meets the committed repeat",
									sketch: {
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
									draws: "",
									reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
								},
								{
									note: "an identical put committed while the apply waits at the span key, the same window",
									sketch: {
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
									draws: "",
									reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
								},
								{
									note: "an overlapping fact committed while the apply waits at the span key: the retry's probe finds it, the span key's law",
									sketch: {
										requested,
										how: "insert",
										initial: [],
										direct: { id: 3, room: 1, during: { start: 5, end: 15 }, ref: 2 },
										blocker: { kind: "none" }
									},
									draws: "",
									reaches: ["the apply waited", "the apply refused", "the apply answered refused"]
								}
							],
							runs,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: runs,
							caseHang
						},
						(race, c) => Effect.scoped(runRace(race, c))
					)
				)
		)
	}
)

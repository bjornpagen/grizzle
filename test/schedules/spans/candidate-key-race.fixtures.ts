/** What the properties of candidate-key-race.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int, constant } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CompileError, TransientTag } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { range, int4 } from "#compiler/public/fields.ts"
import { key, login, mutable, on, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
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
import { threeKeys, twoKeys } from "#test/support/schedules/write/support.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Booking = relation("Booking", { id: int4, room: int4, during: range(int4), ref: int4 }, [
	"id"
])

const bookingSpan = key(on(Booking, "room", "during"))

const bookingRef = key(on(Booking, "ref"))
const relations = Object.freeze({ Booking })
/** Booking is open, a put displacing its rows, mutable in the unit of its id; its candidate keys keep the put a pair. */
const statements = Object.freeze([
	bookingSpan,
	bookingRef,
	unit("Booking", { id: int4 }),
	mutable(Booking)
])

/**
 * The schema under its installed name with its worlds: the full role `app` the grizzle writer opens, in the login
 * `server`, whose workload holds the empty ChangeSet a writer's first call applies, and the insert and the put of a
 * booking, each of the facts its call gives; and the full role `direct` the direct actors
 * take on, in the login `psql`.
 */
const renamed = (name: string) => {
	const base = schema(name, Rec.values(relations), statements)
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

/** What a race reached: the apply waited, met a refusal and each reason, its answer, and how each direct writer ended. */
export type BookingFeature =
	| "the apply waited"
	| "the apply refused"
	| `refused: ${TransientTag}`
	| `the apply answered ${WriteAnswer<WriteOutcome<unknown>>["_tag"]}`
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

export const bookingRaceGen: Gen<BookingRace> = (source) => {
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
						`the apply answered ${end.retried.answered._tag}`,
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
 * writers, and runs the booking race, every run judged by its serial reference.
 */
export const runRaces = (
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
			(db) => writeAnswerOf(db.workload.noop.once({ params: {}, facts: {} }))
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
								? writeAnswerOf(
										app.db.workload.insertBooking.once({
											params: {},
											facts: { insert: { Booking: [race.requested] } }
										})
									)
								: writeAnswerOf(
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
		for (const staged of [bookingStaged(race)]) {
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
/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const raceCases: ReadonlyArray<{
	readonly why: string
	readonly value: BookingRace
	readonly reaches: ReadonlyArray<BookingFeature>
}> = [
	{
		why: "an identical insert committed while the apply waits at the span key: the blocker holds the requested ref in another room, the direct writer's span entry waits there, and the apply's waits on it, so its exclusion check meets the committed repeat",
		value: {
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
		reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
	},
	{
		why: "an identical put committed while the apply waits at the span key, the same window",
		value: {
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
		reaches: ["the apply waited", "the apply refused", "the apply answered unchanged"]
	},
	{
		why: "an overlapping fact committed while the apply waits at the span key: the retry's probe finds it, the span key's law",
		value: {
			requested,
			how: "insert",
			initial: [],
			direct: { id: 3, room: 1, during: { start: 5, end: 15 }, ref: 2 },
			blocker: { kind: "none" }
		},
		reaches: ["the apply waited", "the apply refused", "the apply answered refused"]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<BookingFeature>, Gen<BookingRace>]> =
	Arr.flatMap(raceCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)

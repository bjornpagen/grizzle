/**
 * An exact repeat beside a concurrent identical insert, at a span candidate key: an exclusion that raises 23P01.
 *
 * Booking(id, room, during, ref) is keyed by id, with the span candidate key (room, during), a UNIQUE ... WITHOUT
 * OVERLAPS that PostgreSQL enforces as an exclusion constraint, and the candidate key ref. The insert protocol probes
 * both under its snapshot, so a 23P01 at the span key can only come from an occupant that snapshot did not see: the
 * apply's attempt fails once (its reason PostgreSQL's mechanism), and the retry's arbiter finds the committed fact
 * equal, a repeat, or its probe finds an overlapping one, the span key law with the requested fact at the key as the
 * witness.
 *
 * An exclusion constraint inserts the row's entry before it checks, so a second writer of an overlapping fact waits on
 * the apply's entry while the apply waits on its own, a deadlock: the window one writer opens at a plain candidate key
 * cannot be opened here. The repeat schedule opens it with two. The owner rebuilds ref's key and then the primary key,
 * so PostgreSQL inserts into the span key's index first, then ref's, then the primary key's. A blocker holds an
 * uncommitted fact at the requested ref in another room. The direct writer inserts exactly the fact the apply requests:
 * its span entry is checked and kept, and it waits at that ref on the blocker before it reaches the primary key. The
 * apply's arbiter pre-check finds no fact at its id, and its span entry waits on the writer's. The blocker rolls back;
 * the writer completes and commits, and the apply's exclusion check meets the committed fact: 23P01 on an exact repeat.
 *
 * The control: an overlapping different fact committed while the apply waits at the span key retries the same way and
 * is refused by the retry's probe.
 *
 * The ids, rooms, refs and spans are drawn.
 */

import { layer } from "@effect/vitest"
import { type Gen, int } from "@grizzle/testing/gen"
import { Array as Arr, Effect } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { key, login, relation, role, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { threeKeys, twoKeys } from "#test/schedules/write/support.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	awaits,
	begin,
	blocksOn,
	check,
	commit,
	complete,
	op,
	rollback,
	schedule,
	sql
} from "#test/support/schedules/build.ts"
import { applied, refusals, retried } from "#test/support/schedules/grizzle.ts"
import { ok, rows } from "#test/support/schedules/match.ts"
import { planted } from "#test/support/schedules/planted.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Booking = relation(
	"Booking",
	{ id: pg.integer, room: pg.integer, during: span(pg.integer), ref: pg.integer },
	["id"]
)
const bookingSpan = key(Booking, ["room", "during"])
const bookingRef = key(Booking, ["ref"])
const relations = { Booking }
const statements = [bookingSpan, bookingRef]
/**
 * The schema under its installed name with its worlds: the full role `app` the grizzle writer opens, in the login
 * `server`, and the full role `direct` the direct actors take on, in the login `psql`.
 */
const renamed = (name: string) => {
	const base = schema(name, relations, statements)
	const app = role(base, "app", relations, { write: ["Booking"] })
	const direct = role(base, "direct", relations, { write: ["Booking"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app]),
		psql: login(base, "psql", [direct])
	}
}

const setup = Effect.gen(function* () {
	const s = yield* Substrate
	const rig = yield* openRig("Bookings", renamed)
	const names = namesOf(rig.installed)
	const booking = names.table(Booking)
	for (const [law, kind, definition] of [
		[names.lawOf(bookingRef), "Unique", `UNIQUE (${names.column(Booking, "ref")})`],
		[names.primaryKeyLaw(Booking), "PrimaryKey", `PRIMARY KEY (${names.column(Booking, "id")})`]
	] as const) {
		const constraint = quoteIdent(names.constraintOf(law, kind))
		yield* rig.owner(
			`ALTER TABLE ${booking} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${definition}`
		)
	}
	const app = yield* rig.writer("app", (context) =>
		Db.open(rig.worlds.server.roles.app, {}).pipe(Effect.provideContext(context))
	)
	const direct = yield* openActors(s, {
		direct: { kind: "raw", as: rig.direct },
		blocker: { kind: "raw", as: rig.direct }
	})
	const columns = ["id", "room", "during", "ref"] as const
	const listed = Arr.map(columns, (c) => names.column(Booking, c))
	return {
		rig,
		names,
		app,
		booking,
		columns: Arr.join(listed, ", "),
		state: `SELECT ${Arr.join(
			Arr.map(listed, (c) => `${c}::text`),
			", "
		)} FROM ${booking} ORDER BY ${names.column(Booking, "id")}`,
		actors: { direct, grizzle: { app: app.actor } }
	}
})

interface Booked {
	readonly id: number
	readonly room: number
	readonly during: { readonly start: number; readonly end: number }
	readonly ref: number
}

const spanText = (b: Booked) => `[${b.during.start},${b.during.end})`
const values = (b: Booked) => `(${b.id}, ${b.room}, '${spanText(b)}', ${b.ref})`
const stateRow = (b: Booked) => [String(b.id), String(b.room), spanText(b), String(b.ref)]

/** A span: where it starts, and its width. */
const spanGen: Gen<Booked["during"]> = (source) => {
	const start = source.draw(int(-999, 999))
	return { start, end: start + source.draw(int(1, 99)) }
}

/** The requested booking, the blocker's and the overlapping one a case runs on. */
interface Bookings {
	readonly requested: Booked
	readonly blocker: Booked
	readonly overlapping: Booked
}

/**
 * The requested booking; the blocker's, at its ref in another room and at another id; and an overlapping one in its
 * room at another id and ref, the control's.
 */
const bookingsGen: Gen<Bookings> = (source) => {
	const [id, blockerId, otherId] = source.draw(threeKeys)
	const [room, otherRoom] = source.draw(twoKeys)
	const [ref, otherRef] = source.draw(twoKeys)
	const during = source.draw(spanGen)
	const blocked = source.draw(spanGen)
	/** Where the overlapping span starts within the requested one, and its width. */
	const offset = source.draw(int(0, 2 ** 31 - 1))
	const width = source.draw(int(1, 99))
	const start = during.start + (offset % (during.end - during.start))
	return {
		requested: { id, room, during, ref },
		blocker: { id: blockerId, room: otherRoom, during: blocked, ref },
		overlapping: { id: otherId, room, during: { start, end: start + width }, ref: otherRef }
	}
}

/**
 * The planted repeat: an identical `how` committed by a direct writer while the apply of the same fact waits at the span
 * key is no-change.
 */
const identicalRepeat = (how: "insert" | "put") =>
	planted(
		`span candidate key race/${how}`,
		bookingsGen,
		[`identical ${how} at the span key`],
		(b) =>
			Effect.gen(function* () {
				const x = yield* setup
				const changes =
					how === "insert"
						? ChangeSet.empty(x.rig.worlds.schema).insert(Booking, [b.requested])
						: ChangeSet.empty(x.rig.worlds.schema).put(Booking, [b.requested])
				return [
					yield* runSchedule(
						x.rig.env,
						schedule(`identical ${how} at the span key`, [
							begin("blocker"),
							sql(
								"blocker",
								`INSERT INTO ${x.booking} (${x.columns}) VALUES ${values(b.blocker)}`,
								ok(),
								complete
							),
							begin("direct"),
							sql(
								"direct",
								`INSERT INTO ${x.booking} (${x.columns}) VALUES ${values(b.requested)}`,
								ok(),
								blocksOn("blocker")
							),
							op(
								"app",
								`apply ${how}`,
								retried(x.app.db.apply(changes, {})),
								applied({ kind: "no-change", calls: refusals(1) }),
								blocksOn("direct")
							),
							rollback("blocker"),
							awaits("direct", complete),
							commit("direct", ok(), complete),
							awaits("app", complete),
							check(x.state, rows(stateRow(b.requested)))
						]),
						x.actors
					)
				]
			})
	)

layer(Substrate.layer, { excludeTestServices: true })(
	"an exact repeat beside a concurrent identical insert, at a span candidate key",
	(it) => {
		it.effect(
			"an identical insert committed while the apply waits at the span key is no-change",
			identicalRepeat("insert")
		)

		it.effect(
			"an identical put committed while the apply waits at the span key is no-change",
			identicalRepeat("put")
		)

		it.effect(
			"an overlapping fact committed while the apply waits at the span key is the span key's law",
			planted(
				"span candidate key race/control",
				bookingsGen,
				["overlapping fact at the span key"],
				(b) =>
					Effect.gen(function* () {
						const x = yield* setup
						return [
							yield* runSchedule(
								x.rig.env,
								schedule("overlapping fact at the span key", [
									begin("direct"),
									sql(
										"direct",
										`INSERT INTO ${x.booking} (${x.columns}) VALUES ${values(b.overlapping)}`,
										ok(),
										complete
									),
									op(
										"app",
										"apply insert",
										retried(
											x.app.db.apply(
												ChangeSet.empty(x.rig.worlds.schema).insert(Booking, [b.requested]),
												{}
											)
										),
										applied({
											kind: "invariant-rejected",
											calls: refusals(1),
											law: x.names.described(x.names.lawOf(bookingSpan)),
											witness: {
												kind: "key",
												relation: Booking.name,
												values: { room: b.requested.room, during: b.requested.during }
											}
										}),
										blocksOn("direct")
									),
									commit("direct", ok(), complete),
									awaits("app", complete),
									check(x.state, rows(stateRow(b.overlapping)))
								]),
								x.actors
							)
						]
					})
			)
		)
	}
)

/**
 * Two writers of one certified READ COMMITTED role collide on a generated addition's keys, and each call answers as
 * some serial order does.
 *
 * Sitting(id, child, test, attempt, note, slot) draws `id` by its `uuidv7()` default and is keyed by (child, test,
 * attempt) and by slot. A generated addition leaves `id` out, so its arbiter is (child, test, attempt), the first
 * declared key that holds no drawn field, and slot is a unique object besides it. The role `learner` holds Sitting and
 * Gate by its insert list alone, and its workload is `start`, an insertion of sittings, and `held`, an insertion of
 * sittings and then, in a later stratum, of a Gate row, each in two forms, drawn per case: the sittings an array of the
 * call's facts, or a query over the call's relation parameter `sittings`, whose head leaves the id out, as edullm's
 * Start inserts its sitting, reading back the sittings it added and the stored sittings it met (`startRead`,
 * `heldRead`). An array's read-back would be refused: an array of Sitting is two insertions, of the rows that state the
 * id and of those that leave it out, so its added and met sides are two statements' (README "Where a read-back runs").
 * The schema and its logins are installed and served as `grizzle generate` drafts them (schedules/rig.ts openRig):
 * `learner` runs at the level generate certifies, which the case requires to be READ COMMITTED, read off each
 * writer's served Db.
 *
 * Two writers A and B, two Dbs of `learner` over DbLayers of their own, run one call each over a stored state. In
 * `concurrent`, the schema's owner holds Gate in SHARE mode, which writes nothing, while A runs `held`: A's sittings
 * are written and uncommitted when its Gate insert waits on that lock (the lock barrier sees A blocked by the owner),
 * and B runs `start` then; the owner's COMMIT lets A finish. In `sequential`, A's call commits before B's begins. A
 * call the model refuses runs alone.
 *
 * Properties, per case:
 * - B waits for A exactly where it meets a row A holds uncommitted: at the arbiter, or at slot with its arbiter key
 *   free, unless a visible occupant refuses B's statement first; whether B's backend waited on A's is read from
 *   pg_locks until B's call ends, so a wait the model does not predict, and one it predicts that never comes, fails
 *   the case where it happens.
 * - Each call answers what the serial order A, then B, answers:
 *   - an exact repeat at the arbiter key, a row equal at every field the addition states, is no change, and a query
 *     member's call reads that stored row back whole through delta.met, its id the one the database drew for it, a row
 *     in flight it waited for included, on the first try;
 *   - a differing row at the arbiter key refuses the key (child, test, attempt), its witness that key;
 *   - a row at slot with the arbiter key free refuses slot: by the probe, its witness the requested slot, where the
 *     statement's snapshot sees the occupant; otherwise by PostgreSQL's 23505 after the wait, a typed refusal on slot's
 *     law, never an abort or a defect, its witness the stated slot where an array states one distinct slot value, and
 *     `unreported` where it states several or the rows are a query's, which the host does not hold;
 *   - every other request is inserted, and a call that inserts any row is accepted with that count, a query member's
 *     reading back through delta.added exactly the rows it made.
 * - The table ends as the serial order leaves it: one row per key, each stored row with its id, every id a version 7
 *   uuid.
 *
 * Oracle: the serial model below, over the stated rows alone. The probe's refusal, both arbiter waits, every 23505
 * witness and both met rows read back are required features, among every other kind of answer.
 *
 * Plants: ~/.cache/grizzle-release/BR08/plants/collisions-generated-arbiter-last-key.patch, a generated addition
 * arbitrated at the last declared key holding no drawn field (slot) instead of the first, must turn the property red;
 * so must ~/.cache/grizzle-release/DELTAMET/plants/met-keep-where.patch, the arbiter's DO SELECT returning only an
 * occupant whose payload differs, so an exact repeat meets nothing it reads back.
 */
import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet, sameLaw } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, lawsByStatement, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { DeltaSource, Law, Witness } from "#compiler/types/changeset/changeset.ts"
import { assert, deepEquals, defined } from "#test/support/assert.ts"
import { type WriteAnswer, answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Sitting = relation(
	"Sitting",
	{
		id: pg.uuidv7,
		child: pg.integer,
		test: pg.integer,
		attempt: pg.integer,
		note: pg.integer,
		slot: pg.integer
	},
	["id"]
)
/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
const Gate = relation("Gate", { id: pg.uuidv7, n: pg.integer }, ["id"])
/** The fields a sitting's request states: every field but its drawn id. */
const statedFields = ["child", "test", "attempt", "note", "slot"] as const
const sittingKey = key(on(Sitting, "child", "test", "attempt"))
const slotKey = key(on(Sitting, "slot"))

/** The schema, the role `learner`, which inserts Sitting and Gate and nothing else, and its two logins. A call of a
 * query member reads back the sittings it added and the stored sittings it met, every field of each. */
const collisions = (name: string) => {
	const base = schema(name, [Sitting, Gate], [sittingKey, slotKey])
	const learner = role(base, "learner", { Sitting, Gate }, { insert: ["Sitting", "Gate"] })
	const direct = role(base, "direct", { Sitting, Gate })
	/** The sittings a call states as its relation parameter `sittings`, every field but the drawn id. */
	const given = query(base).rule((r) => {
		const rows = r.relation("sittings", {
			child: Sitting.fields.child,
			test: Sitting.fields.test,
			attempt: Sitting.fields.attempt,
			note: Sitting.fields.note,
			slot: Sitting.fields.slot
		})
		const { child, test, attempt, note, slot } = v(rows, "given")
		return r
			.match(rows, { child, test, attempt, note, slot })
			.find({ child, test, attempt, note, slot })
	})
	const sittingsOf = (side: DeltaSource<typeof Sitting>) =>
		query(base).rule((r) => {
			const { id, child, test, attempt, note, slot } = v(side, "sitting")
			return r
				.match(side, { id, child, test, attempt, note, slot })
				.find({ id, child, test, attempt, note, slot })
		})
	return {
		schema: base,
		learner,
		direct,
		server: login(base, "server", [learner], {
			workload: [
				workload(learner, {
					start: ChangeSet.empty(base).insert(Sitting, []),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Sitting, []),
						ChangeSet.empty(base).insert(Gate, [])
					),
					startRead: ChangeSet.empty(base)
						.insert(Sitting, given)
						.read("added", (d) => sittingsOf(d.added(Sitting)))
						.read("met", (d) => sittingsOf(d.met(Sitting))),
					heldRead: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Sitting, given),
						ChangeSet.empty(base).insert(Gate, [])
					)
						.read("added", (d) => sittingsOf(d.added(Sitting)))
						.read("met", (d) => sittingsOf(d.met(Sitting)))
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One requested sitting: every field but the drawn id. */
interface Request {
	readonly child: number
	readonly test: number
	readonly attempt: number
	readonly note: number
	readonly slot: number
}

type Mode = "concurrent" | "sequential"

/** How both calls state their sittings: an array of the call's facts, or a query member's relation parameter, read
 * back. */
type Form = "array" | "query"

interface Collision {
	readonly mode: Mode
	readonly form: Form
	readonly stored: ReadonlyArray<Request>
	readonly a: ReadonlyArray<Request>
	readonly b: ReadonlyArray<Request>
}

type CollisionFeature =
	| "an exact repeat of a row in flight, after waiting"
	| "a differing row at the arbiter key in flight, refused after waiting"
	| "a 23505 at slot after waiting, its stated slot the witness"
	| "a 23505 at slot after waiting, unreported among several slots"
	| "a 23505 at slot after waiting, unreported for a query's rows"
	| "an exact repeat of a visible row"
	| "a row in flight met, read back"
	| "a visible row met, read back"
	| "a differing row at a visible arbiter key"
	| "a visible occupant at slot, refused by the probe"
	| "an insert after waiting for a row in flight"
	| "an insert without waiting"

const sameKey = (x: Request, y: Request): boolean =>
	x.child === y.child && x.test === y.test && x.attempt === y.attempt

const samePayload = (x: Request, y: Request): boolean => x.note === y.note && x.slot === y.slot

/** Requests by their key, as the table's state is read. */
const byKey: Order.Order<Request> = Order.combine(
	Order.mapInput(Order.Number, (r: Request) => r.child),
	Order.combine(
		Order.mapInput(Order.Number, (r: Request) => r.test),
		Order.mapInput(Order.Number, (r: Request) => r.attempt)
	)
)

const requestGen: Gen<Request> = (source) => ({
	child: source.draw(int(1, 2)),
	test: 7,
	attempt: source.draw(int(1, 2)),
	note: source.draw(int(0, 1)),
	slot: source.draw(int(1, 3))
})

/** One to `most` requests of distinct keys and distinct slots: a call no host check refuses on its own. */
const callGen =
	(least: number, most: number): Gen<ReadonlyArray<Request>> =>
	(source) => {
		const count = source.draw(int(least, most))
		let rows: ReadonlyArray<Request> = []
		for (let i = 0; i < count; i++) {
			const row = source.draw(requestGen)
			if (!Arr.some(rows, (r) => sameKey(r, row) || r.slot === row.slot)) {
				rows = Arr.append(rows, row)
			}
		}
		return rows
	}

const collisionGen: Gen<Collision> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	form: source.draw(element(["array", "query"] as const)),
	stored: source.draw(callGen(0, 2)),
	a: source.draw(callGen(1, 2)),
	b: source.draw(callGen(1, 2))
})

/** The law a refusal names, by the statement that states it. */
type KeyName = "sitting" | "slot"

/** What one call answers in the serial order, over the rows its statement sees and the rows it meets in flight. */
type Expected =
	| {
			readonly kind: "inserted"
			readonly rows: ReadonlyArray<Request>
			/** The requests that repeat a stored or a committed row exactly, each of which meets that row. */
			readonly met: ReadonlyArray<Request>
	  }
	| {
			readonly kind: "refused"
			readonly law: KeyName
			readonly witnesses: Arr.NonEmptyReadonlyArray<Witness>
			readonly path: "probe" | "unique" | "arbiter"
	  }

interface Judged {
	readonly expected: Expected
	/** Whether the call's statement waits for the rows in flight. */
	readonly waits: boolean
	readonly features: ReadonlyArray<CollisionFeature>
}

const keyWitnessOf = (r: Request): Witness => ({
	kind: "key",
	relation: "Sitting",
	values: { child: r.child, test: r.test, attempt: r.attempt }
})

const slotWitnessOf = (slot: number): Witness => ({
	kind: "key",
	relation: "Sitting",
	values: { slot }
})

const rowAt = (rows: ReadonlyArray<Request>, r: Request): Option.Option<Request> =>
	Arr.findFirst(rows, (s) => sameKey(s, r))

const holds = (rows: ReadonlyArray<Request>, r: Request): boolean =>
	Arr.some(rows, (s) => s.slot === r.slot)

/**
 * One call's answer as the serial order gives it, the call's rows stated in `form`, `visible` the rows its statement's
 * snapshot sees and `flight` the rows another call holds uncommitted, which commit before the call's statement ends: a
 * visible occupant at slot of a request whose arbiter key its snapshot sees free gates the statement, which then waits
 * on nothing; otherwise a request meets a row in flight at its arbiter key, or at slot with its key free everywhere,
 * and waits. After the wait, a 23505 at slot ends the statement, witnessed by the one slot an array states, the host
 * holding no query's rows (runtime/write/witness.ts uniqueJudgement); otherwise a differing row at the arbiter key
 * refuses the key.
 */
const judge = (
	form: Form,
	call: ReadonlyArray<Request>,
	visible: ReadonlyArray<Request>,
	flight: ReadonlyArray<Request>
): Judged => {
	const unseen = (r: Request) => Option.isNone(rowAt(visible, r))
	const free = (r: Request) => unseen(r) && Option.isNone(rowAt(flight, r))
	const inFlight = (r: Request) => Option.isSome(rowAt(flight, r))
	const gated = Arr.filter(call, (r) => unseen(r) && holds(visible, r))
	const waits =
		gated.length === 0 && Arr.some(call, (r) => unseen(r) && (inFlight(r) || holds(flight, r)))
	if (Arr.isReadonlyArrayNonEmpty(gated)) {
		return {
			expected: {
				kind: "refused",
				law: "slot",
				witnesses: Arr.map(gated, (r) => slotWitnessOf(r.slot)),
				path: "probe"
			},
			waits,
			features: ["a visible occupant at slot, refused by the probe"]
		}
	}
	if (Arr.some(call, (r) => free(r) && holds(flight, r))) {
		const slots = Arr.dedupe(Arr.map(call, (r) => r.slot))
		const [only, ...others] = slots
		const stated = form === "array" && others.length === 0
		return {
			expected: {
				kind: "refused",
				law: "slot",
				witnesses: [stated ? slotWitnessOf(only) : { kind: "unreported" }],
				path: "unique"
			},
			waits,
			features: [
				form === "query"
					? "a 23505 at slot after waiting, unreported for a query's rows"
					: stated
						? "a 23505 at slot after waiting, its stated slot the witness"
						: "a 23505 at slot after waiting, unreported among several slots"
			]
		}
	}
	const conflicts = Arr.filter(call, (r) =>
		Option.match(
			Option.orElse(rowAt(visible, r), () => rowAt(flight, r)),
			{
				onNone: () => false,
				onSome: (occupant) => !samePayload(occupant, r)
			}
		)
	)
	if (Arr.isReadonlyArrayNonEmpty(conflicts)) {
		return {
			expected: {
				kind: "refused",
				law: "sitting",
				witnesses: Arr.map(conflicts, keyWitnessOf),
				path: "arbiter"
			},
			waits,
			features: [
				inFlight(Arr.headNonEmpty(conflicts))
					? "a differing row at the arbiter key in flight, refused after waiting"
					: "a differing row at a visible arbiter key"
			]
		}
	}
	const inserted = Arr.filter(call, free)
	const met = Arr.filter(call, (r) => !free(r))
	return {
		expected: { kind: "inserted", rows: inserted, met },
		waits,
		features: [
			...Arr.flatMap(met, (r: Request): ReadonlyArray<CollisionFeature> =>
				inFlight(r)
					? [
							"an exact repeat of a row in flight, after waiting",
							...(form === "query" ? (["a row in flight met, read back"] as const) : [])
						]
					: [
							"an exact repeat of a visible row",
							...(form === "query" ? (["a visible row met, read back"] as const) : [])
						]
			),
			...(inserted.length === 0
				? []
				: [
						waits
							? ("an insert after waiting for a row in flight" as const)
							: ("an insert without waiting" as const)
					])
		]
	}
}

/** One learner's start of the sitting (child 1, test 7, attempt 1), its id the database's uuidv7(). */
const startOf = (note: number): Request => ({ child: 1, test: 7, attempt: 1, note, slot: 1 })

/**
 * A double Start, pinned: two calls of `learner` start one sitting at (child, test, attempt) through the query member,
 * as edullm's Start does, each leaving its id to the database's uuidv7(). Concurrent, the later waits at the arbiter
 * for the earlier and is no change where it states the same sitting, reading the earlier's row back as met, or refused
 * on the key where it states another; in order, the later meets the committed sitting and reads it back.
 */
const doubleStarts: ReadonlyArray<Kept<Collision, CollisionFeature>> = [
	{
		note: "a double Start of one sitting: the later waits for the earlier's in-flight row and is no change, never a 40001",
		sketch: { mode: "concurrent", form: "query", stored: [], a: [startOf(0)], b: [startOf(0)] },
		draws: "",
		reaches: ["an exact repeat of a row in flight, after waiting", "a row in flight met, read back"]
	},
	{
		note: "a double Start that states another sitting at the same key: the later waits and is refused on the key",
		sketch: { mode: "concurrent", form: "query", stored: [], a: [startOf(0)], b: [startOf(1)] },
		draws: "",
		reaches: ["a differing row at the arbiter key in flight, refused after waiting"]
	},
	{
		note: "a double Start in order: the later meets the committed sitting and is no change",
		sketch: { mode: "sequential", form: "query", stored: [], a: [startOf(0)], b: [startOf(0)] },
		draws: "",
		reaches: ["an exact repeat of a visible row", "a visible row met, read back"]
	}
]

/** A sitting as a call reads it back: every field, its id the database's. */
interface SittingRow {
	readonly id: string
	readonly child: number
	readonly test: number
	readonly attempt: number
	readonly note: number
	readonly slot: number
}

/** What a call reads back: the sittings it added and the stored sittings it met. */
interface SittingReads {
	readonly added: ReadonlyArray<SittingRow>
	readonly met: ReadonlyArray<SittingRow>
}

/** What a call answered: its outcome, with the sittings a query member's call read back and none for an array's, or
 * the failure it met. */
type Ran = Result.Result<WriteAnswer<WriteOutcome<Option.Option<SittingReads>>>, CallError>

/** A call's answer with what it read back as `reads` makes it of the member's own read-backs. */
const readingAs =
	<R>(reads: (own: R) => Option.Option<SittingReads>) =>
	(
		answer: WriteAnswer<WriteOutcome<R>>
	): WriteAnswer<WriteOutcome<Option.Option<SittingReads>>> => {
		switch (answer.kind) {
			case "accepted":
				return { kind: "accepted", counts: answer.counts, reads: reads(answer.reads) }
			case "unchanged":
				return { kind: "unchanged", reads: reads(answer.reads) }
			case "refused":
			case "outsideWorld":
				return answer
		}
	}

/** A sitting as a plain record, in key order among others: a read-back's row and a state row alike. */
const plainSittings = (rows: ReadonlyArray<SittingRow>): ReadonlyArray<SittingRow> =>
	Arr.sort(
		Arr.map(rows, (r) => ({
			id: r.id,
			child: r.child,
			test: r.test,
			attempt: r.attempt,
			note: r.note,
			slot: r.slot
		})),
		byKey
	)

/** A row of the table's state, its stated fields then its id as text, as a sitting. */
const storedSitting = (row: ReadonlyArray<string>): SittingRow => ({
	child: Number(row[0]),
	test: Number(row[1]),
	attempt: Number(row[2]),
	note: Number(row[3]),
	slot: Number(row[4]),
	id: defined(row[5], "a stored sitting's id")
})

/** A relation's added count in an accepted outcome, none where it adds none. */
const addedTo = (outcome: WriteAnswer<WriteOutcome<unknown>>, relation: string): bigint =>
	outcome.kind === "accepted"
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(outcome.counts, (c) => c.relation === relation),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

const textOf = (value: unknown): string =>
	typeof value === "string" ? value : Formatter.format(value)

layer(Substrate.layer)("colliding generated additions of a certified READ COMMITTED role", (it) => {
	it.effect("answer as the serial order does", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const rig = yield* openRig(collisions)
				const names = namesOf(rig.installed)
				const S = rig.worlds.schema
				const lawOf = lawsByStatement(S)
				const laws: { readonly [K in KeyName]: Law } = {
					sitting: defined(lawOf(sittingKey)[0], "the sitting key's law"),
					slot: defined(lawOf(slotKey)[0], "the slot key's law")
				}
				const sittings = names.table(Sitting)
				const gate = names.table(Gate)
				const column = (field: "id" | "child" | "test" | "attempt" | "note" | "slot") =>
					names.column(Sitting, field)
				const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
					openServed(rig.served.roles.learner, {}).pipe(Effect.provideContext(context))
				const a = yield* rig.servedWriter("a", open, (db) =>
					answered(db.workload.start.once({ params: {}, facts: { insert: { Sitting: [] } } }))
				)
				const b = yield* rig.servedWriter("b", open, (db) =>
					answered(db.workload.start.once({ params: {}, facts: { insert: { Sitting: [] } } }))
				)
				assert.equal(a.ctx.isolation, "readCommitted", "generate certifies learner READ COMMITTED")
				assert.equal(b.ctx.isolation, "readCommitted", "generate certifies learner READ COMMITTED")
				const { holder } = yield* openActors(s, {
					holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
				})
				const holderPid = holder.pid

				const stateQuery = `SELECT ${Arr.join(
					Arr.map(statedFields, (f) => `${column(f)}::text`),
					", "
				)}, ${column("id")}::text, pg_catalog.uuid_extract_version(${column("id")})::text FROM ${sittings} ORDER BY 1, 2, 3`
				const state = Effect.map(s.admin.queryValues(stateQuery, []), (rows) =>
					Arr.map(rows, (row) => Arr.map(row, textOf))
				)

				/**
				 * Where a call's answer departs from its expectation, why; none where it is the expected one. An answer that
				 * inserts reads back as added exactly the stored rows at the keys it inserted at, and as met exactly the stored
				 * rows at the keys it repeats, each whole, its drawn id the stored row's (`final`, the table's last state, every
				 * stored row of which is fixed once committed).
				 */
				const departure = (
					ran: Ran,
					expected: Expected,
					label: string,
					final: ReadonlyArray<ReadonlyArray<string>>
				): string | undefined => {
					if (expected.kind === "inserted") {
						if (
							!(
								Result.isSuccess(ran) &&
								ran.success.kind !== "refused" &&
								ran.success.kind !== "outsideWorld" &&
								(expected.rows.length === 0
									? ran.success.kind === "unchanged" || addedTo(ran.success, "Sitting") === 0n
									: addedTo(ran.success, "Sitting") === BigInt(expected.rows.length))
							)
						) {
							return `${label} adds every free request, ${expected.rows.length}: ${Formatter.format(ran)}`
						}
						const at = (requests: ReadonlyArray<Request>) =>
							plainSittings(
								Arr.filter(Arr.map(final, storedSitting), (s) =>
									Arr.some(requests, (r) => sameKey(r, s))
								)
							)
						const reads = ran.success.reads
						if (Option.isNone(reads)) {
							return undefined
						}
						const added = plainSittings(reads.value.added)
						const met = plainSittings(reads.value.met)
						return deepEquals(added, at(expected.rows)) && deepEquals(met, at(expected.met))
							? undefined
							: `${label} reads back as added the rows it made, ${Formatter.format(at(expected.rows))}, and as met the stored rows it repeats, ${Formatter.format(at(expected.met))}: added ${Formatter.format(added)}, met ${Formatter.format(met)}`
					}
					if (Result.isFailure(ran) || ran.success.kind !== "refused") {
						return `${label} is a typed refusal of ${expected.law}, never an abort or a defect: ${Formatter.format(ran)}`
					}
					const outcome = ran.success
					const [refused, ...more] = outcome.refused.laws
					if (more.length > 0 || !sameLaw(refused.law, laws[expected.law])) {
						return `${label} refuses ${expected.law} alone: ${Formatter.format(outcome.refused)}`
					}
					return Arr.some(expected.witnesses, (w) => deepEquals(outcome.witness, w))
						? undefined
						: `${label}'s witness ${Formatter.format(outcome.witness)} is one of ${Formatter.format(expected.witnesses)} (${expected.path})`
				}

				/**
				 * Whether a call's backend `waiter` waited for `holder` before the call ended, polled from the admin session
				 * until its fiber ends or pg_locks shows it blocked by `holder`: a wait that never comes ends the poll with
				 * the call, so it fails the case where it happens, never by the hang guard.
				 */
				const waitedOrEnded = (fiber: Fiber.Fiber<Ran>, waiter: number, holder: number) =>
					Effect.gen(function* () {
						for (;;) {
							if (fiber.pollUnsafe() !== undefined) {
								return "ended" as const
							}
							const wait = yield* lockWaitOf(s.admin, waiter)
							if (wait?.blockedBy.includes(holder) === true) {
								return "waited" as const
							}
							yield* Effect.yieldNow
						}
					})

				const rowsOf = (rows: ReadonlyArray<Request>) => Arr.map(rows, (r) => ({ ...r }))
				const unread = readingAs((): Option.Option<SittingReads> => Option.none())
				const read = readingAs((reads: SittingReads) => Option.some(reads))
				const held = (form: Form, rows: ReadonlyArray<Request>): Effect.Effect<Ran> =>
					Effect.result(
						form === "array"
							? Effect.map(
									answered(
										a.db.workload.held.once({
											params: {},
											facts: { insert: { Sitting: rowsOf(rows), Gate: [{ n: 0 }] } }
										})
									),
									unread
								)
							: Effect.map(
									answered(
										a.db.workload.heldRead.once({
											params: { sittings: rowsOf(rows) },
											facts: { insert: { Gate: [{ n: 0 }] } }
										})
									),
									read
								)
					)
				const start = (form: Form, rows: ReadonlyArray<Request>): Effect.Effect<Ran> =>
					Effect.result(
						form === "array"
							? Effect.map(
									answered(
										b.db.workload.start.once({
											params: {},
											facts: { insert: { Sitting: rowsOf(rows) } }
										})
									),
									unread
								)
							: Effect.map(
									answered(
										b.db.workload.startRead.once({
											params: { sittings: rowsOf(rows) },
											facts: {}
										})
									),
									read
								)
					)

				return yield* explore(
					{
						suite: "schedules/write/collisions",
						draw: drawn(collisionGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the serial order A, then B, over the stated rows: repeat, key refusal, slot refusal or insert"
						},
						coverage: required<CollisionFeature>(
							[
								"an exact repeat of a row in flight, after waiting",
								"a differing row at the arbiter key in flight, refused after waiting",
								"a 23505 at slot after waiting, its stated slot the witness",
								"a 23505 at slot after waiting, unreported among several slots",
								"a 23505 at slot after waiting, unreported for a query's rows",
								"an exact repeat of a visible row",
								"a row in flight met, read back",
								"a visible row met, read back",
								"a differing row at a visible arbiter key",
								"a visible occupant at slot, refused by the probe",
								"an insert after waiting for a row in flight",
								"an insert without waiting"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: doubleStarts,
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							yield* rig.replace(
								c.stored.length === 0
									? []
									: [
											`INSERT INTO ${sittings} (${Arr.join(
												Arr.map(statedFields, column),
												", "
											)}) VALUES ${Arr.join(
												Arr.map(
													c.stored,
													(r) => `(${r.child}, ${r.test}, ${r.attempt}, ${r.note}, ${r.slot})`
												),
												", "
											)}`
										]
							)
							const before = yield* state
							const first = judge(c.form, c.a, c.stored, [])
							/** The sittings A's call makes, as the model has it. */
							const madeByA = first.expected.kind === "inserted" ? first.expected.rows : []
							const afterA = [...c.stored, ...madeByA]
							const together = c.mode === "concurrent" && first.expected.kind === "inserted"
							if (together) {
								yield* holder.perform({ _tag: "Begin" })
								yield* holder.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
							}
							const fiberA = yield* Effect.forkChild(held(c.form, c.a), { startImmediately: true })
							/** In `concurrent`, A reaches Gate holding its sittings, or ends before it, which departs. */
							const atGate = together
								? yield* waitedOrEnded(fiberA, a.actor.pid, holderPid)
								: "ended"
							const ranA = atGate === "ended" ? yield* Fiber.join(fiberA) : undefined
							const holding = together && atGate === "waited"
							const second = holding
								? judge(c.form, c.b, c.stored, madeByA)
								: judge(c.form, c.b, afterA, [])
							const fiberB = yield* Effect.forkChild(start(c.form, c.b), { startImmediately: true })
							const observed = holding
								? yield* waitedOrEnded(fiberB, b.actor.pid, a.actor.pid)
								: "ended"
							if (together) {
								yield* holder.perform({ _tag: "Commit" })
							}
							const ranHeld = ranA ?? (yield* Fiber.join(fiberA))
							const ranB = yield* Fiber.join(fiberB)
							const final = yield* state
							const departures = Arr.filter(
								[
									together && !holding
										? "A ended before its Gate insert, where the model has it write its sittings and wait at Gate"
										: undefined,
									departure(ranHeld, first.expected, "A", final),
									departure(ranB, second.expected, "B", final),
									holding && (observed === "waited") !== second.waits
										? `B ${second.waits ? "ended without waiting for A, where it meets a row A holds" : "waited for A, where it meets none of A's rows"}`
										: undefined
								],
								(d) => d !== undefined
							)
							assert.deepEqual(departures, [], "each call answers as the serial order does")
							k.noteAll(first.features)
							k.noteAll(second.features)
							const after = afterA.concat(
								second.expected.kind === "inserted" ? second.expected.rows : []
							)
							assert.deepEqual(
								Arr.map(final, (row) => Arr.take(row, 5)),
								Arr.map(Arr.sort(after, byKey), (r) =>
									Arr.map([r.child, r.test, r.attempt, r.note, r.slot], String)
								),
								"the table holds what the serial order leaves"
							)
							assert.ok(
								Arr.every(final, (row) => row[6] === "7"),
								"every id is a version 7 uuid"
							)
							for (const row of before) {
								assert.ok(
									Arr.some(final, (f) => deepEquals(f, row)),
									`stored row ${Formatter.format(row)} keeps its id`
								)
							}
						})
				)
			})
		)
	)
})

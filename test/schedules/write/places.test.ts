/**
 * Two writers stamp one group's place, and the group's places run gapless from its head in the order their calls
 * commit, two calls at one place meeting as a SERIALIZABLE refusal, never as a duplicate place or a key's refusal.
 *
 * Session(child, item, n, stage) is keyed (child, item, n), its `n` a place by `stage` (ir/instant.ts PlaceHead) whose
 * group is (child, item), beside the key (child, item, stage) the place demands. Gate(n) is the relation a held call
 * inserts last. The role `writer` inserts both, and its workload is `stamp`, an insertion of Session's rows, and
 * `held`, an insertion of Session's rows and then, in a later stratum, of a Gate row. Each call states its rows as an
 * array of `{ child, item, stage }`, which leaves `n` out, so every row is stamped with its group's next place,
 * `coalesce(h + 1, 0)`, h the greatest place the group holds (write/insert/stamp.ts). The schema and its logins are
 * installed and served as `grizzle generate` drafts them (schedules/rig.ts openRig): `writer` runs at the level
 * generate certifies, which the stamps make SERIALIZABLE (write/schedule/plan.ts formedAt).
 *
 * A case's stored state gives each of the items 1 and 2 of child 1 none, one or two places before the calls. Two
 * writers A and B, two Dbs of `writer` over DbLayers of their own, run one call each, A `held` and B `stamp`, each
 * stating one row at each item it names, at a stage of its own, each retried after a TransientFailure until it
 * answers. In `concurrent`, the schema's owner holds Gate in SHARE mode while A runs: A's rows are stamped and
 * uncommitted when its Gate insert waits on that lock, and B runs then. Where both stamp one item, B stamps the place A
 * holds uncommitted and waits for A at the key; the owner's COMMIT lets A commit first, and B's statement fails with
 * 40001 at the row it could not see, its retry stamping the place after A's. Otherwise B commits while A waits. In
 * `sequential`, A's call commits before B's begins.
 *
 * Properties, per case:
 * - each call is accepted, adding each of its rows, never refused at the key, and B waits for A exactly where they
 *   stamp one item concurrently;
 * - at each item, the places the calls added are the group's head and those after it, one per call that stamps the
 *   item, in the order the calls commit: A then B.
 *
 * Oracle: the rule, stated over the case's stored heads and the commit order its moves give. Kills, each by hand, each
 * must turn it red: the place's stamp 0, its head unread, so a group over a head is stamped at a place it holds and the
 * insert is refused at the key; and a stamping insert formed at READ COMMITTED, where two concurrent calls at one place
 * meet as a unique violation, a refusal at the key, not as a retryable one.
 *
 * Features: each stored head, an item both calls stamp, concurrently and in turn, B waiting for A, B retried after A
 * committed, and two items in one call.
 */

import { aimed, explore } from "@bjornpagen/testing/explore"
import { type Reached, required } from "@bjornpagen/testing/features"
import { constant, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, place } from "#compiler/public/fields.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { type WriteAnswer, answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Session = relation(
	"Session",
	{ child: pg.integer, item: pg.integer, n: place({ by: "stage" }), stage: pg.integer },
	["child", "item", "n"]
)
/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
const Gate = relation("Gate", { n: pg.integer }, ["n"])

/** The schema, the role `writer`, which inserts Session and Gate and nothing else, and its two logins. */
const places = (name: string) => {
	const base = schema(name, [Session, Gate], [key(on(Session, "child", "item", "stage"))])
	const writer = role(base, "writer", { Session, Gate }, { insert: ["Session", "Gate"] })
	const direct = role(base, "direct", { Session, Gate })
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base).insert(Session, []),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Session, []),
						ChangeSet.empty(base).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** How many places an item holds before the calls, at stages 100 on. */
type Head = 0 | 1 | 2

/** The items a call stamps, one row at each, at a stage of its own. */
type Items = readonly [1] | readonly [2] | readonly [1, 2]

type Mode = "concurrent" | "sequential"

interface Placing {
	readonly mode: Mode
	readonly heads: { readonly 1: Head; readonly 2: Head }
	readonly a: Items
	readonly b: Items
}

type PlaceFeature =
	| "an item over no place"
	| "an item over one place"
	| "an item over two places"
	| "an item both calls stamp, concurrently"
	| "an item both calls stamp, in turn"
	| "B waited for A at a key"
	| "B retried after A committed"
	| "two items in one call"

const itemsGen: Gen<Items> = element([[1], [2], [1, 2]] as const)

const placingGen: Gen<Placing> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	heads: {
		1: source.draw(element([0, 1, 2] as const)),
		2: source.draw(element([0, 1, 2] as const))
	},
	a: source.draw(itemsGen),
	b: source.draw(itemsGen)
})

/** A case constructed to reach B waiting for A at a key and its retry: both stamping item 1, concurrently. */
const aims: ReadonlyArray<readonly [Reached<PlaceFeature>, Gen<Placing>]> = [
	[
		"B waited for A at a key",
		constant<Placing>({ mode: "concurrent", heads: { 1: 1, 2: 0 }, a: [1], b: [1] })
	]
]

/** Whether A and B stamp one item, which in `concurrent` B waits for A at. */
const meets = (c: Placing): boolean => Arr.some(c.a, (item) => Arr.contains(c.b, item))

/** The stage a call's row at `item` states: A's 10 + item, B's 20 + item, a stored row's 100 on. */
const stageOf = (call: "A" | "B", item: 1 | 2): number => (call === "A" ? 10 : 20) + item

/** A stored row, read back: its item, its place and its stage. */
interface Stored {
	readonly item: number
	readonly n: number
	readonly stage: number
}

/** A call's answer once it is no TransientFailure, and how many times it ran. */
interface Answered {
	readonly tries: number
	readonly ran: Result.Result<WriteAnswer<WriteOutcome<unknown>>, CallError>
}

/** `call` run until it ends other than in a TransientFailure, each run counted. */
const untilAnswered = (call: Effect.Effect<WriteAnswer<WriteOutcome<unknown>>, CallError>) =>
	Effect.gen(function* () {
		for (let tries = 1; ; tries++) {
			const ran = yield* Effect.result(call)
			if (Result.isSuccess(ran) || ran.failure.kind !== "transient") {
				return { tries, ran } satisfies Answered
			}
		}
	})

const addedTo = (outcome: WriteAnswer<WriteOutcome<unknown>>): bigint =>
	outcome.kind === "accepted"
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(outcome.counts, (c) => c.relation === "Session"),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

/**
 * Where the places the calls added at `item` depart from the rule (see the header), why; none where they keep it.
 * `added` are the item's rows the calls added, by place, and `order` the calls in commit order with their items.
 */
const departureAt = (
	item: 1 | 2,
	head: Head,
	added: ReadonlyArray<Stored>,
	order: ReadonlyArray<readonly ["A" | "B", Items]>
): string | undefined => {
	const stamping = Arr.filter(order, ([, items]) => Arr.contains(items, item))
	const expected = Arr.map(stamping, ([call], k) => ({
		item,
		n: head + k,
		stage: stageOf(call, item)
	}))
	return deepEquals(added, expected)
		? undefined
		: `item ${item} holds its calls' places from its head, ${head}, in commit order, ${Formatter.format(expected)}: ${Formatter.format(added)}`
}

layer(Substrate.layer)("two writers stamping one place", (it) => {
	it.effect("stamp each group's places gapless in the order its calls commit", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const rig = yield* openRig(places)
				const names = namesOf(rig.installed)
				const table = names.table(Session)
				const gate = names.table(Gate)
				const column = (field: "child" | "item" | "n" | "stage") => names.column(Session, field)
				const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
					openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context))
				const a = yield* rig.servedWriter("a", open, (db) =>
					answered(db.workload.stamp.once({ params: {}, facts: { insert: { Session: [] } } }))
				)
				const b = yield* rig.servedWriter("b", open, (db) =>
					answered(db.workload.stamp.once({ params: {}, facts: { insert: { Session: [] } } }))
				)
				const { holder } = yield* openActors(s, {
					holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
				})
				const holderPid = holder.pid
				const state = Effect.map(
					s.admin.queryValues(
						`SELECT ${column("item")}::text, ${column("n")}::text, ${column("stage")}::text FROM ${table} ORDER BY 1, 2`,
						[]
					),
					(rows) =>
						Arr.map(rows, (row): Stored => ({
							item: Number(row[0]),
							n: Number(row[1]),
							stage: Number(row[2])
						}))
				)

				/**
				 * Whether a call's backend `waiter` waited for `holding` before the call ended, polled from the admin session
				 * until its fiber ends or pg_locks shows it blocked by `holding`.
				 */
				const waitedOrEnded = (
					fiber: Fiber.Fiber<Answered>,
					waiter: Effect.Effect<Option.Option<number>>,
					holding: Effect.Effect<Option.Option<number>>
				) =>
					Effect.gen(function* () {
						for (;;) {
							if (fiber.pollUnsafe() !== undefined) {
								return "ended" as const
							}
							const backends = Option.all([yield* waiter, yield* holding])
							if (Option.isSome(backends)) {
								const [waiting, held] = backends.value
								const wait = yield* lockWaitOf(s.admin, waiting)
								if (wait?.blockedBy.includes(held) === true) {
									return "waited" as const
								}
							}
							yield* Effect.yieldNow
						}
					})

				const rowsOf = (call: "A" | "B", items: Items) =>
					Arr.map(items, (item) => ({ child: 1, item, stage: stageOf(call, item) }))
				const held = (items: Items) =>
					a.db.workload.held
						.once({
							params: {},
							facts: { insert: { Session: rowsOf("A", items), Gate: [{ n: 0 }] } }
						})
						.pipe(answered, untilAnswered)
				const stamp = (items: Items) =>
					b.db.workload.stamp
						.once({ params: {}, facts: { insert: { Session: rowsOf("B", items) } } })
						.pipe(answered, untilAnswered)

				return yield* explore(
					{
						suite: "schedules/write/places",
						draw: aimed(placingGen, aims),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a group's places run on from its head, one per call, in commit order, two calls at one place meeting as a retryable refusal"
						},
						coverage: required<PlaceFeature>(
							[
								"an item over no place",
								"an item over one place",
								"an item over two places",
								"an item both calls stamp, concurrently",
								"an item both calls stamp, in turn",
								"B waited for A at a key",
								"B retried after A committed",
								"two items in one call"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const seeded = Arr.flatMap([1, 2] as const, (item) =>
								Array.from({ length: c.heads[item] }, (_, n) => `(1, ${item}, ${n}, ${100 + n})`)
							)
							yield* rig.replace(
								seeded.length === 0
									? []
									: [
											`INSERT INTO ${table} (${column("child")}, ${column("item")}, ${column("n")}, ${column("stage")}) VALUES ${Arr.join(seeded, ", ")}`
										]
							)
							const together = c.mode === "concurrent"
							if (together) {
								yield* holder.perform({ _tag: "Begin" })
								yield* holder.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
							}
							const fiberA = yield* Effect.forkChild(held(c.a), { startImmediately: true })
							const atGate = together
								? yield* waitedOrEnded(fiberA, a.actor.backend, Effect.succeedSome(holderPid))
								: "ended"
							const ranA = atGate === "ended" ? yield* Fiber.join(fiberA) : undefined
							const holding = together && atGate === "waited"
							const fiberB = yield* Effect.forkChild(stamp(c.b), { startImmediately: true })
							const observed = holding
								? yield* waitedOrEnded(fiberB, b.actor.backend, a.actor.backend)
								: "ended"
							if (together) {
								yield* holder.perform({ _tag: "Commit" })
							}
							const answeredA = ranA ?? (yield* Fiber.join(fiberA))
							const answeredB = yield* Fiber.join(fiberB)
							const final = yield* state
							const order: ReadonlyArray<readonly ["A" | "B", Items]> =
								holding && observed === "ended"
									? [
											["B", c.b],
											["A", c.a]
										]
									: [
											["A", c.a],
											["B", c.b]
										]
							const accepted = (name: string, items: Items, x: Answered) =>
								Result.isSuccess(x.ran) && addedTo(x.ran.success) === BigInt(items.length)
									? undefined
									: `${name} is accepted, adding its ${items.length} rows, never refused at the key: ${Formatter.format(x.ran)}`
							const added = (item: 1 | 2) =>
								Arr.sort(
									Arr.filter(final, (r) => r.item === item && r.stage < 100),
									Order.mapInput(Order.Number, (r: Stored) => r.n)
								)
							const departures = Arr.filter(
								[
									together && !holding
										? "A ended before its Gate insert, where it stamps its rows and waits at Gate"
										: undefined,
									accepted("A", c.a, answeredA),
									accepted("B", c.b, answeredB),
									holding && (observed === "waited") !== meets(c)
										? `B ${meets(c) ? "ended without waiting for A, where they stamp one item" : "waited for A, where they stamp no item alike"}`
										: undefined,
									...Arr.map([1, 2] as const, (item) =>
										departureAt(item, c.heads[item], added(item), order)
									)
								],
								(d) => d !== undefined
							)
							assert.deepEqual(
								departures,
								[],
								"each group's places run on from its head in commit order"
							)
							for (const item of [1, 2] as const) {
								const stamping = Arr.filter([c.a, c.b], (items) => Arr.contains(items, item))
								if (stamping.length === 0) {
									continue
								}
								k.note(
									c.heads[item] === 0
										? "an item over no place"
										: c.heads[item] === 1
											? "an item over one place"
											: "an item over two places"
								)
								if (stamping.length === 2) {
									k.note(
										together
											? "an item both calls stamp, concurrently"
											: "an item both calls stamp, in turn"
									)
								}
							}
							if (holding && observed === "waited") {
								k.note("B waited for A at a key")
							}
							if (answeredB.tries > 1 && holding && observed === "waited") {
								k.note("B retried after A committed")
							}
							for (const items of [c.a, c.b]) {
								if (items.length === 2) {
									k.note("two items in one call")
								}
							}
						})
				)
			})
		)
	)
})

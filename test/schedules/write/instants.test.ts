/**
 * Two writers stamp one clock at its children, and each child's instants increase in the order its calls commit.
 *
 * Log(child, at, note) is keyed (child, at, note): its `at` is an instant no containment carries, so it is a clock
 * whose child is `child`, the key's field before it (ir/instant.ts). Gate(n) is the relation a held call inserts last.
 * The role `writer` inserts both, and its workload is `stamp`, an insertion of Log's rows, and `held`, an insertion of
 * Log's rows and then, in a later stratum, of a Gate row. Each call states its rows as an array of `{ child, note }`,
 * which leaves `at` out, so every row is stamped with the call's instant at its child, `greatest(c, h + 1)`, c the
 * call's reading of the database's clock in microseconds and h the latest instant the child holds
 * (write/insert/stamp.ts). The schema and its logins are installed and served as `grizzle generate` drafts them
 * (schedules/rig.ts openRig): `writer` runs at the level generate certifies, which the stamps make SERIALIZABLE
 * (write/schedule/plan.ts formedAt), read off each writer's served Db.
 *
 * A case's stored state gives each of the children 1 and 2 no row, a row at instant 1, below every reading of the
 * clock, or a row at instant F, a microsecond in 2100, above every reading: a clock that stepped back, simulated by the
 * head the test writes as the schema's owner, never by the server's clock. Two writers A and B, two Dbs of `writer`
 * over DbLayers of their own, run one call each, A `held` and B `stamp`, each retried after a TransientFailure until it
 * answers. In `concurrent`, the schema's owner holds Gate in SHARE mode while A runs: A's rows are stamped and
 * uncommitted when its Gate insert waits on that lock, and B runs then. B waits for A where they meet at a key, both
 * stamping F + 1 at a child over F and stating one note there; then the owner's COMMIT lets A commit first, and B's
 * statement fails with 40001 at the row it cannot see, its retry stamping after it. Otherwise B commits while A waits,
 * and A, which read the child's head that B wrote into, and wrote into the head B read, is failed by SSI with 40001
 * where they share a child, its retry stamping after B. In `sequential`, A's call commits before B's begins.
 *
 * Properties, per case:
 * - each call is accepted, adding each of its rows, and B waits for A exactly where they meet at a key;
 * - at each child, the rows the calls added hold one instant per call that stamps the child, its every row there at
 *   it, and the instants increase in the order the calls commit: A then B, unless B committed while A waited;
 * - each instant is above the head the child held before the call; at a child over F, the k-th call to commit stamps
 *   F + k, and at any other, the first stamps at least the clock's reading before the calls began.
 *
 * Oracle: the rule, stated over the case's stored heads and the commit order its moves give. Kills: the stamp the raw
 * clock, its head unread, which stamps a child over F below F and two concurrent calls in the order they began; and a
 * stamp's insert formed at READ COMMITTED, where the two calls read the child's head without seeing each other, so
 * they commit in the other order or share an instant.
 *
 * Features: each stored head, a child both calls stamp, concurrently and in turn, B waiting for A, A retried, a call's
 * two rows at one child, and two children in one call.
 */

import { aimed, explore } from "@bjornpagen/testing/explore"
import { type Reached, required } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, pg } from "#compiler/public/fields.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { type WriteAnswer, answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Log = relation("Log", { child: pg.integer, at: instant, note: pg.integer }, [
	"child",
	"at",
	"note"
])
/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
const Gate = relation("Gate", { n: pg.integer }, ["n"])

/** The schema, the role `writer`, which inserts Log and Gate and nothing else, and its two logins. */
const clocks = (name: string) => {
	const base = schema(name, [Log, Gate], [])
	const writer = role(base, "writer", { Log, Gate }, { insert: ["Log", "Gate"] })
	const direct = role(base, "direct", { Log, Gate })
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					stamp: ChangeSet.empty(base).insert(Log, []),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Log, []),
						ChangeSet.empty(base).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** A microsecond in 2100, above every reading of the clock a run takes: a stored head a stepped-back clock is below. */
const future = 4_102_444_800_000_000n

/** The head a child holds before the calls: none, one at instant 1, or one at `future`, each of note 9. */
type Head = "none" | "past" | "future"

const headAt = (head: Exclude<Head, "none">): bigint => (head === "past" ? 1n : future)

/** One row a call states: its child and its note, its instant left out to be stamped. */
interface Row {
	readonly child: 1 | 2
	readonly note: 0 | 1
}

type Mode = "concurrent" | "sequential"

interface Stamping {
	readonly mode: Mode
	readonly heads: { readonly 1: Head; readonly 2: Head }
	readonly a: ReadonlyArray<Row>
	readonly b: ReadonlyArray<Row>
}

type StampFeature =
	| "a child over no head"
	| "a child over a past head"
	| "a child over a future head: the clock stepped back"
	| "a child both calls stamp, concurrently"
	| "a child both calls stamp, in turn"
	| "B waited for A at a key"
	| "A retried after B committed"
	| "two rows of one child in one call"
	| "two children in one call"

const sameRow = (x: Row, y: Row): boolean => x.child === y.child && x.note === y.note

/** One to three distinct rows. */
const rowsGen: Gen<ReadonlyArray<Row>> = (source) => {
	const count = source.draw(int(1, 3))
	const rows: Array<Row> = []
	for (let i = 0; i < count; i++) {
		const row: Row = {
			child: source.draw(element([1, 2] as const)),
			note: source.draw(element([0, 1] as const))
		}
		if (!Arr.some(rows, (r) => sameRow(r, row))) {
			rows.push(row)
		}
	}
	return rows
}

const stampingGen: Gen<Stamping> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	heads: {
		1: source.draw(element(["none", "past", "future"] as const)),
		2: source.draw(element(["none", "past", "future"] as const))
	},
	a: source.draw(rowsGen),
	b: source.draw(rowsGen)
})

/**
 * Cases constructed to reach the situations a draw rarely meets: B waiting for A at a key, both stamping F + 1 at a
 * child over F with one note, and A retried after B committed, the two stamping one child over no head at two notes.
 */
const aims: ReadonlyArray<readonly [Reached<StampFeature>, Gen<Stamping>]> = [
	[
		"B waited for A at a key",
		constant<Stamping>({
			mode: "concurrent",
			heads: { 1: "future", 2: "none" },
			a: [{ child: 1, note: 0 }],
			b: [{ child: 1, note: 0 }]
		})
	],
	[
		"A retried after B committed",
		constant<Stamping>({
			mode: "concurrent",
			heads: { 1: "none", 2: "none" },
			a: [{ child: 1, note: 0 }],
			b: [{ child: 1, note: 1 }]
		})
	]
]

const childrenOf = (rows: ReadonlyArray<Row>): ReadonlyArray<1 | 2> =>
	Arr.dedupe(Arr.map(rows, (r) => r.child))

/** Whether B meets A at a key, so waits for it in `concurrent`: both stamp F + 1 at a child over F, with one note. */
const meets = (c: Stamping): boolean =>
	Arr.some(c.a, (r) => c.heads[r.child] === "future" && Arr.some(c.b, (s) => sameRow(r, s)))

/** A stored row, read back: its child, its instant and its note. */
interface Stored {
	readonly child: number
	readonly at: bigint
	readonly note: number
}

const byStored: Order.Order<Stored> = Order.combine(
	Order.mapInput(Order.Number, (s: Stored) => s.child),
	Order.combine(
		Order.mapInput(Order.BigInt, (s: Stored) => s.at),
		Order.mapInput(Order.Number, (s: Stored) => s.note)
	)
)

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
					Arr.findFirst(outcome.counts, (c) => c.relation === "Log"),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

/**
 * Where the rows the calls added at `child` depart from the rule (see the header), why; none where they keep it.
 * `added` are the child's rows the calls added, `order` the calls in commit order with their rows, `before` the
 * clock's reading before the calls began.
 */
const departureAt = (
	child: 1 | 2,
	head: Head,
	added: ReadonlyArray<Stored>,
	order: ReadonlyArray<readonly [string, ReadonlyArray<Row>]>,
	before: bigint
): string | undefined => {
	const stamping = Arr.filter(order, ([, rows]) => Arr.some(rows, (r) => r.child === child))
	const instants = Arr.dedupe(Arr.map(added, (s) => s.at))
	if (instants.length !== stamping.length) {
		return `child ${child} holds one instant per call that stamps it, ${stamping.length}: ${Formatter.format(added)}`
	}
	for (const [k, [name, rows]] of stamping.entries()) {
		const at = instants[k]
		if (at === undefined) {
			return `child ${child} holds an instant for ${name}`
		}
		const notes = Arr.map(
			Arr.filter(added, (s) => s.at === at),
			(s) => s.note
		)
		const stated = Arr.sort(
			Arr.map(
				Arr.filter(rows, (r) => r.child === child),
				(r) => r.note
			),
			Order.Number
		)
		if (!deepEquals(notes, stated)) {
			return `${name}, the ${k + 1}th call to commit at child ${child}, holds its rows there, notes ${Formatter.format(stated)}, at its instant ${at}, its every row at it: ${Formatter.format(added)}`
		}
		const expected =
			head === "future"
				? future + BigInt(k + 1)
				: k === 0
					? undefined
					: (instants[k - 1] ?? 0n) + 1n
		if (expected !== undefined && head === "future" && at !== expected) {
			return `${name} stamps F + ${k + 1} at child ${child}, over a head the clock is below: ${at}`
		}
		if (k === 0 && head !== "future" && at < before) {
			return `${name} stamps child ${child} at least at the clock's reading before the calls, ${before}: ${at}`
		}
		if (head === "past" && at <= 1n) {
			return `${name} stamps child ${child} above its head, 1: ${at}`
		}
	}
	return undefined
}

layer(Substrate.layer)("two writers stamping one clock", (it) => {
	it.effect("stamp each child's instants in the order its calls commit", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const rig = yield* openRig(clocks)
				const names = namesOf(rig.installed)
				const log = names.table(Log)
				const gate = names.table(Gate)
				const column = (field: "child" | "at" | "note") => names.column(Log, field)
				const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
					openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context))
				const a = yield* rig.servedWriter("a", open, (db) =>
					answered(db.workload.stamp.once({ params: {}, facts: { insert: { Log: [] } } }))
				)
				const b = yield* rig.servedWriter("b", open, (db) =>
					answered(db.workload.stamp.once({ params: {}, facts: { insert: { Log: [] } } }))
				)
				const { holder } = yield* openActors(s, {
					holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
				})
				const holderPid = holder.pid
				const state = Effect.map(
					s.admin.queryValues(
						`SELECT ${column("child")}::text, ${column("at")}::text, ${column("note")}::text FROM ${log} ORDER BY 1, 2, 3`,
						[]
					),
					(rows) =>
						Arr.map(rows, (row): Stored => ({
							child: Number(row[0]),
							at: BigInt(String(row[1])),
							note: Number(row[2])
						}))
				)
				const clockReading = Effect.map(
					s.admin.queryValues(
						"SELECT (pg_catalog.extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000)::bigint::text",
						[]
					),
					(rows) => BigInt(String(rows[0]?.[0]))
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

				const rowsOf = (rows: ReadonlyArray<Row>) => Arr.map(rows, (r) => ({ ...r }))
				const held = (rows: ReadonlyArray<Row>) =>
					a.db.workload.held
						.once({ params: {}, facts: { insert: { Log: rowsOf(rows), Gate: [{ n: 0 }] } } })
						.pipe(answered, untilAnswered)
				const stamp = (rows: ReadonlyArray<Row>) =>
					b.db.workload.stamp
						.once({ params: {}, facts: { insert: { Log: rowsOf(rows) } } })
						.pipe(answered, untilAnswered)

				return yield* explore(
					{
						suite: "schedules/write/instants",
						draw: aimed(stampingGen, aims),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a child's instants increase in commit order, one per call, above its head, F + k over a future head"
						},
						coverage: required<StampFeature>(
							[
								"a child over no head",
								"a child over a past head",
								"a child over a future head: the clock stepped back",
								"a child both calls stamp, concurrently",
								"a child both calls stamp, in turn",
								"B waited for A at a key",
								"A retried after B committed",
								"two rows of one child in one call",
								"two children in one call"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const seeded = Arr.flatMap([1, 2] as const, (child) => {
								const head = c.heads[child]
								return head === "none" ? [] : [`(${child}, ${headAt(head)}, 9)`]
							})
							yield* rig.replace(
								seeded.length === 0
									? []
									: [
											`INSERT INTO ${log} (${column("child")}, ${column("at")}, ${column("note")}) VALUES ${Arr.join(seeded, ", ")}`
										]
							)
							const before = yield* clockReading
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
							const order: ReadonlyArray<readonly [string, ReadonlyArray<Row>]> =
								holding && observed === "ended"
									? [
											["B", c.b],
											["A", c.a]
										]
									: [
											["A", c.a],
											["B", c.b]
										]
							const accepted = (name: string, rows: ReadonlyArray<Row>, x: Answered) =>
								Result.isSuccess(x.ran) && addedTo(x.ran.success) === BigInt(rows.length)
									? undefined
									: `${name} is accepted, adding its ${rows.length} rows: ${Formatter.format(x.ran)}`
							const added = (child: 1 | 2) =>
								Arr.sort(
									Arr.filter(final, (r) => r.child === child && r.note !== 9),
									byStored
								)
							const departures = Arr.filter(
								[
									together && !holding
										? "A ended before its Gate insert, where it stamps its rows and waits at Gate"
										: undefined,
									accepted("A", c.a, answeredA),
									accepted("B", c.b, answeredB),
									holding && (observed === "waited") !== meets(c)
										? `B ${meets(c) ? "ended without waiting for A, where they meet at a key" : "waited for A, where they meet at no key"}`
										: undefined,
									...Arr.map([1, 2] as const, (child) =>
										departureAt(child, c.heads[child], added(child), order, before)
									)
								],
								(d) => d !== undefined
							)
							assert.deepEqual(
								departures,
								[],
								"each child's instants are its calls' in commit order"
							)
							for (const child of [1, 2] as const) {
								const stamping = Arr.filter([c.a, c.b], (rows) =>
									Arr.some(rows, (r) => r.child === child)
								)
								if (stamping.length === 0) {
									continue
								}
								k.note(
									c.heads[child] === "none"
										? "a child over no head"
										: c.heads[child] === "past"
											? "a child over a past head"
											: "a child over a future head: the clock stepped back"
								)
								if (stamping.length === 2) {
									k.note(
										together
											? "a child both calls stamp, concurrently"
											: "a child both calls stamp, in turn"
									)
								}
							}
							if (holding && observed === "waited") {
								k.note("B waited for A at a key")
							}
							if (answeredA.tries > 1 && holding && observed === "ended") {
								k.note("A retried after B committed")
							}
							for (const rows of [c.a, c.b]) {
								if (childrenOf(rows).length === 2) {
									k.note("two children in one call")
								}
								if (childrenOf(rows).length < rows.length) {
									k.note("two rows of one child in one call")
								}
							}
						})
				)
			})
		)
	)
})

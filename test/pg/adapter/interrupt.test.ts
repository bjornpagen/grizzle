/**
 * Interrupted public calls: what an interruption leaves behind, at every point of a call's round trip (README "No
 * server-side timeouts": interrupting the Effect is the only cancellation).
 *
 * A case is a call on the worked example's Work, opened as its full role through its login's served file: a write (the
 * apply of a change member that inserts, deletes and puts task notes, each member valid against the state it starts
 * from) or a read (taskCards' member), and a point in its round trip: the tap's gate holds the server's bytes once a
 * number of backend messages (ReadyForQuery messages, or any) have reached the client, drawn against the call's own
 * traffic, which one run of the call on a session of its own measures first: inside the call's messages, at its last
 * one, or past its end, where the call completes before the gate. Optionally an owner session holds a row lock first,
 * so a statement the call sends, or its COMMIT, waits on the server until the call is interrupted. The case waits on
 * what it observes, never on the clock.
 *
 * The oracle is the README's cancellation contract, restated per case:
 * - the exit is the interruption when the call had not completed when it came, and otherwise the call's success;
 * - the call sent a CancelRequest exactly when interrupted before its last statement answered;
 * - the task notes are exactly as before the call, or exactly as the accepted write leaves them, never in between;
 * - the pool has no session leased, and the next call succeeds.
 *
 * Features: how the call ended against the gate, where it was interrupted (a lock wait among them), and what the
 * interruption left (committed, rolled back).
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): interrupt-no-cancel.patch (an interrupted flight sends no
 * CancelRequest), interrupt-lease-leaked.patch (an interrupted call's retired session never counted out of the pool's
 * leases).
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	weighted,
	type Weight
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Option, Order } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Uuid } from "#compiler/public/fields.ts"
import { defaultPool, poolFor, rowsOn, until } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { answered, oneOf, readOnce, writeOnce } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { pickFrom, pickGen, pickIndex } from "#test/support/pick.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { type BackendMessage, makeTap } from "#test/support/wire-tap.ts"

/**
 * One member of a drawn write: a note for a task with none, the deletion of a note, or another text at a note's task.
 */
type Member = { readonly kind: "insert" | "delete" | "put"; readonly pick: number }

/**
 * Where the gate holds among the call's own backend messages of its type: before one inside them, before the last one
 * (a write's COMMIT has run on the server by then), or past the end, where the call completes before the gate.
 */
type Arm = "inside" | "end" | "beyond"

interface GatePoint {
	readonly type: "Z" | "any"
	readonly arm: Arm
	readonly pick: number
}

interface CaseSketch {
	readonly call: "write" | "read"
	readonly members: ReadonlyArray<Member>
	/**
	 * What the owner session locks first: nothing, a note the write deletes or puts, or the task a new note references,
	 * whose deferred reference COMMIT checks.
	 */
	readonly blocker: "none" | "statement" | "commit"
	readonly point: GatePoint
}

const pointGen =
	(weights: { readonly [A in Arm]: Weight }): Gen<GatePoint> =>
	(source) => ({
		type: source.draw(element(["Z", "any"] as const)),
		arm: source.draw(
			weighted<Arm>([
				[weights.inside, constant("inside")],
				[weights.end, constant("end")],
				[weights.beyond, constant("beyond")]
			])
		),
		pick: source.draw(pickGen)
	})

const membersGen = array<Member>(
	(source) => ({
		kind: source.draw(element(["insert", "delete", "put"] as const)),
		pick: source.draw(pickGen)
	}),
	{ min: 1, max: 3 }
)
const blockerGen = element(["none", "statement", "commit"] as const)

/**
 * A write three times in four, its gate inside or at the end three times in five; a read once in four, its gate inside
 * or at the end four times in five. In 38 cases (a run's floor and rotating streams) that expects about 7.6 interrupted
 * reads, 22 interrupted writes, 6.2 writes completed before the gate (a write without a lock, the gate past its end),
 * and 13 lock waits: a lock on 46% of writes (a delete or put under a statement lock, an insert under a COMMIT lock),
 * every one interrupted where the server waits on it.
 */
const caseSketchGen: Gen<CaseSketch> = weighted<CaseSketch>([
	[
		3,
		(source) => ({
			call: "write",
			members: source.draw(membersGen),
			blocker: source.draw(blockerGen),
			point: source.draw(pointGen({ inside: 2, end: 1, beyond: 2 }))
		})
	],
	[
		1,
		(source) => ({
			call: "read",
			members: source.draw(membersGen),
			blocker: source.draw(blockerGen),
			point: source.draw(pointGen({ inside: 3, end: 1, beyond: 1 }))
		})
	]
])

/**
 * Planted: a write completing before a gate past its end; a write deleting a note a lock holds, interrupted where it
 * waits; a write held before its last ReadyForQuery, its COMMIT run, which commits; a read held at once.
 */
const point = (type: GatePoint["type"], arm: Arm): GatePoint => ({ type, arm, pick: 0 })
const interruptKept: ReadonlyArray<Kept<CaseSketch, InterruptFeature>> = [
	{
		note: "a write past the gate",
		sketch: {
			call: "write",
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("Z", "beyond")
		},
		draws: "",
		reaches: ["write completed before the gate"]
	},
	{
		note: "a deletion waiting on a lock",
		sketch: {
			call: "write",
			members: [{ kind: "delete", pick: 0 }],
			blocker: "statement",
			point: point("Z", "beyond")
		},
		draws: "",
		reaches: [
			"interrupted where the server waits on a lock",
			"write interrupted",
			"rolled back after an interruption"
		]
	},
	{
		note: "a write held before its last answer",
		sketch: {
			call: "write",
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("Z", "end")
		},
		draws: "",
		reaches: ["committed after an interruption"]
	},
	{
		note: "a read held at once",
		sketch: {
			call: "read",
			members: [{ kind: "insert", pick: 0 }],
			blocker: "none",
			point: point("any", "inside")
		},
		draws: "",
		reaches: ["read interrupted"]
	}
]

/**
 * The number of the call's backend messages of the gate's type after which the gate holds, drawn against `traffic`, the
 * call's own messages: before one of them, before the last, or past the end, so the call has every answer first. A call
 * that sends nothing (a write whose members all resolve away) has no message to hold before: its gate holds at once, or
 * past the end.
 */
const gateCount = (gate: GatePoint, traffic: ReadonlyArray<BackendMessage>): number => {
	const n = gate.type === "Z" ? Arr.filter(traffic, (m) => m.type === "Z").length : traffic.length
	switch (gate.arm) {
		case "inside":
			return n <= 1 ? 0 : pickIndex(gate.pick, n - 1)
		case "end":
			return Math.max(n - 1, 0)
		case "beyond":
			return n + 1 + pickIndex(gate.pick, n + 1)
	}
}

interface Note {
	readonly task: Uuid
	readonly note: string
}

const tasks: ReadonlyArray<Uuid> = Arr.map(workFacts.Task, (task) => task.id)

const byTask: Order.Order<Note> = Order.mapInput(Order.String, (n: Note) => n.task)

/**
 * A write's members against the notes it starts from, each key once: what it inserts, deletes and puts, and the notes
 * it leaves when accepted.
 */
const resolveWrite = (
	members: ReadonlyArray<Member>,
	notes: ReadonlyArray<Note>,
	serial: number
) => {
	const inserts: Array<Note> = []
	const deletes: Array<Note> = []
	const puts: Array<Note> = []
	const touched = new Set<string>()
	for (const [i, member] of members.entries()) {
		const noted = new Set(Arr.map(notes, (n) => n.task))
		if (member.kind === "insert") {
			const [first, ...rest] = Arr.filter(tasks, (task) => !noted.has(task) && !touched.has(task))
			if (first === undefined) {
				continue
			}
			const task = pickFrom([first, ...rest], member.pick)
			touched.add(task)
			inserts.push({ task, note: `note ${serial}.${i}` })
			continue
		}
		const [first, ...rest] = Arr.filter(notes, (n) => !touched.has(n.task))
		if (first === undefined) {
			continue
		}
		const target = pickFrom([first, ...rest], member.pick)
		touched.add(target.task)
		if (member.kind === "delete") {
			deletes.push(target)
		} else {
			puts.push({ task: target.task, note: `note ${serial}.${i}` })
		}
	}
	const after = Arr.sort(
		[
			...Arr.map(
				Arr.filter(notes, (n) => !Arr.some(deletes, (d) => d.task === n.task)),
				(n) =>
					Option.getOrElse(
						Arr.findFirst(puts, (p) => p.task === n.task),
						() => n
					)
			),
			...inserts
		],
		byTask
	)
	return { inserts, deletes, puts, after }
}

/** What a case reached: how its call ended against the gate, where it was interrupted, and what the interruption left. */
type InterruptFeature =
	| `${CaseSketch["call"]} interrupted`
	| `${CaseSketch["call"]} completed before the gate`
	| "interrupted where the server waits on a lock"
	| "committed after an interruption"
	| "rolled back after an interruption"

const situations: Arr.NonEmptyReadonlyArray<InterruptFeature> = [
	"write interrupted",
	"read interrupted",
	"write completed before the gate",
	"interrupted where the server waits on a lock",
	"committed after an interruption",
	"rolled back after an interruption"
]

/**
 * The sketch a witness runs, aimed at what no witness reached yet (Case.steering): while no write has completed before
 * its gate, half its cases by a draw of their own are a write under no lock whose gate is past its end, its members and
 * gate type as drawn; a rotating or kept case runs as drawn.
 */
const aimedSketch = (sketch: CaseSketch, cx: Case<InterruptFeature>): CaseSketch =>
	Option.exists(cx.steering, (pending) => pending.has("write completed before the gate")) &&
	cx.draw(boolean)
		? { ...sketch, call: "write", blocker: "none", point: { ...sketch.point, arm: "beyond" } }
		: sketch

/** A change member of array members, applied on `ctx` with the call's facts. */
const applyFacts = (ctx: ServedDbContext, change: LoadedMember, facts: unknown) => {
	assertVariant(change, "kind", "change", "the write's member is a change")
	assert.equal(
		variantOf(ctx, change.variants).call.kind,
		"facts",
		"the write's member takes its call's facts"
	)
	return answered(writeOnce(memberCalls(ctx, change))({ params: {}, facts }))
}

/** The search: the Work installed once, a Db opened on it whose context and members every case's tapped pools reuse,
 * and the cases. */
const interruptCases = Effect.gen(function* () {
	const s = yield* Substrate
	const o = yield* installed(W.Work, workFacts, { label: "real", programs: {} })
	const names = namesOf(o.installed)
	const notes = names.table(W.TaskNote)
	const noteTask = names.column(W.TaskNote, "task")
	const noteText = names.column(W.TaskNote, "note")
	/** The login the call's backend logs in as, which pg_stat_activity names it by. */
	const writerRole = o.installed.as(o.server).role
	const reads = W.workReads(o.schema)
	let serial = 0
	const { context, members } = yield* Effect.scoped(
		withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
			Effect.map(
				load({
					write: ChangeSet.empty(o.schema)
						.insert(W.TaskNote, [])
						.delete(W.TaskNote, [])
						.put(W.TaskNote, []),
					cards: reads.taskCards,
					task: W.Task
				}),
				(loaded) => ({ context: ctx, members: loaded })
			)
		)
	)
	/** A member's calls over `pool`. */
	const on = (pool: SessionPool, name: string) =>
		memberCalls({ ...context, pool }, member(members, name))
	const notesNow = Effect.map(
		s.admin.queryValues(
			`SELECT ${noteTask}::text, ${noteText} FROM ${notes} ORDER BY ${noteTask}`,
			[]
		),
		(rows) =>
			Arr.map(rows, ([task, note]): Note => ({
				task: succeeded(Uuid.parse(task), "a stored note's task"),
				note: String(note)
			}))
	)
	return yield* explore(
		{
			oracle: {
				kind: "specification",
				name: "README: an interrupted call cancels exactly before its last answer and leaves the state before or after"
			},
			suite: `pg/adapter/interrupt`,
			draw: drawn(caseSketchGen),
			literal: Formatter.format,
			coverage: required<InterruptFeature>(situations, { cases: 30, sense: notesOnly }),
			kept: interruptKept,
			runs: 30,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		(drawnSketch, cx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const sketch = aimedSketch(drawnSketch, cx)
					serial++
					const before = yield* notesNow
					const write = resolveWrite(sketch.members, before, serial)
					/**
					 * Every call starts from the state written whole, the work facts with these notes
					 * (substrate/replace.ts): a write over the dead versions an earlier write left would be an SSI pivot
					 * under load, and fail with 40001.
					 */
					const restore = replace(o.installed, {
						...workFacts,
						TaskNote: Arr.map(before, (n) => ({ task: n.task, note: n.note }))
					})
					yield* restore
					/**
					 * The call through the members of the full role over `pool`; an uncaught failure of an uninterrupted
					 * one is a defect the exit check reports.
					 */
					const callOn = (pool: SessionPool) =>
						sketch.call === "write"
							? Effect.orDie(
									Effect.asVoid(
										applyFacts({ ...context, pool }, member(members, "write"), {
											insert: { TaskNote: write.inserts },
											delete: { TaskNote: write.deletes },
											put: { TaskNote: write.puts }
										})
									)
								)
							: Effect.orDie(
									Effect.asVoid(readOnce(on(pool, "cards"))({ params: { account: a1 }, facts: {} }))
								)
					/** A tapped pool of one fresh session, warmed, so a window holds one call's traffic alone. */
					const tappedDb = Effect.gen(function* () {
						const tap = makeTap(s.cluster)
						const pool = yield* poolFor(o.installed.as(o.server), {
							...defaultPool,
							transport: { kind: "given", transport: tap.transport },
							pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
						})
						yield* Effect.scoped(
							Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
						)
						return { tap, pool }
					})
					/**
					 * The call's own backend messages, from one uninterrupted run on a session of its own; a write's
					 * notes are put back after it, so the gated call starts from the same state.
					 */
					const traffic = yield* Effect.scoped(
						Effect.gen(function* () {
							const measuring = yield* tappedDb
							const mark = measuring.tap.mark()
							yield* callOn(measuring.pool)
							return measuring.tap.since(mark).backend
						})
					)
					if (sketch.call === "write") {
						yield* restore
					}
					const { tap, pool } = yield* tappedDb
					const call = callOn(pool)
					/**
					 * The owner's lock: on a note the write deletes or puts, or on the task of a note it inserts.
					 */
					const lockedNote = [...write.deletes, ...write.puts][0]
					const lockedTask = write.inserts[0]?.task
					const lock =
						sketch.call === "read"
							? undefined
							: sketch.blocker === "statement" && lockedNote !== undefined
								? `SELECT 1 FROM ${notes} WHERE ${noteTask} = '${lockedNote.task}'::uuid FOR UPDATE`
								: sketch.blocker === "commit" && lockedTask !== undefined
									? `SELECT 1 FROM ${names.table(W.Task)} WHERE ${names.column(W.Task, "id")} = '${lockedTask}'::uuid FOR UPDATE`
									: undefined
					const locker =
						lock === undefined
							? undefined
							: yield* s.session({ ...ownerSession(), label: "locker" })
					if (locker !== undefined && lock !== undefined) {
						yield* locker.begin
						yield* locker.query(lock, [])
					}
					/**
					 * The ReadyForQuery that answers the call's last statement, counted among the call's own: a read's
					 * and a write's last both come before COMMIT's, behind BEGIN's and the prologue's. A write that
					 * sends nothing has none.
					 */
					const answersOf = (type: string) => Arr.filter(traffic, (m) => m.type === type).length
					const lastAnswered = answersOf("Z") - 1
					const callMark = tap.mark()
					yield* tap.gate.settled
					/** The answers before the call, every one of which has reached the driver (Gate.settled). */
					const answeredBefore = tap.gate.delivered("Z")
					const answered = (): number => tap.gate.delivered("Z") - answeredBefore
					tap.gate.hold(
						gateCount(sketch.point, traffic),
						sketch.point.type === "Z" ? { kind: "type", type: "Z" } : { kind: "any" }
					)
					const fiber = yield* Effect.forkChild(call)
					/** Whether the call's backend waits on a lock, which only the owner's can be. */
					const waitingOnLock = Effect.map(
						s.admin.queryValues(
							"SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename = $1::name AND wait_event_type = 'Lock'::text",
							[writerRole]
						),
						(rows) => rows.length > 0
					)
					/**
					 * The call cannot complete while the lock is held, and the server reaches it. A
					 * statement's lock withholds the last statement's answer; COMMIT's comes after every
					 * statement answered, and those answers reach the call unless the gate holds them.
					 *
					 * The server runs on behind the gate until it has answered every query the call sent.
					 */
					const stopped = yield* locker === undefined
						? Effect.gen(function* () {
								const first = yield* Effect.raceFirst(
									Effect.as(tap.gate.holding, "held" as const),
									Effect.as(Fiber.await(fiber), "completed" as const)
								)
								if (first === "held") {
									yield* until(
										Effect.sync(() => tap.since(callMark).backend.length >= traffic.length)
									)
								}
								return first
							})
						: Effect.gen(function* () {
								yield* until(waitingOnLock)
								if (sketch.blocker === "commit") {
									yield* Effect.raceFirst(
										tap.gate.holding,
										until(Effect.sync(() => answered() >= lastAnswered))
									)
								}
								cx.note("interrupted where the server waits on a lock")
								return "waits" as const
							})
					/**
					 * An interruption before the last statement answered cancels the flight (batch.ts), and nothing
					 * can answer it meanwhile: the gate holds the answer, or the lock the statement.
					 */
					const cancels = stopped !== "completed" && answered() < lastAnswered
					if (stopped !== "completed") {
						/**
						 * The interruption reaches the call before anything else happens: the fork starts at once.
						 */
						const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), {
							startImmediately: true
						})
						if (cancels) {
							yield* until(Effect.sync(() => tap.cancelsEnded() > 0))
							if (locker !== undefined) {
								yield* until(Effect.map(waitingOnLock, (waiting) => !waiting))
							}
						}
						tap.gate.release()
						if (locker !== undefined) {
							yield* locker.rollback
						}
						yield* Fiber.join(interrupting)
					} else {
						tap.gate.release()
					}
					const exit = yield* Fiber.await(fiber)
					assert.equal(
						tap.cancels() > 0,
						cancels,
						"the call cancels exactly when interrupted before its last statement answered"
					)
					/**
					 * A call whose last answer was the one the gate held at completes as it is interrupted; any other
					 * interrupted call ends with the interruption.
					 */
					const interrupted = Exit.hasInterrupts(exit)
					if (stopped === "completed") {
						assert.ok(!interrupted, "a call that completed first is not interrupted")
					}
					if (!interrupted) {
						assert.ok(Exit.isSuccess(exit), "an uninterrupted call succeeds")
					}
					const after = yield* notesNow
					/** Whether the write changes the notes when accepted, and whether they changed. */
					const effective =
						sketch.call === "write" && Option.isSome(exactValue(write.after, before))
					const changed = Option.isSome(exactValue(after, before))
					assert.ok(
						!changed || (effective && Option.isNone(exactValue(after, write.after))),
						`the notes are as before the call or as the accepted write leaves them\nbefore: ${Formatter.format(before)}\nwrite: ${Formatter.format(write)}\nafter: ${Formatter.format(after)}`
					)
					if (interrupted) {
						cx.note(`${sketch.call} interrupted`)
						if (effective) {
							cx.note(
								changed ? "committed after an interruption" : "rolled back after an interruption"
							)
						}
					} else {
						cx.note(`${sketch.call} completed before the gate`)
					}
					const leased = yield* pool.leased
					assert.equal(leased, 0, "the pool has no session leased")
					const probe = yield* oneOf(readOnce(on(pool, "task"))({ params: { id: t1 }, facts: {} }))
					assert.ok(Option.isSome(probe), "the next call succeeds")
				})
			)
	)
})

layer(Substrate.layer, { excludeTestServices: true })("interrupted public calls", (it) => {
	it.effect("leave the state before or after, and nothing running", (ctx) =>
		searched(ctx, interruptCases)
	)
})

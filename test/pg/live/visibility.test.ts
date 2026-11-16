/**
 * The live leader's visibility judgment (adapter/live/leader.ts, a round's first step): a decoded transaction is sent on
 * only once the snapshot the leader reads sees its commit, so a read begun after its key arrives sees its change. A
 * transaction the leader decodes has its COMMIT record flushed, which is before it leaves PostgreSQL's proc array
 * (xact.c RecordTransactionCommit, then ProcArrayEndTransaction), so the leader can read it while every new snapshot
 * still holds it running; a key sent then wakes a subscription whose re-read misses the change, and no later key wakes
 * it again (test/pg/live/exactness.test.ts hung on it under load).
 *
 * Each case draws a schedule of writer transactions, each one inserting a row of its own and committing, and the
 * moment a REPEATABLE READ observer takes its snapshot among their steps: before a writer began, while it runs, or after
 * it committed, in every order. The observer reads every writer's row at that moment, and once every writer committed
 * runs the leader's visibility judgment on the same transaction, so on the same snapshot, of every writer's
 * transaction id as pgoutput's Begin carries it (32 bits).
 *
 * Property: the judgment holds a writer's commit seen exactly where the observer's snapshot reads its row.
 *
 * The oracle is PostgreSQL's MVCC: the row a transaction wrote is read under a snapshot exactly where that snapshot
 * sees the transaction's commit.
 *
 * Features: a commit before the snapshot, a writer running across it below a later commit before it, a writer running
 * across it past every commit before it, a writer begun after it.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter } from "effect"
import { snapshotOf } from "#adapter/live/leader.ts"
import { indices } from "#compiler/core/array.ts"
import { servedLiveOf } from "#compiler/plan/common.ts"
import { placement } from "#compiler/plan/runtime.ts"
import type { ServedLive } from "#compiler/plan/serve.ts"
import { caseHang } from "#test/support/limits.ts"
import type { SqlError } from "#test/support/pg.ts"
import { qualified } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A step of a schedule: a writer begins, inserting its row, a writer commits, or the observer takes its snapshot. */
type Step =
	| { readonly kind: "begin"; readonly writer: number }
	| { readonly kind: "commit"; readonly writer: number }
	| { readonly kind: "snapshot" }

/** A schedule: how many writers, and every step of theirs and the observer's in the order they run. */
interface Schedule {
	readonly writers: number
	readonly steps: ReadonlyArray<Step>
}

type Feature =
	| "a commit before the snapshot"
	| "a writer running across the snapshot below a later commit before it"
	| "a writer running across the snapshot past every commit before it"
	| "a writer begun after the snapshot"

/** The judgment and the observer's snapshot disagree on a writer's commit: the report says where. */
class Misjudged extends Data.TaggedError("Misjudged")<{ readonly report: string }> {}

const maxWriters = 4

/**
 * A schedule, constructed: writers begin in their order, each commits after it began, and the observer's snapshot is
 * taken once, each step drawn from those that may run next.
 */
const scheduleGen: Gen<Schedule> = (source) => {
	const writers = source.draw(int(1, maxWriters))
	const steps: Array<Step> = []
	const running: Array<number> = []
	let begun = 0
	let snapped = false
	while (begun < writers || running.length > 0 || !snapped) {
		const next: ReadonlyArray<Step> = [
			...(begun < writers ? [{ kind: "begin", writer: begun } as const] : []),
			...Arr.map(running, (writer) => ({ kind: "commit", writer }) as const),
			...(snapped ? [] : [{ kind: "snapshot" } as const])
		]
		const [first, ...rest] = next
		if (first === undefined) {
			break
		}
		const step = source.draw(element([first, ...rest]))
		steps.push(step)
		switch (step.kind) {
			case "begin":
				running.push(step.writer)
				begun += 1
				break
			case "commit":
				running.splice(running.indexOf(step.writer), 1)
				break
			case "snapshot":
				snapped = true
				break
		}
	}
	return { writers, steps }
}

/** Where a writer's steps stand in a schedule, by their positions: its begin and its commit. */
interface Span {
	readonly begin: number
	readonly commit: number
}

/** Each writer's steps' positions in `schedule`, and the observer's snapshot's. */
const positionsOf = (
	schedule: Schedule
): { readonly writers: ReadonlyArray<Span>; readonly snapshot: number } => {
	const begins = new Map<number, number>()
	const commits = new Map<number, number>()
	const snapshot = { at: 0 }
	for (const [at, step] of schedule.steps.entries()) {
		switch (step.kind) {
			case "begin":
				begins.set(step.writer, at)
				break
			case "commit":
				commits.set(step.writer, at)
				break
			case "snapshot":
				snapshot.at = at
				break
		}
	}
	return {
		writers: Arr.map(indices(schedule.writers), (writer) => ({
			begin: begins.get(writer) ?? 0,
			commit: commits.get(writer) ?? 0
		})),
		snapshot: snapshot.at
	}
}

/** The schedule's situations (Feature), each writer's against the observer's snapshot. */
const featuresOf = (schedule: Schedule): ReadonlyArray<Feature> => {
	const { writers, snapshot } = positionsOf(schedule)
	return Arr.map(writers, (writer): Feature => {
		if (writer.commit < snapshot) {
			return "a commit before the snapshot"
		}
		if (writer.begin > snapshot) {
			return "a writer begun after the snapshot"
		}
		return Arr.some(writers, (other) => other.begin > writer.begin && other.commit < snapshot)
			? "a writer running across the snapshot below a later commit before it"
			: "a writer running across the snapshot past every commit before it"
	})
}

/** The served live source of an installation that holds one. */
type OpenSource = Extract<ServedLive, { readonly kind: "source" }>

/**
 * The leader's visibility judgment of `xids`, each a writer's 32-bit transaction id, on `observer`'s transaction, so on
 * its snapshot: the snapshot statement's answer read as the leader reads it (snapshotOf), and the writers it places
 * `seen` (placement).
 */
const judgedSeen = (
	observer: RawSession,
	served: OpenSource,
	xids: ReadonlyArray<number>
): Effect.Effect<ReadonlySet<number>, SqlError> =>
	Effect.flatMap(observer.values(served.snapshot.sql, []), (rows) => {
		const cell = rows[0]?.[0]
		if (typeof cell !== "string") {
			return Effect.die(`the snapshot statement answers one text, not ${Formatter.format(rows)}`)
		}
		const snapshot = snapshotOf([[cell]])
		return Effect.succeed(
			new Set(
				Arr.filter(
					indices(xids.length),
					(writer) => placement(snapshot, Arr.getUnsafe(xids, writer)) === "seen"
				)
			)
		)
	})

const cases = 40

layer(Substrate.layer)("the live leader's visibility judgment", (it) => {
	it.effect(
		`holds a commit seen exactly where a snapshot reads its row, over ${cases} generated schedules`,
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "postgresql",
							name: "the observer's REPEATABLE READ snapshot reading each writer's row"
						},
						suite: "pg/live/visibility",
						draw: drawn(scheduleGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a commit before the snapshot",
								"a writer running across the snapshot below a later commit before it",
								"a writer running across the snapshot past every commit before it",
								"a writer begun after the snapshot"
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [
							{
								note: "writer 1 runs across the snapshot past every commit before it, as a transaction whose COMMIT the leader decoded runs until it leaves the proc array: no snapshot sees it, and it stands at the snapshot's horizon, outside its running set",
								sketch: {
									writers: 2,
									steps: [
										{ kind: "begin", writer: 0 },
										{ kind: "begin", writer: 1 },
										{ kind: "commit", writer: 0 },
										{ kind: "snapshot" },
										{ kind: "commit", writer: 1 }
									]
								},
								draws: "",
								reaches: [
									"a commit before the snapshot",
									"a writer running across the snapshot past every commit before it"
								]
							}
						],
						runs: cases,
						shrink: { kind: "bounded", candidates: 60 },
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							notes.noteAll(featuresOf(c))
							const substrate = yield* Substrate
							const schema = yield* substrate.schema(freshSchema)
							const table = qualified(schema, "written")
							yield* substrate.admin.query(`CREATE TABLE ${table} (writer int4 NOT NULL)`, [])
							const served = servedLiveOf(schema, { kind: "source", tables: {}, views: [] })
							if (served.kind === "none") {
								return yield* Effect.die("a live source serves its texts")
							}
							const writers = yield* Effect.forEach(indices(c.writers), (writer) =>
								substrate.session({ ...ownerSession(), label: `writer ${writer}` })
							)
							const observer = yield* substrate.session({ ...ownerSession(), label: "observer" })
							yield* observer.beginBelow("repeatable read")
							const xids: Array<number> = Arr.map(indices(c.writers), () => 0)
							const read: { seen: ReadonlySet<number> } = { seen: new Set() }
							for (const step of c.steps) {
								switch (step.kind) {
									case "begin": {
										const writer = Arr.getUnsafe(writers, step.writer)
										yield* writer.begin
										yield* writer.query(`INSERT INTO ${table} (writer) VALUES ($1::int4)`, [
											String(step.writer)
										])
										const [row] = yield* writer.values(
											"SELECT pg_catalog.xid(pg_catalog.pg_current_xact_id())::pg_catalog.text",
											[]
										)
										xids[step.writer] = Number(row?.[0])
										break
									}
									case "commit":
										yield* Arr.getUnsafe(writers, step.writer).commit
										break
									case "snapshot": {
										const rows = yield* observer.values(
											`SELECT writer::pg_catalog.text FROM ${table}`,
											[]
										)
										read.seen = new Set(Arr.map(rows, ([writer]) => Number(writer)))
										break
									}
								}
							}
							const judged = yield* judgedSeen(observer, served, xids)
							yield* observer.commit
							const wrong = Arr.filter(
								indices(c.writers),
								(writer) => judged.has(writer) !== read.seen.has(writer)
							)
							if (wrong.length > 0) {
								return yield* new Misjudged({
									report: `${Arr.join(
										Arr.map(
											wrong,
											(writer) =>
												`writer ${writer} (xid ${xids[writer]}, ${Arr.getUnsafe(featuresOf(c), writer)}): judged ${judged.has(writer) ? "seen" : "unseen"}, its row ${read.seen.has(writer) ? "read" : "unread"} by the snapshot`
										),
										"\n"
									)}\n${Formatter.format(c)}`
								})
							}
						}).pipe(Effect.scoped)
				)
			)
	)
})

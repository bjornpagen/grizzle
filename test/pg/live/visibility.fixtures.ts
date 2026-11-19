/** What the properties of visibility.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Formatter } from "effect"
import { snapshotOf } from "#adapter/live/leader.ts"
import { indices } from "#compiler/core/array.ts"
import { placement } from "#compiler/plan/runtime.ts"
import type { ServedLive } from "#compiler/plan/serve.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

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

export type Feature =
	| "a commit before the snapshot"
	| "a writer running across the snapshot below a later commit before it"
	| "a writer running across the snapshot past every commit before it"
	| "a writer begun after the snapshot"

/** The judgment and the observer's snapshot disagree on a writer's commit: the report says where. */
export class Misjudged extends Data.TaggedError("Misjudged")<{ readonly report: string }> {}

const maxWriters = 4

/**
 * A schedule, constructed: writers begin in their order, each commits after it began, and the observer's snapshot is
 * taken once, each step drawn from those that may run next.
 */
export const scheduleGen: Gen<Schedule> = (source) => {
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
export const featuresOf = (schedule: Schedule): ReadonlyArray<Feature> => {
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
export const judgedSeen = (
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

export const cases = 40

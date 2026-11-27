/**
 * Presence's beacon against PostgreSQL 19 under real concurrency (README "A window a put extends"): one put of the
 * window from the earliest start to the latest end of the call's clock reading and every window of its child's stage
 * within 3 s of it (r.span), which displaces each window it overlaps at the span key (write/delete/exact.ts
 * collidingAtKey), at the level the learner's put runs at, SERIALIZABLE, its span key having no READ COMMITTED form yet
 * (write/schedule/plan.ts readCommittedLack). The shape: Presence(child, stage, during) keyed (child, stage, during
 * WITHOUT OVERLAPS), mutable in the unit Learner(child), and the role `learner`, whose one member is the beacon, served
 * clocked in microseconds.
 *
 * A race (presence.fixtures.ts PresenceRace) stores each of two children's windows around the race's instant, some
 * within 3 s of it, before it and after it, others further; begins two to four sessions in order, each reading its
 * clock, its call's reading; sends each call's statements in a drawn order, every earlier session holding its
 * transaction open, where a call at a child no open session before it beacons must finish without waiting on a lock;
 * and ends the sessions in a drawn order, each committing or rolling back as drawn.
 *
 * Oracle: specification, the windows a stretch of readings no more than 3 s apart makes (presence.fixtures.ts
 * stretchesOf): each child's windows are exactly the 3 s stretches of its stored windows and its committed calls'
 * readings, each reading the window [reading, reading + 1 µs), whatever order the calls committed in, so no reading is
 * lost, none lies outside a window and no two windows of a stage overlap; and every call succeeds or, at SERIALIZABLE,
 * is refused with 40001 and leaves nothing.
 *
 * Features: a reading that opened a window, one that extended a window, one that bridged two, calls at one child at
 * once, children apart at once, a call rolled back and a SERIALIZABLE call refused. At SERIALIZABLE a call at a child
 * whose window a call it overlaps wrote is refused with 40001, never put inside that window; READ COMMITTED, once a
 * span key's put has its form there under the unit's exclusive borrow, puts it inside.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aimedPresenceRaces,
	featuresOf,
	generatedShape,
	type PresenceFeature,
	problemsOf,
	runRace
} from "#test/pg/isolation/presence.fixtures.ts"
import { servedLevel } from "#test/pg/isolation/support/race.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Each child's windows are the 3 s stretches of its stored windows and its committed readings, whatever order its beacons commit in, and calls at different children never wait on each other. */
export const eachChildsWindowsAreTheStretchesOfItsStoredWindowsAndItsCommittedReadingsWhateverOrderItsBeaconsCommitInAndCallsAtDifferentChildrenNeverWaitOnEachOther =
	property.explore(steered(aimedPresenceRaces), {
		needs: { shape: Substrate.fresh(generatedShape) },
		situations: [
			"a reading that opened a window",
			"a reading that extended a window",
			"a reading that bridged two windows",
			"calls at one child at once",
			"children apart at once",
			"a call rolled back",
			"a SERIALIZABLE call refused"
		] satisfies ReadonlyArray<Reached<PresenceFeature>>,
		check:
			({ shape }, c: Case<PresenceFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const seat = yield* shape
					const level = servedLevel(seat.value, "learner")
					const run = yield* Effect.provideService(
						runRace(seat.value, race),
						Substrate,
						seat.substrate
					)
					for (const f of featuresOf(race, run, level)) {
						c.note(f)
					}
					const problems = [...run.problems, ...problemsOf(race, run, level)]
					if (problems.length > 0) {
						return yield* Effect.die(
							new Error(`${Formatter.format(race)}\n${Arr.join(problems, "\n")}`)
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: 'the 3 s stretches of each child\'s stored windows and committed readings (README "A window a put extends")'
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/isolation/presence.test.ts#eachChildsWindowsAreTheStretchesOfItsStoredWindowsAndItsCommittedReadingsWhateverOrderItsBeaconsCommitInAndCallsAtDifferentChildrenNeverWaitOnEachOther:7f.0:1.0.0"
				),
				reason:
					"two beacons at child 0 between its recent and ahead windows, the second begun putting first, beside one at child 1 with no window: the beacon's clock carrier is one statement of a set_config per carried column, all named set_config, which the raw session read by column name refused, so each put's fiber died, and the race read a dead fiber as a call that sent nothing and rolled back, no reading ever committing",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/put/choose.ts",
				original: '...(key.kind === "span" ? [key.span] : []),',
				replacement: "",
				why: "A span key's put compares its payload alone, so a pure set's put displaces nothing: a beacon's extended window meets the window it grows from at the key and is refused."
			},
			{
				file: "packages/engine/src/write/delete/exact.ts",
				original: '\t\t\t"&&",\n\t\t\tcol(storedAt',
				replacement: '\t\t\t"=",\n\t\t\tcol(storedAt',
				why: "The displacing deletion matches an occupant at an equal span alone, as format 7's did, so an extended window displaces nothing it grows from and is refused on the key."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\tprimaryKeyShape(action.info.relation).kind === "span"',
				replacement:
					'\tprimaryKeyShape(action.info.relation).kind === "span" && action.op === "insert"',
				why: "A put of a span key is read as having a READ COMMITTED form, so generate compiles the beacon at READ COMMITTED, whose insert half meets the span key's exclusion constraint, which arbitrates by ON CONFLICT DO NOTHING alone and so has no form there: an internal compiler error (write/insert/protocol.ts arbitrationOf), and the shape never installs."
			}
		],
		show: Formatter.format
	})

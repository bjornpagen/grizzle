/**
 * A child's stamps against PostgreSQL 19 (physical/ddl/stamps.ts, write/insert/stamp.ts): an insert that stamps a
 * clock or a place advances the child's head row in its stamping statement, so calls that append at one child take
 * turns, and calls at different children never wait on each other, at every level. The shape: a writer whose one member
 * appends a child's Event, stamped by its clock, and its Slot, stamped by its place, each child two fields, so two
 * children may share one.
 *
 * A race (stamps.fixtures.ts StampRace) begins two to four sessions in order, each reading its clock; sends each call's
 * statements in a drawn order, every earlier session holding its transaction open, where a call whose child an open
 * session before it stamped must wait on a lock and every other must finish without waiting on one; and ends the
 * sessions in a drawn order, each committing or rolling back as drawn, one still waiting taking its turn once the one
 * it waits on ended.
 *
 * Oracle: specification, the serial run of the committed calls in the order they committed (stamps.fixtures.ts
 * problemsOf), the certifier's claim of a READ COMMITTED stamp (analysis/isolation/certify.ts, README "Instants"):
 * each child's events and slots are exactly the committed calls' rows, each stamp the greater of its call's clock
 * reading and one past the stamp before it at the child, each place one past the place before it from 0, so no stamp
 * repeats, none is lost and every child's stamps rise in commit order. Every call succeeds at READ COMMITTED; at
 * SERIALIZABLE a call whose child a call before it stamped and committed is refused with 40001, never stamped out of
 * order, and every other succeeds. Generate certifies the writer READ COMMITTED.
 *
 * Features: a waiter whose holder committed, one whose holder rolled back, three calls at one child, children apart at
 * once, children sharing a field, a later-begun call stamped first, and a SERIALIZABLE call refused at an advanced head.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aimedStampRaces,
	featuresOf,
	problemsOf,
	readCommittedShape,
	runRace,
	serializableShape,
	type StampFeature
} from "#test/pg/isolation/stamps.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Calls that append at one child take turns and stamp as their serial run in commit order does, at READ COMMITTED with no refusal and at SERIALIZABLE refusing a call at a head it did not see, while calls at different children never wait on each other. */
export const callsThatAppendAtOneChildTakeTurnsAndStampAsTheirSerialRunInCommitOrderDoesWhileCallsAtDifferentChildrenNeverWaitOnEachOther =
	property.explore(steered(aimedStampRaces), {
		needs: {
			readCommitted: Substrate.freshOf(readCommittedShape),
			serializable: Substrate.freshOf(serializableShape)
		},
		situations: [
			"a waiter whose holder committed",
			"a waiter whose holder rolled back",
			"three calls at one child",
			"children apart at once",
			"children sharing a field",
			"a later-begun call stamped first",
			"a SERIALIZABLE call refused at an advanced head"
		] satisfies ReadonlyArray<Reached<StampFeature>>,
		check:
			({ readCommitted, serializable }, c: Case<StampFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const rcTaken = yield* readCommitted
					const serTaken = yield* serializable
					const certified = rcTaken.value.generated.get("writer")
					const rc = yield* Effect.provideService(
						runRace(rcTaken.value, race, "readCommitted"),
						Substrate,
						rcTaken.substrate
					)
					const ser = yield* Effect.provideService(
						runRace(serTaken.value, race, "serializable"),
						Substrate,
						serTaken.substrate
					)
					for (const f of [
						...featuresOf(race, rc, "readCommitted"),
						...featuresOf(race, ser, "serializable")
					]) {
						c.note(f)
					}
					const problems = [
						...(certified === "readCommitted"
							? []
							: [`generate certifies the writer ${certified ?? "at no level"}`]),
						...Arr.map(rc.problems, (p) => `READ COMMITTED ${p}`),
						...Arr.map(ser.problems, (p) => `SERIALIZABLE ${p}`),
						...(rc.problems.length === 0
							? Arr.map(problemsOf(race, rc, "readCommitted"), (p) => `READ COMMITTED ${p}`)
							: []),
						...(ser.problems.length === 0
							? Arr.map(problemsOf(race, ser, "serializable"), (p) => `SERIALIZABLE ${p}`)
							: [])
					]
					if (Arr.isReadonlyArrayNonEmpty(problems)) {
						return yield* Effect.die(
							new Error(`${Arr.join(problems, "\n")}\nin ${Formatter.format(race)}`)
						)
					}
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the serial run of the committed calls in commit order: each child's stamps rise from the first call's clock or 0, each the greater of its clock and one past the one before, no stamp lost or repeated; every call succeeds at READ COMMITTED, and at SERIALIZABLE a call after a committed stamp of its child is refused with 40001; a call at one child waits on an open one before it, and one at another child waits on none"
		},
		/**
		 * One case for each situation, the least that reaches them all: the floor's one case and a steered case for each
		 * of the six it leaves pending, an aimed race or a drawn one (stamps.fixtures.ts aimedStampRaces). At it each of
		 * the four kills is killed: `toolchain-test run` of the file under TEST_SEED=2219874524, 7 cases.
		 */
		budget: { runs: 1, steered: 6 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\tprimaryKeyShape(action.info.relation).kind === "span"',
				replacement:
					'\t(primaryKeyShape(action.info.relation).kind === "span" || headStamped(action.info.stamps).length > 0)',
				why: "An insert that stamps has no READ COMMITTED form again, as before the head rows: generate certifies the writer SERIALIZABLE by `form`, and the READ COMMITTED template does not compile."
			},
			{
				file: "packages/engine/src/program/isolation/member-facts.ts",
				original:
					"\t\tconst stamp = names.stamp(head.relation, head.field.name)\n\t\tnoTable.add([stamp.schema, stamp.name])\n",
				replacement: "\t\tnames.stamp(head.relation, head.field.name)\n",
				why: "The stamp functions read as functions that may read any table: generate certifies the writer SERIALIZABLE by `facts` and `pivot`."
			},
			{
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original:
					'\t\t\t\treturn { kind: "greatest", args: [{ kind: "excluded", column: at }, next] }',
				replacement:
					'\t\t\t\treturn { kind: "greatest", args: [{ kind: "excluded", column: at }, col(held, at)] }',
				why: "A clock's head advances to the greater of the call's clock and the head itself, not one past it: a later-begun call that stamps first leaves the next call at the head, which stamps the same instant again."
			},
			{
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original: '\t\t\tcase "place":\n\t\t\t\treturn next\n',
				replacement: '\t\t\tcase "place":\n\t\t\t\treturn col(held, at)\n',
				why: "A place's head stays where it is on every call after the first: the second committed call at a child takes place 0 again."
			}
		]
	})

/**
 * A scope's stamps against PostgreSQL 19 (physical/ddl/stamps.ts, write/insert/stamp.ts): an insert that stamps a clock
 * or a place advances its head's row at the row's key in its stamping statement, so calls that stamp one key take turns,
 * and calls at different keys never wait on each other, at every level. A clock's head is its scope's (ir/instant.ts
 * ClockScope): the unit its relation sits under, keyed by the unit's heading, every clock and child of the unit alike;
 * or its own child, where no unit holds it. The shape: the unit Kid over two clocks, Event and Mark, each of child
 * (kid, part), and Slot, whose place's group is (kid, part); and Tick, of child (child, part), under no unit. A writer's
 * members each append at the kid or child their parameters name: an Event with its Slot, a Mark with an Event, two
 * clocks of the unit in one call, or a Tick.
 *
 * The shape installs as `grizzle generate` drafts and serves it (race.ts shapeTemplate), and a race runs every session
 * at the level its served writes begin at, the one generate certifies the writer at. A race (stamps.fixtures.ts
 * StampRace) begins two to four sessions in order, each reading its clock; sends each call's
 * statements in a drawn order, every earlier session holding its transaction open, where a call whose head's key an
 * open session before it stamped must wait on a lock and every other must finish without waiting on one; and ends the
 * sessions in a drawn order, each committing or rolling back as drawn, one still waiting taking its turn once the one
 * it waits on ended.
 *
 * Oracle: specification, the serial run of the committed calls in the order they committed (stamps.fixtures.ts
 * problemsOf), the certifier's claim of a READ COMMITTED stamp (analysis/isolation/certify.ts, docs/reads-and-writes.md "Instants"):
 * every relation's rows are exactly the committed calls', each instant the greater of its call's clock reading and one
 * past the instant before it at its key, whichever clock and child of the key's scope stamped that one, one instant for
 * every row a call stamps there, each place one past the place before it from 0, so no instant repeats, none is lost and
 * a scope's instants rise in commit order across every clock and child it holds. Every call succeeds at READ COMMITTED;
 * at SERIALIZABLE a call whose key a call before it stamped and committed is refused with 40001, never stamped out of
 * order, and every other succeeds. Generate certifies the writer READ COMMITTED, so a race runs at READ COMMITTED.
 *
 * Features: a waiter whose holder committed, one whose holder rolled back, three calls at one key, keys apart at once,
 * two clocks of one unit at one key and in one call, two children of one unit's clock at one key, children of a clock
 * no unit holds sharing a field, and a later-begun call stamped first, and at another clock or child of its unit.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite, steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aimedStampRaces,
	type DirectCase,
	directGen,
	fateOf,
	featuresOf,
	generatedShape,
	problemsOf,
	runDirect,
	runRace,
	type StampFeature
} from "#test/pg/isolation/stamps.fixtures.ts"
import { servedLevel } from "#test/pg/isolation/support/race.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Calls that stamp one scope's key take turns and stamp as their serial run in commit order does, across every clock and child of the scope, at READ COMMITTED with no refusal and at SERIALIZABLE refusing a call at a head it did not see, while calls at different keys never wait on each other. */
export const callsThatStampOneScopesKeyTakeTurnsAndStampAsTheirSerialRunInCommitOrderDoesAcrossItsClocksWhileCallsAtDifferentKeysNeverWaitOnEachOther =
	property.explore(steered(aimedStampRaces), {
		needs: { shape: Substrate.fresh(generatedShape) },
		situations: [
			"a waiter whose holder committed",
			"a waiter whose holder rolled back",
			"three calls at one key",
			"keys apart at once",
			"two clocks of one unit at one key",
			"two clocks of one unit in one call",
			"two children of one unit's clock at one key",
			"children of a clock no unit holds sharing a field",
			"a later-begun call stamped first",
			"a later-begun call stamped first at another clock or child of its unit"
		] satisfies ReadonlyArray<Reached<StampFeature>>,
		check:
			({ shape }, c: Case<StampFeature>) =>
			(race) =>
				Effect.gen(function* () {
					const taken = yield* shape
					const level = servedLevel(taken.value, "writer")
					const run = yield* Effect.provideService(
						runRace(taken.value, race),
						Substrate,
						taken.substrate
					)
					for (const f of featuresOf(race, run, level)) {
						c.note(f)
					}
					const problems = [
						...(level === "readCommitted" ? [] : [`generate certifies the writer ${level}`]),
						...run.problems,
						...(run.problems.length === 0 ? problemsOf(race, run, level) : [])
					]
					if (Arr.isReadonlyArrayNonEmpty(problems)) {
						return yield* Effect.die(
							new Error(`${Arr.join(problems, "\n")}\nin ${Formatter.format(race)}`)
						)
					}
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the serial run of the committed calls in commit order: each scope key's instants rise from the first call's clock across every clock and child of the scope, each the greater of its clock and one past the one before, each group's places from 0, no stamp lost or repeated; every call succeeds at READ COMMITTED, and at SERIALIZABLE a call after a committed stamp of its key is refused with 40001; a call at one key waits on an open one before it, and one at another key waits on none"
		},
		/**
		 * What reaches every situation: the floor's one case and six steered ones, each an aimed race or a drawn
		 * one (stamps.fixtures.ts aimedStampRaces), the two aimed races reaching every situation between them. At it each
		 * of the five kills is killed: `toolchain-test kills` of the file under TEST_SEED=2219874524.
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
					"\t\tconst stamp = names.stamp(headNameOf(head))\n\t\tnoTable.add([stamp.schema, stamp.name])\n",
				replacement: "\t\tnames.stamp(headNameOf(head))\n",
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
			},
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\tconst member = units.get(r.name)\n",
				replacement: '\t\tconst member = units.get("")\n',
				why: "Every clock is stamped from its own child's head again, as before the unit-wide clock: an Event begun before a Mark of its kid that stamped first takes its own clock's reading, below the Mark's instant, though it commits after it, where the serial run in commit order stamps it one past the Mark."
			}
		]
	})

/**
 * The served Mark's probes of Kid's head in its transaction, one statement inserting a Mark and an Event at kid 0, as
 * PostgreSQL counts the index scans of the head the transaction began (pg_stat_xact_user_tables idx_scan): each
 * relation's stamp, an upsert of the head at the key, and each relation's guard, a probe of it there, 2 and 2, measured
 * at 4 under TEST_SEED=2219874524 with no sequential scan; 2 before the guards.
 */
const servedHeadProbes = 4n

/** The features a direct write reaches: its writer, what it states, and how the installation answers it. */
type DirectFeature =
	| "a role's insert refused by the guard"
	| "an owner's insert refused by the guard"
	| "an insert at its own stamp admitted"
	| "a role's move refused by its privileges"
	| "an owner's move refused by the guard"
	| "an owner's move to its own stamp admitted"

const directFeatureOf = (c: DirectCase): DirectFeature => {
	const fate = fateOf(c)
	if (fate.kind === "admitted") {
		return c.states === "a move to its own stamp"
			? "an owner's move to its own stamp admitted"
			: "an insert at its own stamp admitted"
	}
	if (fate.code === "42501") {
		return "a role's move refused by its privileges"
	}
	return fate.constraint === "__clock_moved"
		? "an owner's move refused by the guard"
		: c.writer === "role"
			? "a role's insert refused by the guard"
			: "an owner's insert refused by the guard"
}

/** No writer states a clock but at its transaction's stamp at the clock's scope's key, a role's session and the owner alike, inserting or moving a row, while a served write probes its scope's head by its key alone, never scanning it. */
export const noWriterStatesAClockButAtItsTransactionsStampWhileAServedWriteProbesItsScopesHeadByItsKeyAlone =
	property.exhaust(finite(directGen), {
		needs: { shape: Substrate.fresh(generatedShape) },
		box: "a role's and the owner's five inserts of a Mark of kid 0 and two moves of the stored one, after a served Mark of kid 0 committed, 14 cases",
		situations: [
			"a role's insert refused by the guard",
			"an owner's insert refused by the guard",
			"an insert at its own stamp admitted",
			"a role's move refused by its privileges",
			"an owner's move refused by the guard",
			"an owner's move to its own stamp admitted"
		] satisfies ReadonlyArray<Reached<DirectFeature>>,
		check:
			({ shape }, k: Case<DirectFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const taken = yield* shape
					const run = yield* Effect.provideService(
						runDirect(taken.value, c),
						Substrate,
						taken.substrate
					)
					k.note(directFeatureOf(c))
					const fate = fateOf(c)
					const h = run.head
					const expected =
						fate.kind === "refused"
							? [`0 0 ${h}`]
							: c.states === "at its own stamp"
								? [`0 0 ${h}`, `0 1 ${h + 1n}`]
								: [`0 0 ${h + 1n}`]
					const shown =
						run.failure === undefined
							? "committed"
							: `refused with ${run.failure.code} under ${run.failure.constraint ?? "no constraint"}`
					const due =
						fate.kind === "admitted"
							? "admitted"
							: `refused with ${fate.code} under ${fate.constraint ?? "no constraint"}`
					const problems = [
						...(run.served.seqScans === 0n && run.served.indexScans === servedHeadProbes
							? []
							: [
									`the served Mark scanned Kid's head ${run.served.seqScans} times and probed it ${run.served.indexScans} times, where its stamps and its guards probe it ${servedHeadProbes} times by its key and never scan it`
								]),
						...(shown === (fate.kind === "admitted" ? "committed" : due)
							? []
							: [`${c.writer} ${c.states}: ${shown}, where ${due} was due`]),
						...(Arr.join(run.marks, "; ") === Arr.join(expected, "; ")
							? []
							: [`the Marks ${Arr.join(run.marks, "; ")}, where ${Arr.join(expected, "; ")} stand`])
					]
					if (Arr.isReadonlyArrayNonEmpty(problems)) {
						return yield* Effect.die(
							new Error(`${Arr.join(problems, "\n")}\nin ${Formatter.format(c)}`)
						)
					}
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the clock's guard: a row's clock at its scope's key is its transaction's stamp there, else the write is refused with 23514 under __clocked or __clock_moved, a role's move by its privileges; a served Mark's stamps and guards probe Kid's head by its key and never scan it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/clocked.ts",
				original: "\tif (byRelation.size === 0) {\n",
				replacement: "\tif (byRelation.size >= 0) {\n",
				why: "No relation of a clock holds a guard, as before it: a direct writer inserts a Mark below the head, at the head another call stamped or above it unstamped, and moves the stored one off its stamp, each committed where the guard refuses it."
			},
			{
				file: "packages/engine/src/physical/ddl/clocked.ts",
				original: "\t\t\t\teq(col(head, headStamper), thisTransaction)\n",
				replacement: "\t\t\t\teq(col(head, headStamper), col(head, headStamper))\n",
				why: "The guard reads the head's instant but not who stamped it: a direct writer's Mark at the head another call stamped, the served Mark's, is admitted though its own transaction stamped nothing there."
			},
			{
				file: "packages/engine/src/physical/ddl/clocked.ts",
				original: '\tconst moved = binary("<>", row(of("NEW")), row(of("OLD")))\n',
				replacement: '\tconst moved = binary("<>", row(of("NEW")), row(of("NEW")))\n',
				why: "The move guard takes every UPDATE for one that leaves the clock where it was: the owner's move of the stored Mark off its stamp commits."
			},
			{
				file: "packages/engine/src/physical/ddl/stamps.ts",
				original:
					'\t\twhens: [{ when: binary("=", col(held, headStamper), thisTransaction), result: col(held, at) }],\n',
				replacement: "\t\twhens: [{ when: lit.bool(false), result: col(held, at) }],\n",
				why: "Every call of the stamp function steps its head on, one stamp a call no more: the served Mark's statement stamps Mark one instant and Event the next, so Mark's guard finds its rows below the head its transaction stamped and refuses the served write."
			}
		]
	})

/**
 * A workload ChangeSet's member is prepared once for each set of its fill contexts (write/program/compile.ts
 * PreparedWrite: its front end, compileChangeSet, and its put targets, which read no isolation level) and compiled once,
 * at its role's level. Its put targets decide whether it has a READ COMMITTED form (PreparedWrite.readCommittedLack,
 * write/schedule/plan.ts readCommittedLack), so a role certification reads at READ COMMITTED is prepared first and read
 * for its form (readCommittedRole, phase `frontEnd`), then compiled at one level (membersAt, phase `changeSet`): READ
 * COMMITTED where every member has a form, SERIALIZABLE alone where one lacks it. No entry keeps its prepared write
 * past its compile (CertifiableEntry), so a role certification leaves SERIALIZABLE is prepared again from its values
 * and compiled at it (serializableChanges), and a role it never lowers holds none of its front ends. A role with a
 * member lacking a form compiled every member at READ COMMITTED first, each formed member's compile thrown away, each
 * lacking one's placed for its refusal, and then at SERIALIZABLE; every entry held its prepared write, so every front
 * end lived through certification (metis's full installation: 213, 1,198 MB as its changes began).
 *
 * The box, drawn: a login of one or two roles, each writing a span primary key (Room), its mutable twin (Hold), whose
 * inserts and puts have no READ COMMITTED form, and a scalar key (Plain), whose have, its workload formed or not, each
 * as likely (levelRoleGen): Plain's insert, its put or both, or one or both of Room's insert and Hold's put with any of
 * Plain's.
 *
 * Property: after the login's READ COMMITTED compile, a role with a member lacking a form names exactly those members,
 * in its workload's order, each with its relation, its entries compiled at SERIALIZABLE, and a formed role's at
 * READ COMMITTED; the login's compile compiled every member once, placed it once (write/program/compile.ts
 * compileAt, placementOf) and compiled no front end, each its plan's (write/frontend/compile.ts compileChangeSet), each
 * call counted (test/support/kernel/calls.ts); and a formed role compiled again at SERIALIZABLE prepares each member
 * again from its value, its front end compiled afresh, and compiles it once. At the start of each role's first compile,
 * reported to the login's phases (core/phase.ts `changeSet`), the prepared writes alive (counted by V8 after a full
 * collection) are those alive before the login compiled and one for each of its members, the ones its forms were read
 * from; once the login compiled, those alive before it alone. And no placement outlives the compile that read it: at
 * the start of each role's last ChangeSet's compile, where each earlier member of the role has compiled with its
 * prepared write alive, and once the login compiled, the physical analyses alive (analysis/physical/analyze.ts
 * PropsUnder, one for each) are those alive before the login compiled (edullm's qti: the learner role's decideStage
 * placement alone ~1.1 GB). Every count is read in the one synchronous run of the compile (heapOverCompile), so no
 * other code of the worker runs between two of them and each difference is this compile's own, where the first counts
 * were read before the call counter's awaits and a worker's other work could land between them (the unit tier at load
 * 170 and 0be68193: one analysis more, twice). Kills: each read of a member prepares it again; a prepared write
 * keeps its placement for its next compile; a role compiles every member at READ COMMITTED before reading its form.
 *
 * Features: a role with a member lacking a form, a formed role.
 */

import { queryObjects } from "node:v8"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, type Gen, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { PropsUnder } from "#compiler/analysis/physical/analyze.ts"
import type { Phases } from "#compiler/core/phase.ts"
import { readCommittedChanges, serializableChanges } from "#compiler/program/workload/change.ts"
import { PreparedWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	changeLoginOf,
	entriesOf,
	type Program,
	programs
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** The programs with a READ COMMITTED form, and those without one (prepared-levels.fixtures.ts programs). */
const formedPrograms: ReadonlyArray<Program> = ["insertPlain", "putPlain"]
const unformedPrograms: ReadonlyArray<Program> = ["insertRoom", "putHold"]

/**
 * A role's workload, formed or not, each as likely: one or both programs that have a READ COMMITTED form, or one or
 * both that lack one followed by any of the formed ones, so a box of a few cases holds both kinds of role, where a
 * workload drawn from every subset of the four was formed one time in five and its search steered sixteen cases to
 * reach a formed role.
 */
const levelRoleGen: Gen<ReadonlyArray<Program>> = (source) =>
	source.draw(boolean)
		? source.draw(subset(formedPrograms, { min: 1, max: 2 }))
		: [
				...source.draw(subset(unformedPrograms, { min: 1, max: 2 })),
				...source.draw(subset(formedPrograms, { min: 0, max: 2 }))
			]

/** A login's roles, one or two, each its workload (levelRoleGen). */
const levelRolesGen: Gen<NonEmptyReadonlyArray<ReadonlyArray<Program>>> = (source) => [
	source.draw(levelRoleGen),
	...source.draw(array(levelRoleGen, { min: 0, max: 1 }))
]

/** The physical analyses alive, counted by V8 after a full collection: one for each placement held. */
const analysesAlive = (): number => queryObjects(PropsUnder, { format: "count" })

/** The prepared writes alive, counted by V8 after a full collection. */
const preparedAlive = (): number => queryObjects(PreparedWrite, { format: "count" })

/** The work a compile does, each call counted: a write's compile at a level, its placement, and a front end's compile. */
const counted = {
	compiles: { file: "packages/engine/src/write/program/compile.ts", name: "compileAt" },
	placements: { file: "packages/engine/src/write/program/compile.ts", name: "placementOf" },
	frontEnds: { file: "packages/engine/src/write/frontend/compile.ts", name: "compileChangeSet" }
} as const

/**
 * The login's READ COMMITTED compile (readCommittedChanges) and the heap around it, read in one synchronous run of the
 * compile, so no other code of the worker runs between two counts and each count's difference from the ones before it
 * is exactly what this compile left alive (both node:v8 queryObjects counts follow a full collection): the physical
 * analyses and the prepared writes alive before the compile; at each role's first ChangeSet's start, the prepared
 * writes alive (one for each of its members, the ones its forms were read from); at each role's last ChangeSet's start,
 * where every earlier member of the role has compiled and its prepared write is alive, the analyses alive (none past
 * the compile that read it); and both once the login compiled. Each count scans the worker's whole heap, seconds of
 * CPU under a loaded worker, so the heap is read at those points alone, where it was read at every ChangeSet's start.
 */
const heapOverCompile = (
	login: ReturnType<typeof changeLoginOf>,
	drawn: ReadonlyArray<ReadonlyArray<Program>>
) => {
	/** Each role's ChangeSets, by its name (changeLoginOf names the i-th drawn role writer<i>). */
	const members = new Map<string, number>(Arr.map(drawn, (held, i) => [`writer${i}`, held.length]))
	const analysesBefore = analysesAlive()
	const preparedBefore = preparedAlive()
	/** How many of each role's ChangeSets have started, by the role's name. */
	const started = new Map<string, number>()
	const atFirsts = new Map<string, number>()
	const atLasts = new Map<string, number>()
	const phases: Phases = {
		report: (phase, edge) => {
			if (phase.name !== "changeSet" || edge !== "start") {
				return
			}
			const role = phase.of[0] ?? ""
			const at = (started.get(role) ?? 0) + 1
			started.set(role, at)
			if (at === 1) {
				atFirsts.set(role, preparedAlive())
			}
			if (at === members.get(role)) {
				atLasts.set(role, analysesAlive())
			}
		}
	}
	const roles = succeeded(readCommittedChanges(login, phases), "the login's compile")
	return {
		roles,
		analysesBefore,
		preparedBefore,
		atFirsts,
		atLasts,
		analysesAfter: analysesAlive(),
		preparedAfter: preparedAlive()
	}
}

/** A role's members are prepared and compiled once, at its level, and a lowered role is prepared again from its values. */
export const aRolesMembersArePreparedAndCompiledOnceAtItsLevelAndALoweredRoleIsPreparedAgainFromItsValues =
	property.explore(levelRolesGen, {
		needs: {},
		/**
		 * The search's budget: one fresh case a run beside its floor case, its steered phase capped at the runner's 200.
		 *
		 * @limitKind measured
		 * @owner test/unit/program/prepared-levels.test.ts, this property's search
		 * @unit `runs` the cases of its rotating stream (its floor a quarter of them, rounded up); `steered` the most its
		 *   steered phase runs while a required situation is unreached
		 * @scope this property's search, one worker of toolchain-test's pool
		 * @evidence `toolchain-test run` and `toolchain-test kills` of the file at TEST_SEED=2219874524 on 3124dd41b with this
		 *   change (a property's witnesses, its kept cases, floor and steered phase, are fixed by its identity), the logs
		 *   pl-k1.log and pl-k2.log in ~/.cache/grizzle/CLISTART-logs on cassowary, uncommitted; the unit tier on 0be68193,
		 *   ~/.cache/grizzle/unittier-0be68193.log
		 * @observed 2026-11-23
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 250 to 400 from other
		 *   lanes; vendor/toolchain 91704ef4
		 * @workload its search and its three kills, each kill on a worker of its own
		 * @result runs 150 (the runner's default) over rolesGen: 188 cases at 16.5 s each in the unit tier, its verdict
		 *   after 880 s of a 919 s run, 3,099 worker-seconds; runs 1 over rolesGen: 18 cases, 16 of them steered to reach a
		 *   formed role, its verdict after 332 s; runs 1 over levelRolesGen: 2 cases, both situations reached, none
		 *   steered, 12.3 s of CPU, its verdict after 20 s, and its 3 kills killed
		 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run: every kill fails a witness there.
		 *   steered stays the runner's 200: the phase stops once both situations are reached, so a green run spends only
		 *   its need, none here, and the cap only bounds a run whose situation went unreached
		 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
		 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
		 *   survives
		 */
		budget: { runs: 1, steered: 200 },
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const login = changeLoginOf(drawn)
				const [heap, work] = yield* callCounts(
					Effect.sync(() => heapOverCompile(login, drawn)),
					counted
				)
				const { roles } = heap
				const members = Arr.reduce(drawn, 0, (n, held) => n + held.length)
				assert.equal(work.compiles, members, "each member compiled once, at its role's level")
				assert.equal(work.placements, members, "each member placed once")
				assert.equal(work.frontEnds, 0, "no front end compiled: each member's its plan's")
				for (const [i, held] of drawn.entries()) {
					const role = `writer${i}`
					assert.equal(
						heap.atLasts.get(role),
						heap.analysesBefore,
						`${role}'s last ChangeSet's start: no placement alive past the compile that read it`
					)
					assert.equal(
						heap.atFirsts.get(role),
						heap.preparedBefore + held.length,
						`${role}'s first compile: one prepared write for each of its members, the ones its forms were read from`
					)
				}
				assert.equal(
					heap.analysesAfter,
					heap.analysesBefore,
					"no placement alive once the login compiled"
				)
				assert.equal(
					heap.preparedAfter,
					heap.preparedBefore,
					"no prepared write alive once the login compiled"
				)
				for (const [i, held] of drawn.entries()) {
					const compiled = roles.get(`writer${i}`)
					assert.ok(compiled !== undefined, `role writer${i} compiled`)
					const formed = Arr.every(held, (p) => programs[p].formed)
					assert.equal(compiled.kind, formed ? "formed" : "unformed", `writer${i}'s form`)
					const entries = Arr.flatMap([...compiled.changes.members.values()], entriesOf)
					assert.equal(entries.length, held.length, "one entry per program")
					if (compiled.kind === "unformed") {
						c.note("a role with a member lacking a form")
						const lacking: ReadonlyArray<string> = Arr.map(
							compiled.unformed,
							(u) => `${u.member} ${u.relation}`
						)
						assert.deepEqual(
							lacking,
							Arr.flatMap(held, (p) =>
								programs[p].formed ? [] : [`${p}${i} ${programs[p].relation}`]
							),
							"the members lacking a form, each with its relation, in the workload's order"
						)
						for (const entry of entries) {
							assert.equal(entry.compiled.level, "serializable", "compiled at SERIALIZABLE")
						}
						continue
					}
					c.note("a formed role")
					for (const entry of entries) {
						assert.equal(entry.compiled.level, "readCommitted", "compiled at READ COMMITTED")
					}
					const [lowered, again] = yield* callCounts(
						Effect.sync(() => succeeded(serializableChanges(compiled.changes), "SERIALIZABLE")),
						counted
					)
					assert.equal(again.frontEnds, held.length, "each member prepared again from its value")
					assert.equal(again.compiles, held.length, "each member compiled once, at SERIALIZABLE")
					for (const entry of Arr.flatMap([...lowered.members.values()], entriesOf)) {
						assert.equal(entry.compiled.level, "serializable", "compiled at SERIALIZABLE")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "one preparation and one compile of each member at its role's level, and a lowered role prepared again"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\tconst variants = once(() =>\n",
				replacement: "\t\t\tconst variants = (() =>\n",
				why: "Each read of a member prepares it again: the prepared write its form was read from is dropped and its compile prepares another, so at a role's first compile its members' prepared writes are not alive, and the search fails."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t\treturn Result.flatMap(this.#place(), (placed) => placed.compile(level))\n",
				replacement:
					"\t\tthis.held ??= this.#place()\n\t\treturn Result.flatMap(this.held, (placed) => placed.compile(level))\n",
				why: "A prepared write keeps its placement for its next compile, as the role's compile kept every member's: the placement's physical analysis outlives the compile that read it, so at the next ChangeSet's start and once the login compiled the analyses alive outnumber those before the login compiled, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\t\tprogram.lack()\n",
				replacement: '\t\t\t\t(program.compile("readCommitted"), program.lack())\n',
				why: "A role compiles every member at READ COMMITTED before reading its form, as it compiled every member there to learn it: a formed member is compiled twice, and the search fails."
			}
		]
	})

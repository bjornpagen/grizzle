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
 * The boxes, exhausted: logins of one or two roles, each writing a span primary key (Room), its mutable twin (Hold),
 * whose inserts and puts have no READ COMMITTED form, and a scalar key (Plain), whose have, each role's workload one or
 * two of the four programs (Room's insert, Hold's put, Plain's insert and put): every login of one or two such roles
 * for the compile's work (110), every one-role login for its heap (10). The heap is read by node:v8 queryObjects, a
 * scan of the worker's whole heap a count (0.55 s of CPU at a 40 MB heap, ten times a full collection), so only the
 * heap's property reads it, where one property read it in each of 188 drawn logins of up to three roles over every
 * subset of the four and took the unit tier's longest verdict (880 s on 0be68193).
 *
 * Property (work): after the login's READ COMMITTED compile, a role with a member lacking a form names exactly those
 * members, in its workload's order, each with its relation, its entries compiled at SERIALIZABLE, and a formed role's
 * at READ COMMITTED; the login's compile prepared every member once (write/program/compile.ts preparedWrite), compiled
 * it once and placed it once (compileAt, placementOf) and compiled no front end, each its plan's
 * (write/frontend/compile.ts compileChangeSet), each call counted (test/support/kernel/calls.ts); and a formed role
 * compiled again at SERIALIZABLE prepares each member again from its value, its front end compiled afresh, and
 * compiles it once. Kills: each read of a member prepares it again; a role compiles every member at READ COMMITTED
 * before reading its form.
 *
 * Property (heap): at the start of a role's first compile, reported to the login's phases (core/phase.ts
 * `changeSet`), the prepared writes alive (counted by V8 after a full collection) are those alive before the login
 * compiled and one for each of its members, the ones its forms were read from; once the login compiled, those alive
 * before it alone. And no placement outlives the compile that read it: at the start of the role's last ChangeSet's
 * compile, where each earlier member has compiled with its prepared write alive, and once the login compiled, the
 * physical analyses alive (analysis/physical/analyze.ts PropsUnder, one for each) are those alive before the login
 * compiled (edullm's qti: the learner role's decideStage placement alone ~1.1 GB). Every count is read in the one
 * synchronous run of the compile (heapOverCompile), on code the call counter's restart left cold, so no other code of
 * the worker runs between two of them and each difference is this compile's own, where the first counts were read
 * before the call counter's awaits and a worker's other work could land between them (the unit tier at load 170 and
 * 0be68193: one analysis more, twice). Kills: each read of a member prepares it again; a prepared write keeps its
 * placement for its next compile.
 *
 * Features: a role with a member lacking a form, a formed role.
 */

import { queryObjects } from "node:v8"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, finite, type Gen, subset } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { PropsUnder } from "#compiler/analysis/physical/analyze.ts"
import { type Phases, silentPhases } from "#compiler/core/phase.ts"
import { readCommittedChanges, serializableChanges } from "#compiler/program/workload/change.ts"
import { PreparedWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	changeLoginOf,
	entriesOf,
	type Program,
	programNames,
	programs
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** A role's workload: one or two of the four programs, in their order (prepared-levels.fixtures.ts programs). */
const workloadGen = subset(programNames, { min: 1, max: 2 })

/** Every login of one or two roles, each its workload (workloadGen): 10 one-role logins and 100 of two. */
const loginsGen: Gen<NonEmptyReadonlyArray<ReadonlyArray<Program>>> = (source) => [
	source.draw(workloadGen),
	...source.draw(array(workloadGen, { min: 0, max: 1 }))
]

/** Every one-role login (workloadGen): 10. */
const oneRoleGen: Gen<NonEmptyReadonlyArray<ReadonlyArray<Program>>> = (source) => [
	source.draw(workloadGen)
]

/** The physical analyses alive, counted by V8 after a full collection: one for each placement held. */
const analysesAlive = (): number => queryObjects(PropsUnder, { format: "count" })

/** The prepared writes alive, counted by V8 after a full collection. */
const preparedAlive = (): number => queryObjects(PreparedWrite, { format: "count" })

/**
 * The work a compile does, each call counted: a member's preparation over its plan's front end, a write's compile at a
 * level, its placement, and a front end's compile.
 */
const counted = {
	prepares: { file: "packages/engine/src/write/program/compile.ts", name: "preparedWrite" },
	compiles: { file: "packages/engine/src/write/program/compile.ts", name: "compileAt" },
	placements: { file: "packages/engine/src/write/program/compile.ts", name: "placementOf" },
	frontEnds: { file: "packages/engine/src/write/frontend/compile.ts", name: "compileChangeSet" }
} as const

/** Nothing counted: what callCounts runs a measured effect under, code the restart of its counting leaves cold. */
const cold = {} as const

/**
 * The login's READ COMMITTED compile (readCommittedChanges) and the heap around it, read in one synchronous run of the
 * compile, so no other code of the worker runs between two counts and each count's difference from the ones before it
 * is exactly what this compile left alive (both node:v8 queryObjects counts follow a full collection): the physical
 * analyses and the prepared writes alive before the compile; at its one role's first ChangeSet's start, the prepared
 * writes alive (one for each of its members, the ones its forms were read from); at its last ChangeSet's start, where
 * each earlier member has compiled and its prepared write is alive, the analyses alive (none past the compile that read
 * it); and both once the login compiled.
 */
const heapOverCompile = (login: ReturnType<typeof changeLoginOf>, members: number) => {
	const analysesBefore = analysesAlive()
	const preparedBefore = preparedAlive()
	let started = 0
	let atFirst = -1
	let atLast = -1
	const phases: Phases = {
		report: (phase, edge) => {
			if (phase.name !== "changeSet" || edge !== "start") {
				return
			}
			started += 1
			if (started === 1) {
				atFirst = preparedAlive()
			}
			if (started === members) {
				atLast = analysesAlive()
			}
		}
	}
	succeeded(readCommittedChanges(login, phases), "the login's compile")
	return {
		analysesBefore,
		preparedBefore,
		atFirst,
		atLast,
		analysesAfter: analysesAlive(),
		preparedAfter: preparedAlive()
	}
}

/** A role's members are prepared and compiled once, at its level, and a lowered role is prepared again from its values. */
export const aRolesMembersArePreparedAndCompiledOnceAtItsLevelAndALoweredRoleIsPreparedAgainFromItsValues =
	property.exhaust(finite(loginsGen), {
		needs: {},
		box: "every login of one or two roles, each role's workload one or two of Room's insert, Hold's put and Plain's insert and put",
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const login = changeLoginOf(drawn)
				const [roles, work] = yield* callCounts(
					Effect.sync(() =>
						succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
					),
					counted
				)
				const members = Arr.reduce(drawn, 0, (n, held) => n + held.length)
				assert.equal(work.prepares, members, "each member prepared once, its form read from it")
				assert.equal(work.compiles, members, "each member compiled once, at its role's level")
				assert.equal(work.placements, members, "each member placed once")
				assert.equal(work.frontEnds, 0, "no front end compiled: each member's its plan's")
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
				why: "Each read of a member prepares it again: its form is read from one prepared write and its compile prepares another, so each member is prepared twice, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\t\tprogram.lack()\n",
				replacement: '\t\t\t\t(program.compile("readCommitted"), program.lack())\n',
				why: "A role compiles every member at READ COMMITTED before reading its form, as it compiled every member there to learn it: a formed member is compiled twice, and the search fails."
			}
		]
	})

/** A one-role login's compile holds each member's prepared write from its form's reading to its compile, and no prepared write or placement past it. */
export const aRolesCompileHoldsEachPreparedWriteUntilItsMemberCompilesAndNoPlacementPastTheCompileThatReadIt =
	property.exhaust(finite(oneRoleGen), {
		needs: {},
		box: "every one-role login, its workload one or two of Room's insert, Hold's put and Plain's insert and put",
		situations: [],
		check: () => (drawn) =>
			Effect.gen(function* () {
				const held = drawn[0]
				const login = changeLoginOf(drawn)
				const [heap] = yield* callCounts(
					Effect.sync(() => heapOverCompile(login, held.length)),
					cold
				)
				assert.equal(
					heap.atFirst,
					heap.preparedBefore + held.length,
					"the role's first compile: one prepared write for each of its members, the ones its forms were read from"
				)
				assert.equal(
					heap.atLast,
					heap.analysesBefore,
					"the role's last ChangeSet's start: no placement alive past the compile that read it"
				)
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
			}),
		oracle: {
			kind: "specification",
			name: "a prepared write lives from its form's reading to its compile, a placement within the compile that read it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\tconst variants = once(() =>\n",
				replacement: "\t\t\tconst variants = (() =>\n",
				why: "Each read of a member prepares it again: the prepared write its form was read from is dropped and its compile prepares another, so at the role's first compile its members' prepared writes are not alive, and the search fails."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t\treturn Result.flatMap(this.#place(), (placed) => placed.compile(level))\n",
				replacement:
					"\t\tthis.held ??= this.#place()\n\t\treturn Result.flatMap(this.held, (placed) => placed.compile(level))\n",
				why: "A prepared write keeps its placement for its next compile, as the role's compile kept every member's: the placement's physical analysis outlives the compile that read it, so at the role's last ChangeSet's start the analyses alive outnumber those before the login compiled, and the search fails."
			}
		]
	})

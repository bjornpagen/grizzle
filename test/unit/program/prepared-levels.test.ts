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
 * The box, drawn: a login of one to three roles, each writing a span primary key (Room), its mutable twin (Hold), whose
 * inserts and puts have no READ COMMITTED form, and a scalar key (Plain), whose have, its workload one to all four of
 * Room's insert, Hold's put, Plain's insert and Plain's put.
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
 * the start of every ChangeSet's compile, and once the login compiled, the physical analyses alive
 * (analysis/physical/analyze.ts PropsUnder, one for each) are those alive before the login compiled (edullm's qti: the
 * learner role's decideStage placement alone ~1.1 GB). Kills: each read of a member prepares it again; a prepared write
 * keeps its placement for its next compile; a role compiles every member at READ COMMITTED before reading its form.
 *
 * Features: a role with a member lacking a form, a formed role.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
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
	programs,
	rolesGen
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

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

/** A role's members are prepared and compiled once, at its level, and a lowered role is prepared again from its values. */
export const aRolesMembersArePreparedAndCompiledOnceAtItsLevelAndALoweredRoleIsPreparedAgainFromItsValues =
	property.explore(rolesGen, {
		needs: {},
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const login = changeLoginOf(drawn)
				const before = analysesAlive()
				const preparedBefore = preparedAlive()
				/** The physical analyses alive at the start of each ChangeSet's compile. */
				const atStarts: Array<number> = []
				/** The prepared writes alive at the start of each role's first compile, by the role's name. */
				const atFirsts = new Map<string, number>()
				const phases: Phases = {
					report: (phase, edge) => {
						if (phase.name !== "changeSet" || edge !== "start") {
							return
						}
						atStarts.push(analysesAlive())
						const role = phase.of[0] ?? ""
						if (!atFirsts.has(role)) {
							atFirsts.set(role, preparedAlive())
						}
					}
				}
				const [roles, work] = yield* callCounts(
					Effect.sync(() => succeeded(readCommittedChanges(login, phases), "the login's compile")),
					counted
				)
				const members = Arr.reduce(drawn, 0, (n, held) => n + held.length)
				assert.equal(work.compiles, members, "each member compiled once, at its role's level")
				assert.equal(work.placements, members, "each member placed once")
				assert.equal(work.frontEnds, 0, "no front end compiled: each member's its plan's")
				assert.ok(atStarts.length > 0, "a ChangeSet compiled")
				for (const alive of [...atStarts, analysesAlive()]) {
					assert.equal(alive, before, "no placement alive past the compile that read it")
				}
				for (const [i, held] of drawn.entries()) {
					assert.equal(
						atFirsts.get(`writer${i}`),
						preparedBefore + held.length,
						`writer${i}'s first compile: one prepared write for each of its members, the ones its forms were read from`
					)
				}
				assert.equal(
					preparedAlive(),
					preparedBefore,
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

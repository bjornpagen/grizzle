/**
 * A workload ChangeSet's member is prepared once for each set of its fill contexts (write/program/compile.ts
 * PreparedWrite: its front end, compileChangeSet, and its put targets, which read no isolation level), and that one
 * prepared write is compiled at every level its role is compiled at (program/workload/change.ts PreparedVariants,
 * PreparedEntry). Its put targets decide whether it has a READ COMMITTED form (PreparedWrite.readCommittedLack,
 * write/schedule/plan.ts readCommittedLack), so a role certification reads at READ COMMITTED is prepared first and read
 * for its form (readCommittedRole, phase `frontEnd`), then compiled at one level (membersAt, phase `changeSet`): READ
 * COMMITTED where every member has a form, SERIALIZABLE alone where one lacks it; a role certification leaves
 * SERIALIZABLE is compiled at it again (serializableChanges, changesAt). Each level compiled the member's front end from
 * its value again, and a role with a member lacking a form compiled every member at READ COMMITTED first, each formed
 * member's compile thrown away, each lacking one's placed for its refusal, and then at SERIALIZABLE.
 *
 * The box, drawn: a login of one to three roles, each writing a span primary key (Room), its mutable twin (Hold), whose
 * inserts and puts have no READ COMMITTED form, and a scalar key (Plain), whose have, its workload one to all four of
 * Room's insert, Hold's put, Plain's insert and Plain's put.
 *
 * Property: after the login's READ COMMITTED compile, a role with a member lacking a form names exactly those members,
 * in its workload's order, each with its relation, and each of its entries is compiled once, at SERIALIZABLE,
 * and placed once (PreparedWrite #place, its deduplication's placement); every entry of a formed role is
 * compiled once, at READ COMMITTED, and the role compiled again at SERIALIZABLE holds the same prepared writes, each
 * compiled twice, their front ends the ones its READ COMMITTED entries hold. Each member is prepared once whatever the
 * levels: at the start of each role's first compile, reported to the login's phases (core/phase.ts `changeSet`), the
 * prepared writes alive (counted by V8 after a full collection) are those alive before the login compiled and one for
 * each member of the roles compiled so far, its own included, the ones its form was read from. And no placement
 * outlives the compile that read it: at the end of every ChangeSet's compile the physical analyses alive
 * (analysis/physical/analyze.ts PropsUnder, one for each) are those alive before the login compiled, where the role's
 * compile held every member's placement until its last member compiled (edullm's qti: the learner role's decideStage
 * placement alone ~1.1 GB). Kills: each read of a member prepares it again; a prepared write keeps its placement for
 * its next compile; a role compiles every member at READ COMMITTED before reading its form.
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
import {
	changeLoginOf,
	entriesOf,
	programs,
	rolesGen,
	workOf
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** The physical analyses alive, counted by V8 after a full collection: one for each placement held. */
const analysesAlive = (): number => queryObjects(PropsUnder, { format: "count" })

/** The prepared writes alive, counted by V8 after a full collection. */
const preparedAlive = (): number => queryObjects(PreparedWrite, { format: "count" })

/** Each member's front end is compiled once, whatever the levels its role is compiled at. */
export const eachMembersFrontEndIsCompiledOnceWhateverTheLevelsItsRoleIsCompiledAt =
	property.explore(rolesGen, {
		needs: {},
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				const login = changeLoginOf(drawn)
				const before = analysesAlive()
				const preparedBefore = preparedAlive()
				/** The physical analyses alive at the end of each ChangeSet's compile. */
				const atEnds: Array<number> = []
				/** The prepared writes alive at the start of each role's first compile, by the role's name. */
				const atFirsts = new Map<string, number>()
				const phases: Phases = {
					report: (phase, edge) => {
						if (phase.name !== "changeSet") {
							return
						}
						const role = phase.of[0] ?? ""
						if (edge === "start" && !atFirsts.has(role)) {
							atFirsts.set(role, preparedAlive())
						}
						if (edge === "end") {
							atEnds.push(analysesAlive())
						}
					}
				}
				const roles = succeeded(readCommittedChanges(login, phases), "the login's compile")
				assert.ok(atEnds.length > 0, "a ChangeSet compiled")
				for (const alive of atEnds) {
					assert.equal(alive, before, "no placement alive past the compile that read it")
				}
				for (const i of drawn.keys()) {
					const sofar = Arr.reduce(drawn.slice(0, i + 1), 0, (n, programs) => n + programs.length)
					assert.equal(
						atFirsts.get(`writer${i}`),
						preparedBefore + sofar,
						`writer${i}'s first compile: one prepared write for each member of the roles so far, its own the ones its form was read from`
					)
				}
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
							assert.equal(
								workOf(entry.prepared).compiles,
								1,
								"an unformed role's member: compiled once, at SERIALIZABLE alone"
							)
							assert.equal(workOf(entry.prepared).placements, 1, "placed for its one compile")
						}
						continue
					}
					c.note("a formed role")
					for (const entry of entries) {
						assert.equal(entry.compiled.level, "readCommitted", "compiled at READ COMMITTED")
						assert.equal(
							workOf(entry.prepared).compiles,
							1,
							"a formed role's member, compiled once"
						)
					}
					const again = Arr.flatMap(
						[...succeeded(serializableChanges(compiled.changes), "SERIALIZABLE").members.values()],
						entriesOf
					)
					for (const [at, entry] of again.entries()) {
						const before = entries[at]
						assert.ok(before !== undefined, "an entry at each place")
						assert.equal(
							entry.prepared,
							before.prepared,
							"the prepared write its READ COMMITTED entry holds"
						)
						assert.equal(
							workOf(entry.prepared).compiles,
							2,
							"compiled again at SERIALIZABLE, prepared once"
						)
						assert.equal(entry.compiled.frontend, before.compiled.frontend, "one front end")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "one front end per member and set of fill contexts, for every level its role is compiled at"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\tconst variants = once(() =>\n",
				replacement: "\t\t\tconst variants = (() =>\n",
				why: "Each read of a member prepares it again from its value, as each level compiled it before: the prepared write its form was read from is dropped and its compile prepares another, so at a role's first compile its members' prepared writes are not alive, and the search fails."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t\treturn Result.flatMap(this.#place(), (placed) => placed.compile(level))\n",
				replacement:
					"\t\tthis.held ??= this.#place()\n\t\treturn Result.flatMap(this.held, (placed) => placed.compile(level))\n",
				why: "A prepared write keeps its placement for its next compile, as the role's compile kept every member's: the placement's physical analysis outlives the compile that read it, so at a ChangeSet's end the analyses alive outnumber those before the login compiled, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\t\tprogram.lack()\n",
				replacement: '\t\t\t\t(program.compile("readCommitted"), program.lack())\n',
				why: "A role compiles every member at READ COMMITTED before reading its form, as it compiled every member there to learn it: a formed role's member is compiled twice at READ COMMITTED and a formed member of a role lacking a form at both levels, and the search fails."
			}
		]
	})

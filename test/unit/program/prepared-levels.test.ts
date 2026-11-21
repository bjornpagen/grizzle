/**
 * A workload ChangeSet's member is prepared once for each set of its fill contexts (write/program/compile.ts
 * PreparedWrite: its front end, compileChangeSet, and its put targets, which read no isolation level), and that one
 * prepared write is compiled at every level its role is compiled at (program/workload/change.ts PreparedVariants,
 * PreparedEntry). A role certification reads at READ COMMITTED is compiled at it first; one with a member that has no
 * READ COMMITTED form is compiled again at SERIALIZABLE (readCommittedRole, membersAt), and a role certification leaves
 * SERIALIZABLE is compiled at it again (serializableChanges, changesAt). Each compiled the member's front end from its
 * value again, where only the schedule, the lowering and what is built over them read the level.
 *
 * The box, drawn: a login of one to three roles, each writing a span primary key (Room), its mutable twin (Hold), whose
 * inserts and puts have no READ COMMITTED form, and a scalar key (Plain), whose have, its workload one to all four of
 * Room's insert, Hold's put, Plain's insert and Plain's put.
 *
 * Property: after the login's READ COMMITTED compile, every entry of a role with a member lacking a form is the
 * SERIALIZABLE compile of the prepared write its READ COMMITTED compile read, compiled twice and placed once
 * (PreparedWrite.place, its deduplication's placement), and every entry of a formed role compiled once; the formed role
 * compiled again at SERIALIZABLE holds the same prepared writes, each compiled twice, their front ends the ones its
 * READ COMMITTED entries hold. Each member's front end is compiled once whatever the levels, and placed once for every
 * compile of its role. Kills: each level of a role's compile prepares its members again; and places them again.
 *
 * Features: a role with a member lacking a form, a formed role.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { readCommittedChanges, serializableChanges } from "#compiler/program/workload/change.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	changeLoginOf,
	entriesOf,
	programs,
	rolesGen,
	workOf
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** Each member's front end is compiled once, whatever the levels its role is compiled at. */
export const eachMembersFrontEndIsCompiledOnceWhateverTheLevelsItsRoleIsCompiledAt =
	property.explore(rolesGen, {
		needs: {},
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				const roles = succeeded(readCommittedChanges(changeLoginOf(drawn)), "the login's compile")
				for (const [i, held] of drawn.entries()) {
					const compiled = roles.get(`writer${i}`)
					assert.ok(compiled !== undefined, `role writer${i} compiled`)
					const formed = Arr.every(held, (p) => programs[p].formed)
					assert.equal(compiled.kind, formed ? "formed" : "unformed", `writer${i}'s form`)
					const entries = Arr.flatMap([...compiled.changes.members.values()], entriesOf)
					assert.equal(entries.length, held.length, "one entry per program")
					if (compiled.kind === "unformed") {
						c.note("a role with a member lacking a form")
						for (const entry of entries) {
							assert.equal(
								workOf(entry.prepared).compiles,
								2,
								"an unformed role's member: one prepared write, compiled at READ COMMITTED and SERIALIZABLE"
							)
							assert.equal(workOf(entry.prepared).placements, 1, "placed once for both")
						}
						continue
					}
					c.note("a formed role")
					for (const entry of entries) {
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
				why: "Each level of a role's compile prepares its members again from their values, as each level compiled them before: an unformed role's SERIALIZABLE entries are each a fresh prepared write compiled once, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original:
					"\t\tconst placed = once(() => Result.flatMap(entry(), (prepared) => prepared.prepared.place()))\n",
				replacement:
					"\t\tconst placed = () => Result.flatMap(entry(), (prepared) => prepared.prepared.place())\n",
				why: "Each level of a role's compile places its members' writes again, as each level placed them before: an unformed role's entries are placed twice, and the search fails."
			}
		]
	})

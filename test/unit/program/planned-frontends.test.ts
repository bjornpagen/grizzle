/**
 * A ChangeSet's front end is compiled once across its workload's plan and its login's served compile
 * (program/workload/planned.ts PlannedFrontends): the plan compiles the front end of every ChangeSet of a workload over
 * a role, under every context's claims (program/workload/compile.ts planWorkload), and the served compile of the
 * ChangeSet's variant in which every fill context holds a fact, over artifacts of the plan's basis, with the plan's
 * clock binding and source, prepares its write over that front end (change.ts preparedVariants, write/program/compile.ts
 * preparedWrite), where it compiled it again: the front end reads no installed name, so the plan's over unserved
 * parameter types is the one the served compile's over planned types would build. edullm's ledger compiled each of its
 * ChangeSets' front ends twice, its `evaluate`'s 190 s each time.
 *
 * The box, drawn (prepared-levels.fixtures.ts): a login of one to three roles, each writing a span primary key (Room),
 * its mutable twin (Hold) and a scalar key (Plain), its workload one to all four of Room's insert, Hold's put, Plain's
 * insert and Plain's put, planned and then compiled at READ COMMITTED, and SERIALIZABLE where a member has no READ
 * COMMITTED form.
 *
 * Property 1, per case: the served compile takes the front end the plan compiled of each member and compiles none of its
 * own (planned.ts take): no ChangeSet's front end is compiled as the login compiles (the calls of
 * write/frontend/compile.ts compileChangeSet, counted, test/support/kernel/calls.ts), and once it has compiled, the plan
 * holds none of its members' front ends, each taken once, so each dies with the compile that read it. Oracle:
 * specification, one front end per ChangeSet and set of fill contexts across the plan and the served compile, taken
 * once. Kills: the served compile reads no planned front end, so it compiles each again; a take leaves the front end in
 * the plan, which holds every one through the served round.
 *
 * Property 2, per case: the login served over its plan's front ends compiles what it compiles with none (planned.ts
 * noPlannedFrontends), each compiled write's statements and their SQL, entry for entry. Oracle: a second
 * implementation, the served compile that compiles every front end itself. Kill: the plan keeps one front end for every
 * program of a role, so a role of two programs serves one program's front end for the other.
 *
 * Property 3, per case: the footprints a served file compiled over a snapshot routes its live reads by
 * (program/workload/compile.ts loginFootprints) are the workload plan's (compileWorkload `footprints`), read with no
 * ChangeSet's front end compiled: the analyses made under the laws' evidence, read once by each write analysis, are
 * none, where the plan made one for each ChangeSet (adapter/served/compile.ts snapshotCompiled planned the whole
 * workload to read its footprints, the login's ChangeSets compiled already). Oracle: a second implementation, the
 * workload plan. Kill: the footprint plan compiles each ChangeSet's front end, as the whole plan did.
 *
 * Features: one program, several programs of a role.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { silentPhases } from "#compiler/core/phase.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { readCommittedChanges, type ServableEntry } from "#compiler/program/workload/change.ts"
import { compileWorkload, loginFootprints } from "#compiler/program/workload/compile.ts"
import { noPlannedFrontends } from "#compiler/program/workload/planned.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	changeLoginOf,
	entriesOf,
	footprintsLoginOf,
	rolesGen
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "one program" | "several programs of a role"

/** Each entry's served statements, their texts, parts and slots, in order, as text. */
const sqlOf = (entries: ReadonlyArray<ServableEntry>): ReadonlyArray<string> =>
	Arr.map(entries, (entry) => Formatter.format(entry.compiled.statements))

/** The served compile takes each member's front end from its workload's plan, and compiles none of its own. */
export const theServedCompileTakesEachMembersFrontEndFromItsWorkloadsPlanAndCompilesNoneOfItsOwn =
	property.explore(rolesGen, {
		needs: {},
		situations: ["one program", "several programs of a role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const login = changeLoginOf(drawn)
				const [roles, counts] = yield* callCounts(
					Effect.sync(() =>
						succeeded(readCommittedChanges(login, silentPhases), "the login's compile")
					),
					{
						frontEnds: {
							file: "packages/engine/src/write/frontend/compile.ts",
							name: "compileChangeSet"
						}
					}
				)
				assert.equal(counts.frontEnds, 0, "no member's front end compiled: each the plan's")
				for (const [i, held] of drawn.entries()) {
					c.note(held.length === 1 ? "one program" : "several programs of a role")
					const compiled = roles.get(`writer${i}`)
					assert.ok(compiled !== undefined, `role writer${i} compiled`)
					for (const program of compiled.changes.members.keys()) {
						assert.equal(
							login.planned.take({
								laws: compiled.changes.artifacts.laws,
								login: login.named.owned.name,
								role: compiled.changes.named.owned.name,
								program,
								clock: noClock,
								source: login.clock
							}),
							undefined,
							`${program}: its plan's front end taken, the plan holding it no more`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "one front end per ChangeSet and set of fill contexts across its plan and its served compile, taken once"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\t\tconst planned = login.planned.take({\n",
				replacement: "\t\t\tconst planned = undefined && login.planned.take({\n",
				why: "The served compile reads no planned front end and compiles every member's again from its value, as it did: a front end is compiled for every member, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/planned.ts",
				original: "\t\tthis.#planned.delete(place)\n",
				replacement: "",
				why: "A take leaves the front end in the plan, which holds every one through the served round, as it held them: a member's front end is the plan's still once the login compiled, and the search fails."
			}
		]
	})

/** A login served over its plan's front ends compiles what it compiles with none. */
export const aLoginServedOverItsPlansFrontEndsCompilesWhatItCompilesWithNone = property.explore(
	rolesGen,
	{
		needs: {},
		situations: ["one program", "several programs of a role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				const login = changeLoginOf(drawn)
				const over = succeeded(
					readCommittedChanges(login, silentPhases),
					"served over the plan's front ends"
				)
				const alone = succeeded(
					readCommittedChanges({ ...login, planned: noPlannedFrontends }, silentPhases),
					"served compiling every front end"
				)
				for (const [i, held] of drawn.entries()) {
					c.note(held.length === 1 ? "one program" : "several programs of a role")
					const name = `writer${i}`
					const planned = over.get(name)
					const compiled = alone.get(name)
					assert.ok(planned !== undefined && compiled !== undefined, `role ${name} compiled`)
					assert.equal(planned.kind, compiled.kind, `${name}'s form`)
					assert.equal(
						planned.changes.members.size,
						compiled.changes.members.size,
						`${name}'s members`
					)
					for (const [program, variants] of planned.changes.members) {
						const other = compiled.changes.members.get(program)
						assert.ok(other !== undefined, `${program} compiled alone`)
						assert.deepEqual(
							sqlOf(entriesOf(variants)),
							sqlOf(entriesOf(other)),
							`${program}: every statement's SQL`
						)
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the served compile compiling every front end itself"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/planned.ts",
				original: `const placeOf = (key: FrontendKey): string => \`\${key.login}\\u0000\${key.role}\\u0000\${key.program}\``,
				replacement: `const placeOf = (key: FrontendKey): string => \`\${key.login}\\u0000\${key.role}\``,
				why: "The plan keeps one front end for every program of a role, its last, so a role of several programs serves that program's front end for every other, whose statements are another ChangeSet's, and the search fails."
			}
		]
	}
)

/** A login's footprints, read as its workload's plan reads them, compile no ChangeSet's front end. */
export const aLoginsFootprintsReadAsItsWorkloadsPlanReadsThemCompileNoChangeSetsFrontEnd =
	property.explore(rolesGen, {
		needs: {},
		situations: ["one program", "several programs of a role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				c.note(
					Arr.some(drawn, (held) => held.length > 1) ? "several programs of a role" : "one program"
				)
				const { built, artifacts, owned } = footprintsLoginOf(drawn)
				let analyses = 0
				const { theory } = artifacts.laws
				const watched = {
					...artifacts,
					laws: {
						...artifacts.laws,
						theory: {
							...theory,
							get evidence() {
								analyses += 1
								return theory.evidence
							}
						}
					}
				}
				const footprints = succeeded(
					Result.mapError(loginFootprints(built.workload, built.base, watched), (r) => r.error),
					"the login's footprints"
				)
				assert.equal(analyses, 0, "no ChangeSet's front end compiled for the footprints")
				const plan = succeeded(
					Result.mapError(
						compileWorkload([{ login: owned.name, workloads: built.workload }], built.base, {
							artifacts: watched
						}),
						(r) => r.error
					),
					"the workload's plan"
				)
				assert.ok(analyses >= drawn.flat().length, "the plan compiles every ChangeSet's front end")
				const planned = plan.footprints.get(owned.name)
				assert.ok(planned !== undefined, "the plan's footprints of the login")
				assert.deepEqual(
					[...footprints],
					[...planned],
					"the plan's footprints, program for program"
				)
			}),
		oracle: { kind: "second-implementation", name: "the workload plan's footprints" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: '\t\tcase "answered":\n\t\tcase "changeSet":\n\t\t\treturn Result.ok([])\n',
				replacement:
					'\t\tcase "answered":\n\t\t\treturn Result.ok([])\n\t\tcase "changeSet":\n\t\t\treturn Result.map(changeSetIr(program.changeSet, reads.world.kind === "role" ? reads.world.checked : reads.artifacts.derived.schema, reads, clock), () => [])\n',
				why: "The footprint plan compiles each ChangeSet's front end, as the whole workload plan did for the footprints it read, so the footprints' analyses are one per ChangeSet, and the search fails."
			}
		]
	})

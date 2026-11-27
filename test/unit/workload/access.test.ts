/**
 * The served workload's access (program/workload/compile.ts servedAccess): the snapshot records each program's access
 * under its name, the same for one program under any name, and asks exactly the paths its programs' bound statements
 * read through (sql/plan.ts planRequests), whatever the programs are named or in what order the workload lists them.
 *
 * The programs are the worked example's (workload/fixtures.ts workPrograms), drawn into workloads under drawn names,
 * each served through the fixture's login (fixtures.ts servedOf), as generate serves it.
 *
 * Oracle: the specification (each program's access by name, one program's alike under any name, and exactly the paths
 * its programs request, a differential against the same programs under their own names in the fixture's order).
 *
 * Features: a program under two names, a path several programs request.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { pathOf } from "#compiler/physical/access/paths.ts"
import { succeeded } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import {
	named,
	pathLabel,
	type PlanFeature,
	workloadGen
} from "#test/unit/workload/access.fixtures.ts"
import { fixtureLogin, servedOf } from "#test/unit/workload/fixtures.ts"

/**
 * The served workload records each program's access by name and asks exactly the paths its programs' statements read
 * through.
 *
 * Budget: its suite's count before the conversion (unit/workload/extract-planned: 30 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theServedWorkloadRecordsEachProgramsAccessByNameAndAsksExactlyThePathsItsProgramsRead =
	property.explore(workloadGen, {
		needs: {},
		situations: [
			"a program under two names",
			"a path several programs request"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (_, c: Case<PlanFeature>) => (entries) =>
			Effect.sync(() => {
				const p = succeeded(
					servedOf(W.Work, Rec.fromEntries(Arr.map(entries, (e) => [e.name, e.program]))),
					"the drawn workload serves"
				)
				const access = defined(p.access[fixtureLogin], "the login's programs' access")
				unorderedEqual(
					Rec.keys(access),
					Arr.map(entries, (e) => e.name)
				)
				const programs = Rec.toEntries(access)
				for (const a of entries) {
					for (const b of entries) {
						if (a.source === b.source) {
							assert.deepEqual(access[a.name], access[b.name], `${a.name} and ${b.name}`)
						}
					}
				}
				if (new Set(Arr.map(entries, (e) => e.source)).size < entries.length) {
					c.note("a program under two names")
				}
				/** Every program's path is an asked path, and every asked path is some program's. */
				const paths = Arr.map(p.requests, (r) => pathOf(r, false))
				const asked = new Set(Arr.map(paths, pathLabel))
				for (const [name, x] of programs) {
					for (const path of x.paths) {
						assert.ok(asked.has(pathLabel(path)), name)
					}
				}
				for (const j of paths) {
					const requesting = Arr.filter(programs, ([, x]) =>
						Arr.some(x.paths, (q) => pathLabel(q) === pathLabel(j))
					)
					assert.ok(requesting.length > 0, pathLabel(j))
					if (requesting.length > 1) {
						c.note("a path several programs request")
					}
				}
				/** The same programs under their own names, in the fixture's order, ask the same. */
				const sources = new Set(Arr.map(entries, (e) => e.source))
				const reference = succeeded(
					servedOf(W.Work, Rec.fromEntries(Arr.filter(named, ([source]) => sources.has(source)))),
					"the reference workload serves"
				)
				assert.deepEqual(
					Arr.map(paths, pathLabel),
					Arr.map(reference.requests, (r) => pathLabel(pathOf(r, false)))
				)
			}),
		oracle: {
			kind: "specification",
			name: "the served access records each program's access by name and asks exactly what its programs read through, whatever their names and order"
		},
		budget: { runs: 30, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/value.ts",
				original:
					'): Workload<S, P> => {\n\tif (extra.length > 0) {\n\t\tthrow malformed(label, "workload(schema, programs): two arguments")',
				replacement:
					'): Workload<S, P> => {\n\tif (extra.length <= 0) {\n\t\tthrow malformed(label, "workload(schema, programs): two arguments")',
				why: "Operator mutant (comparison) at packages/engine/src/program/workload/value.ts:428 in workload: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

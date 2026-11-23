/**
 * Access-path extraction and the workload plan (physical/access, program/workload): the plan records each program's
 * access under its name, the same for one program under any name, and plans exactly the paths its programs request,
 * whatever the programs are named or in what order the workload lists them.
 *
 * The programs are the worked example's (workload/fixtures.ts workPrograms), drawn into workloads under drawn names.
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
import * as W from "#test/support/fixtures/api/work.ts"
import {
	named,
	pathIdentity,
	pathLabel,
	type PlanFeature,
	workloadGen
} from "#test/unit/workload/extract.fixtures.ts"
import { fixtureLogin, planOf } from "#test/unit/workload/fixtures.ts"

/**
 * The workload plan records each program's access by name and plans exactly the paths its programs request.
 *
 * Budget: its suite's count before the conversion (unit/workload/extract-planned: 30 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWorkloadPlanRecordsEachProgramsAccessByNameAndPlansExactlyThePathsItsProgramsRequest =
	property.explore(workloadGen, {
		needs: {},
		situations: [
			"a program under two names",
			"a path several programs request"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (_, c: Case<PlanFeature>) => (entries) =>
			Effect.sync(() => {
				const p = planOf(W.Work, Rec.fromEntries(Arr.map(entries, (e) => [e.name, e.program])))
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
				/** Every program's path is a planned path, and every planned path is some program's. */
				const planned = new Set(Arr.map(p.paths, pathIdentity))
				for (const [name, x] of programs) {
					for (const path of x.paths) {
						assert.ok(planned.has(pathIdentity(path)), name)
					}
				}
				for (const j of p.paths) {
					const requesting = Arr.filter(programs, ([, x]) =>
						Arr.some(x.paths, (q) => pathIdentity(q) === pathIdentity(j))
					)
					assert.ok(requesting.length > 0, pathLabel(j))
					if (requesting.length > 1) {
						c.note("a path several programs request")
					}
				}
				/** The same programs under their own names, in the fixture's order, plan the same. */
				const sources = new Set(Arr.map(entries, (e) => e.source))
				const reference = planOf(
					W.Work,
					Rec.fromEntries(Arr.filter(named, ([source]) => sources.has(source)))
				)
				assert.deepEqual(p.paths, reference.paths)
			}),
		oracle: {
			kind: "specification",
			name: "the plan records each program's access by name and plans exactly what its programs request, whatever their names and order"
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

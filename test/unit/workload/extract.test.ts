/**
 * Access-path extraction and the workload plan (physical/access, program/workload): the plan records each program's
 * access under its name, the same for one program under any name, and plans exactly the paths and statistics its
 * programs request, whatever the programs are named or in what order the workload lists them; and statistics over one
 * column set merge.
 *
 * The programs are the worked example's (workload/fixtures.ts workPrograms), drawn into workloads under drawn names.
 *
 * Oracles: the specification for the plan (each program's access by name, one program's alike under any name, and
 * exactly the paths and statistics its programs request, a differential against the same programs under their own
 * names in the fixture's order); a second implementation for mergeStatistics (the union of each column set's kinds and
 * uses, in canonical order).
 *
 * Features: a program under two names, a path several programs request, statistics several programs request.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import type { StatisticsShape } from "#compiler/ir/products.ts"
import {
	mergeStatistics,
	statisticsKinds,
	type StatisticsRequest
} from "#compiler/physical/statistics/statistics.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import {
	compareColumns,
	named,
	pathIdentity,
	pathLabel,
	type PlanFeature,
	sortedUnique,
	statisticsGen,
	workloadGen
} from "#test/unit/workload/extract.fixtures.ts"
import { fixtureLogin, planOf, W } from "#test/unit/workload/fixtures.ts"

/** The workload plan records each program's access by name and plans exactly the paths and statistics its programs request. */
export const theWorkloadPlanRecordsEachProgramsAccessByNameAndPlansExactlyThePathsAndStatisticsItsProgramsRequest =
	property.explore(workloadGen, {
		needs: {},
		situations: [
			"a program under two names",
			"a path several programs request",
			"statistics several programs request"
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
				/** Every program's statistics are a planned request's column set, and every request is some program's. */
				const sameSet = (
					q: StatisticsShape,
					s: { readonly relation: string; readonly columns: ReadonlyArray<string> }
				) => q.relation === s.relation && Arr.join(q.columns, ",") === Arr.join(s.columns, ",")
				for (const [name, x] of programs) {
					for (const q of x.statistics) {
						assert.ok(
							Arr.some(p.statistics, (s) => sameSet(q, s)),
							name
						)
					}
				}
				for (const s of p.statistics) {
					const requesting = Arr.filter(programs, ([, x]) =>
						Arr.some(x.statistics, (q) => sameSet(q, s))
					)
					assert.ok(requesting.length > 0, `${s.relation} (${Arr.join(s.columns, ", ")})`)
					if (requesting.length > 1) {
						c.note("statistics several programs request")
					}
				}
				/** The same programs under their own names, in the fixture's order, plan the same. */
				const sources = new Set(Arr.map(entries, (e) => e.source))
				const reference = planOf(
					W.Work,
					Rec.fromEntries(Arr.filter(named, ([source]) => sources.has(source)))
				)
				assert.deepEqual(p.paths, reference.paths)
				assert.deepEqual(p.statistics, reference.statistics)
			}),
		oracle: {
			kind: "specification",
			name: "the plan records each program's access by name and plans exactly what its programs request, whatever their names and order"
		},
		kept: [],
		kills: []
	})

/** MergeStatistics makes one request per column set, with the union of its kinds and uses, in canonical order. */
export const mergeStatisticsMakesOneRequestPerColumnSetWithTheUnionOfItsKindsAndUsesInCanonicalOrder =
	property.explore(array(statisticsGen, { min: 0, max: 6 }), {
		needs: {},
		situations: [],
		check: () => (requests) =>
			Effect.sync(() => {
				const distinctSets = [
					...new Map(
						Arr.map(requests, (r) => [`${r.relation} ${Arr.join(r.columns, ",")}`, r] as const)
					).values()
				]
				type ColumnSet = {
					readonly relation: string
					readonly columns: ReadonlyArray<string>
				}
				const sets = Arr.sort(
					distinctSets,
					Order.combine(
						Order.mapInput(Order.String, (r: ColumnSet) => r.relation),
						Order.mapInput(compareColumns, (r: ColumnSet) => r.columns)
					)
				)
				const expected = Arr.map(sets, (set): StatisticsRequest => {
					const over = Arr.filter(
						requests,
						(r) =>
							r.relation === set.relation && Arr.join(r.columns, ",") === Arr.join(set.columns, ",")
					)
					return {
						relation: set.relation,
						columns: set.columns,
						kinds: Arr.filter(statisticsKinds, (k) => Arr.some(over, (r) => r.kinds.includes(k))),
						uses: sortedUnique(Arr.flatMap(over, (r) => r.uses))
					}
				})
				assert.deepEqual(mergeStatistics(requests), expected)
			}),
		oracle: {
			kind: "second-implementation",
			name: "one request per column set, the union of its kinds and uses, in canonical order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/statistics.ts",
				original:
					"\t\t\tkinds: statisticsKinds.filter((k) => prior.kinds.includes(k) || r.kinds.includes(k)),",
				replacement: "\t\t\tkinds: prior.kinds,",
				why: "A merged statistics request keeps its first request's kinds alone."
			}
		]
	})

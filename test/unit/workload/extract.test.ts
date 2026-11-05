import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, filter, type Gen, subarray, uniqueArray } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { AccessPath, StatisticsShape } from "#compiler/ir/products.ts"
import {
	mergeStatistics,
	type StatisticsRequest,
	type StatisticsUse,
	statisticsKinds
} from "#compiler/physical/statistics/statistics.ts"
import { assert, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { fixtureLogin, planOf, W, workPrograms } from "#test/unit/workload/fixtures.ts"

import { regex } from "arkregex"
/**
 * Access-path extraction and the workload plan (physical/access, program/workload): the plan records each program's
 * access under its name, the same for one program under any name, and plans exactly the paths and statistics its
 * programs request, whatever the programs are named or in what order the workload lists them; and statistics over one
 * column set merge.
 *
 * The programs are the worked example's (workload/fixtures.ts workPrograms), drawn into workloads under drawn names.
 */

const sortedUnique = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.sort([...new Set(values)], Order.String)

/**
 * A readable label of a path, `task(account, priority desc, id) btree for page seek`: its method decides its keys'
 * operator class.
 */
const pathLabel = (p: AccessPath): string => {
	const keys = Arr.map(p.keys, (k) => (k.dir === "desc" ? `${k.field} desc` : k.field))
	return `${p.relation}(${Arr.join(keys, ", ")}) ${p.method} for ${p.use}`
}

/** A path's identity: its label and whether it is on a derived relation. */
const pathIdentity = (p: AccessPath): string => `${pathLabel(p)}${p.derived ? " (derived)" : ""}`

const named = nonEmpty(Rec.toEntries(workPrograms), "the worked example's programs")

/** A workload of drawn programs under drawn names, a program possibly under several. */
const workloadGen = (source: Source) =>
	Arr.map(
		source.draw(
			uniqueArray(
				matching(regex("^[a-z][a-zA-Z0-9]{0,5}$")),
				(name) => name,
				{ min: 1, max: 6 },
				20
			)
		),
		(name) => {
			const [programSource, program] = source.draw(element(named))
			return { name, source: programSource, program }
		}
	)

type PlanFeature =
	| "a program under two names"
	| "a path several programs request"
	| "statistics several programs request"

describe("the workload plan", () => {
	it.effect(
		"records each program's access by name and plans exactly the paths and statistics its programs request",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/extract-planned",
						draw: drawn(workloadGen),
						literal: Formatter.format,
						coverage: required<PlanFeature>(
							[
								"a program under two names",
								"a path several programs request",
								"statistics several programs request"
							],
							{ cases: 30, sense: notesOnly }
						),
						kept: [],
						runs: 30,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(entries, c) =>
						Effect.sync(() => {
							const p = planOf(
								W.Work,
								Rec.fromEntries(Arr.map(entries, (e) => [e.name, e.program]))
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
							) =>
								q.relation === s.relation && Arr.join(q.columns, ",") === Arr.join(s.columns, ",")
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
						})
				)
			)
	)
})

/** A non-empty selection of `values`, in their order. */
const someOf = <A>(values: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	filter(subarray(values), (picked) => picked.length > 0, 100)

const statisticsGen: Gen<StatisticsRequest> = (source) => ({
	relation: source.draw(element(["Task", "Note"])),
	columns: source.draw(
		element([
			["account", "kind"],
			["account", "kind", "priority"],
			["account", "priority"],
			["kind", "priority"]
		])
	),
	kinds: source.draw(someOf(statisticsKinds)),
	uses: source.draw(someOf<StatisticsUse>(["correlated selection", "grouping"]))
})

/** Of two column lists one of which begins the other, the longer first. */
const compareColumns: Order.Order<ReadonlyArray<string>> = (a, b) => {
	const [x, ...xs] = a
	const [y, ...ys] = b
	if (x === undefined || y === undefined) {
		return Order.Number(b.length, a.length)
	}
	return x === y ? compareColumns(xs, ys) : Order.String(x, y)
}

describe("mergeStatistics", () => {
	it.effect(
		"makes one request per column set, with the union of its kinds and uses, in canonical order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/extract-merge",
						draw: drawn(array(statisticsGen, { min: 0, max: 6 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(requests) =>
						Effect.sync(() => {
							const distinctSets = [
								...new Map(
									Arr.map(
										requests,
										(r) => [`${r.relation} ${Arr.join(r.columns, ",")}`, r] as const
									)
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
										r.relation === set.relation &&
										Arr.join(r.columns, ",") === Arr.join(set.columns, ",")
								)
								return {
									relation: set.relation,
									columns: set.columns,
									kinds: Arr.filter(statisticsKinds, (k) =>
										Arr.some(over, (r) => r.kinds.includes(k))
									),
									uses: sortedUnique(Arr.flatMap(over, (r) => r.uses))
								}
							})
							assert.deepEqual(mergeStatistics(requests), expected)
						})
				)
			)
	)
})

/** What the properties of extract.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, subset, uniqueKeys } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { AccessPath } from "#compiler/ir/products.ts"
import {
	statisticsKinds,
	type StatisticsRequest,
	type StatisticsUse
} from "#compiler/physical/statistics/statistics.ts"
import { workPrograms } from "#test/unit/workload/fixtures.ts"

export const sortedUnique = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.sort([...new Set(values)], Order.String)

/**
 * A readable label of a path, `task(account, priority desc, id) btree for page seek`: its method decides its keys'
 * operator class.
 */
export const pathLabel = (p: AccessPath): string => {
	const keys = Arr.map(p.keys, (k) => (k.dir === "desc" ? `${k.field} desc` : k.field))
	return `${p.relation}(${Arr.join(keys, ", ")}) ${p.method} for ${p.use}`
}

/** A path's identity: its label and whether it is on a derived relation. */
export const pathIdentity = (p: AccessPath): string =>
	`${pathLabel(p)}${p.derived ? " (derived)" : ""}`

export const named = nonEmpty(Rec.toEntries(workPrograms), "the worked example's programs")

/** A workload of drawn programs under drawn names, a program possibly under several. */
export const workloadGen = (source: Source) =>
	Arr.map(
		source.draw(uniqueKeys(matching(regex("^[a-z][a-zA-Z0-9]{0,5}$")), { min: 1, max: 6 })),
		(name) => {
			const [programSource, program] = source.draw(element(named))
			return { name, source: programSource, program }
		}
	)

export type PlanFeature =
	| "a program under two names"
	| "a path several programs request"
	| "statistics several programs request"

/** A non-empty selection of `values`, in their order, drawn as one: its size first, from one. */
const someOf = <A>(values: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	subset(values, { min: 1, max: values.length })

export const statisticsGen: Gen<StatisticsRequest> = (source) => ({
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
export const compareColumns: Order.Order<ReadonlyArray<string>> = (a, b) => {
	const [x, ...xs] = a
	const [y, ...ys] = b
	if (x === undefined || y === undefined) {
		return Order.Number(b.length, a.length)
	}
	return x === y ? compareColumns(xs, ys) : Order.String(x, y)
}

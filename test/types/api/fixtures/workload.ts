import { ChangeSet, type Workload, workload, query, relation, schema, uuid, v } from "#index.ts"
import { AccountCost, Reports, Task, Work } from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * The query workload: the named queries, ordered queries, ChangeSets and relation keys the application runs, each
 * over the schema or a level below it, kept exactly as written. Every `@ts-expect-error -- TSnnnn` names the
 * diagnostic the harness requires on the next line.
 */
const tasksOf = query(Work).rule((r) => {
	const { id } = v(Task)
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})
const newest = tasksOf.orderBy(["id", "desc"])
const addTasks = ChangeSet.empty(Work).insert(Task, [])
const costs = query(Reports).rule((r) => {
	const { account, total } = v(AccountCost)
	return r.match(AccountCost, { account, total }).find({ account, total })
})

/** The programs record keeps every program's own type under its name. */
export const workWorkload = workload(Work, { tasksOf, newest, addTasks })
export type WorkWorkload = Expect<
	Equals<
		typeof workWorkload,
		Workload<
			typeof Work,
			{
				readonly tasksOf: typeof tasksOf
				readonly newest: typeof newest
				readonly addTasks: typeof addTasks
			}
		>
	>
>
/** An extension's workload names programs over the extension and over every level below it. */
export const reportsWorkload = workload(Reports, { tasksOf, costs })
export type ReportsPrograms = Expect<
	Equals<keyof (typeof reportsWorkload)["programs"], "tasksOf" | "costs">
>

// @ts-expect-error -- TS2322: a program over the extension is over no level of Work
export const aboveBase = workload(Work, { costs })
const Other = schema("Other", { Thing: relation("Thing", { id: uuid }, ["id"]) }, [])
const things = query(Other).rule((r) => {
	const { id } = v(Other.relations.Thing)
	return r.match(Other.relations.Thing, { id }).find({ id })
})
// @ts-expect-error -- TS2322: a program over another schema
export const otherSchema = workload(Work, { things })
// @ts-expect-error -- TS2345: the programs are a record of names, not a list
export const programList = workload(Work, [tasksOf])

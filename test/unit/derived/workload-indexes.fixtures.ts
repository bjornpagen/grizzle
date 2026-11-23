/** What the properties of workload-indexes.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { alterationStatement } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { compareOps } from "#compiler/ir/desc.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { keyTermText } from "#compiler/physical/indexes/engine.ts"
import { type Installation } from "#compiler/physical/install/compile.ts"
import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { IndexKey, SqlStatement } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, type FixtureSchema, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { asDrafted, type CompileOver } from "#test/support/migrate/kit.ts"

/** Reports with AccountBudget redefined: the automatic tasks with a budget above 10 only. */
const automaticBudgetOfBusy = query(W.Work).rule((r) => {
	const { id, account } = v(W.Task, "task")
	const { budget } = v(W.AutomaticTask, "automaticTask")
	return r
		.match(W.Task, { id, account, kind: "Automatic" })
		.match(W.AutomaticTask, { task: id, budget })
		.where(r.gt(budget, 10n))
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

const BusyBudget = derived.materialized("AccountBudget", automaticBudgetOfBusy)

export const Redefined = schema.extend([W.Work], "Reports", [BusyBudget], [])

/** The view's columns: its key, its count, a natural, and its computed numeric, each with a parameter type it compares to. */
const viewColumns = { account: Id, tasks: natural, budget: pg.numeric(38, 0) } as const

type ViewColumn = keyof typeof viewColumns

const columnNames: Arr.NonEmptyReadonlyArray<ViewColumn> = nonEmpty(
	Rec.keys(viewColumns),
	"the view's columns"
)

/** The comparisons a B-tree serves: every one but `ne`. */
const servedOps = nonEmpty(
	Arr.filter(compareOps, (op) => op !== "ne"),
	"the comparisons a B-tree serves"
)

/** A program: the column it compares and the comparison, by its position among those a B-tree serves. */
interface Program {
	readonly column: ViewColumn
	readonly op: number
}

export const programGen: Gen<Program> = (source) => ({
	column: Arr.getUnsafe(columnNames, source.draw(int(0, columnNames.length - 1))),
	op: source.draw(int(0, servedOps.length - 1))
})

/** The program over a definition of AccountBudget: the original, or the redefinition. */
const programOf = (p: Program, redefined: boolean) => {
	const over = redefined ? Redefined : W.Reports
	const view = redefined ? BusyBudget : W.AccountBudget
	const op = Arr.getUnsafe(servedOps, p.op)
	return queryOver(over).rule((r: RuleValue) => {
		const vars = varsOver(view, "accountBudget")
		return r
			.match(view, vars)
			.where(r[op](vars[p.column], r.param("bound", viewColumns[p.column])))
			.find(vars)
	})
}

export const programsOf = (
	programs: ReadonlyArray<Program>,
	redefined: boolean
): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(Arr.map(programs, (p, i) => [`program${i}`, programOf(p, redefined)] as const))

export const planOf = (
	schemaValue: FixtureSchema,
	programs: Readonly<Record<string, unknown>>
): WorkloadPlan =>
	succeeded(
		compileTestWorkload(
			[{ login: "server", workloads: [workload(schemaValue, programs)] }],
			schemaValue,
			testCompile
		)
	)

/** The columns a workload's programs take indexes of their own on: every one but the key. */
export const indexedColumns = (programs: ReadonlyArray<Program>): ReadonlyArray<ViewColumn> =>
	Arr.sort(
		Arr.dedupe(Arr.flatMap(programs, (p) => (p.column === "account" ? [] : [p.column]))),
		Order.String
	)

export const viewIndexes = (installation: Installation) =>
	Arr.filter(installation.indexes, (i) => i.relation === "AccountBudget")

/** As generate drafts the schema with the workload `plan`'s index requests. */
export const draftedWith = (plan: WorkloadPlan): CompileOver => ({
	...asDrafted,
	extensions: [workloadExtension(plan)]
})

/** The statements a draft's plan states, in its order, each with its slot. */
export const planned = (
	g: GenerateResult
): ReadonlyArray<{ readonly slot: string; readonly statement: SqlStatement }> =>
	Arr.flatMap(g.plan.steps, (step) =>
		step.draft.kind === "statement"
			? [{ slot: step.slot, statement: step.draft.statement }]
			: step.draft.kind === "alteration"
				? [
						{
							slot: step.slot,
							statement: alterationStatement(step.draft.table, step.draft.actions)
						}
					]
				: []
	)

/** AccountBudget's materialized view, as the naming door names it. */
const budgetView: string = identifierOf(identity.view(parsedName("AccountBudget")))

export const onView = (statement: SqlStatement): boolean =>
	(statement.kind === "createIndex" && statement.table.name === budgetView) ||
	(statement.kind === "createStoredTable" && statement.name.name === budgetView) ||
	(statement.kind === "drop" &&
		statement.object !== "ROLE" &&
		statement.object !== "SCHEMA" &&
		statement.name.name === budgetView)

/** The column identifier a drafted index's key holds, or none for an expression. */
export const keyIdent = (k: IndexKey): string =>
	k.key.kind === "column" ? k.key.column : "an expression"

/** The column an index key holds. */
export const keyColumn = (k: Installation["indexes"][number]["keys"][number]): string =>
	keyTermText(k.column)

export interface IndexCase {
	readonly programs: ReadonlyArray<Program>
	readonly installed: boolean
}

export type IndexFeature =
	| "an index of a column"
	| "the key's own index"
	| "two columns indexed"
	| "deferred"
	| "the empty workload"

/** Two drafts: each one's definition and workload. */
export interface DraftCase {
	readonly first: { readonly redefined: boolean; readonly programs: ReadonlyArray<Program> }
	readonly second: { readonly redefined: boolean; readonly programs: ReadonlyArray<Program> }
}

export const draftGen: Gen<DraftCase["first"]> = (source) => ({
	redefined: source.draw(boolean),
	programs: source.draw(array(programGen, { min: 0, max: 2 }))
})

export type DraftFeature =
	| "an index built concurrently"
	| "an index after its recreated view"
	| "a standing index the later draft keeps"

import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { compareOps } from "#compiler/ir/desc.ts"
import { workloadExtension, withWorkload } from "#compiler/physical/access/extension.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	asDrafted,
	type CompileOver,
	draftChain,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"

/**
 * Workload indexes on a derived relation.
 *
 * A derived relation's materialized view takes indexes from the query workload exactly as a table does: a workload request
 * on the view lands on an inherited key's unique index that serves it, merging the access into its reasons, or becomes
 * `<view>__ix__<cols>` in Indexes, justified by the access. The migration generator drafts such an index through the
 * same rules as any index: built concurrently on a view that may hold rows, and created again with a view a changed
 * definition recreates. An installation without the derived relation extension leaves the view, and so its indexes,
 * deferred.
 *
 * Each case draws a workload of programs over AccountBudget (the worked example's, or a redefinition over the busy
 * automatic tasks), each comparing a drawn column of the view, its key `account`, its count `tasks` or its computed
 * numeric `budget`, by a drawn comparison a B-tree serves to a parameter. The model: a program over the key lands on
 * the key's unique index, every other column takes one workload index of its own keyed by it, and a view not installed
 * takes none; over two drafts, the second's workload indexes are those its workload asks for that the first's did not,
 * each built concurrently, or all of them, each after the view, where a changed definition recreates the view. Read off
 * the typed plan a draft states, never its SQL text. That the index is the one the program's statement uses on
 * PostgreSQL is the database suite's (test/pg/derived/workload-index.test.ts).
 */

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
const BusyBudget = derived("AccountBudget", automaticBudgetOfBusy)
const Redefined = schema.extend(W.Work, { AccountBudget: BusyBudget }, [])

/** The view's columns: its key, its count and its computed numeric, each with a parameter type it compares to. */
const viewColumns = { account: uuid, tasks: pg.bigint, budget: pg.numeric(38, 0) } as const
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

const programGen: Gen<Program> = (source) => ({
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

const programsOf = (
	programs: ReadonlyArray<Program>,
	redefined: boolean
): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(Arr.map(programs, (p, i) => [`program${i}`, programOf(p, redefined)] as const))

const planOf = (schemaValue: unknown, programs: Readonly<Record<string, unknown>>): WorkloadPlan =>
	succeeded(
		compileTestWorkload(
			[{ login: "server", workloads: [workload(schemaValue, programs)] }],
			schemaValue,
			testCompile
		)
	)

/** The columns a workload's programs take indexes of their own on: every one but the key. */
const indexedColumns = (programs: ReadonlyArray<Program>): ReadonlyArray<ViewColumn> =>
	Arr.sort(
		Arr.dedupe(Arr.flatMap(programs, (p) => (p.column === "account" ? [] : [p.column]))),
		Order.String
	)

const viewIndexes = (installation: Installation) =>
	Arr.filter(installation.indexes, (i) => i.relation === "AccountBudget")

/** As generate drafts the schema with the workload `plan`'s index requests. */
const draftedWith = (plan: WorkloadPlan): CompileOver => ({
	...asDrafted,
	extensions: [workloadExtension(plan)]
})

/** The statements a draft's plan states, in its order, each with its slot. */
const planned = (
	g: GenerateResult
): ReadonlyArray<{ readonly slot: string; readonly statement: SqlStatement }> =>
	Arr.flatMap(g.plan.steps, (step) =>
		step.draft.kind === "statement" ? [{ slot: step.slot, statement: step.draft.statement }] : []
	)

/** AccountBudget's materialized view, as the naming door names it. */
const budgetView: string = identifierOf(identity.view(parsedName("AccountBudget")))

const onView = (statement: SqlStatement): boolean =>
	(statement.kind === "createIndex" && statement.table.name === budgetView) ||
	(statement.kind === "createMaterializedView" && statement.name.name === budgetView) ||
	(statement.kind === "drop" &&
		statement.object !== "ROLE" &&
		statement.object !== "SCHEMA" &&
		statement.name.name === budgetView)

/** The column an index key holds. */
const keyColumn = (k: Installation["indexes"][number]["keys"][number]): string =>
	k.column.kind === "field" ? k.column.field : k.column.column

interface IndexCase {
	readonly programs: ReadonlyArray<Program>
	readonly installed: boolean
}

type IndexFeature =
	| "an index of a column"
	| "the key's own index"
	| "two columns indexed"
	| "deferred"
	| "the empty workload"

/** Two drafts: each one's definition and workload. */
interface DraftCase {
	readonly first: { readonly redefined: boolean; readonly programs: ReadonlyArray<Program> }
	readonly second: { readonly redefined: boolean; readonly programs: ReadonlyArray<Program> }
}

const draftGen: Gen<DraftCase["first"]> = (source) => ({
	redefined: source.draw(boolean),
	programs: source.draw(array(programGen, { min: 0, max: 2 }))
})

type DraftFeature =
	| "an index built concurrently"
	| "an index after its recreated view"
	| "a standing index the later draft keeps"

describe("workload indexes on a derived relation", () => {
	it.effect(
		"index a view column, its key on its key index, a computed numeric's by its proved bound, and defer them with a view not installed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/workload-view-index",
						draw: drawn((source): IndexCase => ({
							programs: source.draw(array(programGen, { min: 0, max: 3 })),
							installed: source.draw(boolean)
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a program over the key lands on the key's index, any other column takes an index of its own, a deferred view none"
						},
						coverage: required<IndexFeature>(
							[
								"an index of a column",
								"the key's own index",
								"two columns indexed",
								"deferred",
								"the empty workload"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const plan = planOf(W.Reports, programsOf(c.programs, false))
							const owned = owning(W.Reports)
							const options = withWorkload(installOptions(owned, undefined), plan)
							const installation = succeeded(
								compileInstallation(owned, c.installed ? withDerivedRelations(options) : options)
							)
							if (c.programs.length === 0) {
								k.note("the empty workload")
							}
							if (!c.installed) {
								k.note("deferred")
								assert.deepEqual(installation.deferred.derivedRelations, ["AccountBudget"])
								assert.deepEqual(viewIndexes(installation), [])
								return
							}
							const indexes = viewIndexes(installation)
							const created = Arr.filter(indexes, (x) => x.index.kind === "created")
							const expected = indexedColumns(c.programs)
							if (expected.length > 0) {
								k.note("an index of a column")
							}
							if (expected.length > 1) {
								k.note("two columns indexed")
							}
							assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
								Arr.sort(
									Arr.map(created, (x) => Arr.map(x.keys, keyColumn)),
									Order.mapInput(Order.String, (keys: ReadonlyArray<string>) => Arr.join(keys, ","))
								),
								Arr.map(expected, (column) => [column])
							)
							for (const x of created) {
								assert.ok(
									Arr.every(x.requests, (r) => r.role === "access"),
									"a workload index stands on access"
								)
							}
							if (Arr.some(c.programs, (p) => p.column === "account")) {
								k.note("the key's own index")
								assert.ok(
									Arr.some(
										indexes,
										(x) =>
											x.index.kind === "installed" &&
											Arr.join(Arr.map(x.keys, keyColumn), ",") === "account" &&
											Arr.some(x.requests, (r) => r.role === "access")
									),
									"the key's unique index serves the access"
								)
							}
						})
				)
			)
	)

	it.effect(
		"build a later program's view index concurrently, and create every one again after the view a redefinition recreates",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/workload-view-drafts",
						draw: drawn((source): DraftCase => ({
							first: source.draw(draftGen),
							second: source.draw(draftGen)
						})),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a standing view takes the new indexes concurrently; a recreated one takes them all after its creation"
						},
						coverage: required<DraftFeature>(
							[
								"an index built concurrently",
								"an index after its recreated view",
								"a standing index the later draft keeps"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 30,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const draftOf = (d: DraftCase["first"]) => {
								const over = d.redefined ? Redefined : W.Reports
								return {
									desc: over,
									options: draftedWith(planOf(over, programsOf(d.programs, d.redefined))),
									declared: noDeclarations
								}
							}
							const second = defined(
								draftChain([draftOf(c.first), draftOf(c.second)], fromEmpty)[1]
							)
							const steps = Arr.filter(planned(second), (p) => onView(p.statement))
							const indexes = Arr.filter(
								steps,
								(p) => p.statement.kind === "createIndex" && !p.statement.unique
							)
							const recreated = c.first.redefined !== c.second.redefined
							const before = indexedColumns(c.first.programs)
							const after = indexedColumns(c.second.programs)
							const expected = recreated
								? after
								: Arr.filter(after, (col) => !Arr.contains(before, col))
							if (!recreated && Arr.some(after, (col) => Arr.contains(before, col))) {
								k.note("a standing index the later draft keeps")
							}
							assert.equal(
								indexes.length,
								expected.length,
								"one workload index per column the draft adds"
							)
							const view = Arr.findFirstIndex(
								steps,
								(p) => p.statement.kind === "createMaterializedView"
							)
							assert.equal(
								Option.isSome(view),
								recreated,
								"the view is created again exactly when redefined"
							)
							if (recreated) {
								assert.ok(
									Option.exists(
										Arr.findFirstIndex(steps, (p) => p.statement.kind === "drop"),
										(drop) => Option.exists(view, (created) => drop < created)
									),
									"the view is dropped before it is created again"
								)
							}
							for (const index of indexes) {
								const at = steps.indexOf(index)
								if (recreated) {
									k.note("an index after its recreated view")
									assert.ok(
										Option.exists(view, (created) => created < at),
										"a recreated view's index follows its creation"
									)
								} else {
									k.note("an index built concurrently")
									assert.ok(
										index.statement.kind === "createIndex" && index.statement.concurrently,
										"a standing view's new index is built concurrently"
									)
								}
							}
						})
				)
			)
	)
})

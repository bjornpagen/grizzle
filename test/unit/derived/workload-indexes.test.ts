import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { workloadExtension, withWorkload } from "#compiler/physical/access/extension.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, schema } from "#compiler/public/schema.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
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

/** The account budgets with at least `least` automatic tasks: a range on the view's `tasks` column.
 *
 * Workload indexes on a derived relation.
 *
 * A derived relation's materialized view takes indexes from the query workload exactly as a table does: a workload request
 * on the view lands on an inherited key's unique index that serves it, merging the access into its reasons, or becomes
 * `<view>__ix__<cols>` in Indexes, justified by the access; a request the view's column cannot index is refused as a
 * table's is. The migration generator drafts such an index through the same rules as any index: built concurrently on a
 * view that may hold rows, and created again with a view a changed definition recreates. An installation without the
 * derived relation extension leaves the view, and so its indexes, deferred.
 *
 * Each is planted, since a generated workload never ranges over a view column nor redefines a view between drafts, and
 * read off the typed plan a draft states, never its SQL text. That the index is the one the
 * program's statement uses on PostgreSQL is the database suite's. */
const busyAccounts = query(W.Reports).rule((r) => {
	const { account, tasks, budget } = v(W.AccountBudget, "accountBudget")
	return r
		.match(W.AccountBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

/**
 * A range on the view's `budget`, a numeric sum of bigint cents: a computed numeric whose proved bound, the cents'
 * digits widened by the rows', bounds its B-tree entry.
 */
const richAccounts = query(W.Reports).rule((r) => {
	const { account, tasks, budget } = v(W.AccountBudget, "accountBudget")
	return r
		.match(W.AccountBudget, { account, tasks, budget })
		.where(r.ge(budget, r.param("least", pg.numeric(38, 0))))
		.find({ account, tasks })
})

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
const busyRedefined = query(Redefined).rule((r) => {
	const { account, tasks, budget } = v(BusyBudget, "busyBudget")
	return r
		.match(BusyBudget, { account, tasks, budget })
		.where(r.ge(tasks, r.param("least", pg.bigint)))
		.find({ account, budget })
})

const planOf = (schemaValue: unknown, programs: object): WorkloadPlan =>
	succeeded(
		compileTestWorkload(
			[{ login: "server", workloads: [workload(schemaValue, programs)] }],
			schemaValue,
			testCompile
		)
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

describe("workload indexes on a derived relation", () => {
	it.effect(
		"index a view column, a computed numeric's by its proved bound, and defer both with a view not installed",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/workload-view-index",
						generator: (source) =>
							[
								source.draw(element<"tasks" | "budget">(["tasks", "budget"])),
								source.draw(element<"installed" | "deferred">(["installed", "deferred"]))
							] as const,
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<"indexed" | "deferred">(["indexed", "deferred"]),
						caseHang
					},
					([column, view], c) =>
						Effect.sync(() => {
							const plan = planOf(
								W.Reports,
								column === "tasks" ? { busyAccounts } : { richAccounts }
							)
							const owned = owning(W.Reports)
							const options = withWorkload(installOptions(owned, undefined), plan)
							const result = compileInstallation(
								owned,
								view === "installed" ? withDerivedRelations(options) : options
							)
							if (view === "deferred") {
								c.note("deferred")
								const deferred = succeeded(result)
								assert.deepEqual(deferred.deferred.derivedRelations, ["AccountBudget"])
								assert.deepEqual(viewIndexes(deferred), [])
								return
							}
							c.note("indexed")
							const index = Arr.findFirst(
								viewIndexes(succeeded(result)),
								(x) => x.index.kind === "created"
							)
							assert.ok(Option.isSome(index), "the view's workload index")
							assert.deepEqual(
								Arr.map(index.value.keys, (k) =>
									k.column.kind === "field" ? k.column.field : k.column.column
								),
								[column]
							)
							assert.ok(Arr.every(index.value.requests, (r) => r.role === "access"))
						})
				)
			)
	)

	it.effect(
		"build a later program's view index concurrently, and create it again after the view a redefinition recreates",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/workload-view-drafts",
						generator: element<"program added" | "view redefined">([
							"program added",
							"view redefined"
						]),
						literal: Formatter.format,
						limit: 2,
						coverage: requiredInSpace<"program added" | "view redefined">([
							"program added",
							"view redefined"
						]),
						caseHang
					},
					(change, c) =>
						Effect.sync(() => {
							c.note(change)
							const busy = planOf(W.Reports, { busyAccounts })
							const second =
								change === "program added"
									? defined(
											draftChain(
												[
													{ desc: W.Reports, options: asDrafted, declared: noDeclarations },
													{ desc: W.Reports, options: draftedWith(busy), declared: noDeclarations }
												],
												fromEmpty
											)[1]
										)
									: defined(
											draftChain(
												[
													{ desc: W.Reports, options: draftedWith(busy), declared: noDeclarations },
													{
														desc: Redefined,
														options: draftedWith(
															planOf(Redefined, { busyAccounts: busyRedefined })
														),
														declared: noDeclarations
													}
												],
												fromEmpty
											)[1]
										)
							const steps = Arr.filter(planned(second), (p) => onView(p.statement))
							/** The workload index, the view's one index that is no unique key index. */
							const indexes = Arr.filter(
								steps,
								(p) => p.statement.kind === "createIndex" && !p.statement.unique
							)
							assert.equal(indexes.length, 1, "one workload index on the view")
							const [index] = indexes
							if (change === "program added") {
								assert.equal(steps.length, 1)
								assert.ok(index?.statement.kind === "createIndex" && index.statement.concurrently)
								return
							}
							/** A recreated view is empty: its index follows its creation, which follows its drop. */
							const at = (kind: SqlStatement["kind"]) =>
								Arr.findFirstIndex(steps, (p) => p.statement.kind === kind)
							const view = at("createMaterializedView")
							assert.ok(
								Option.exists(at("drop"), (drop) =>
									Option.exists(view, (created) => drop < created)
								)
							)
							assert.ok(
								Option.exists(
									view,
									(created) => created < steps.indexOf(defined(index, "the workload index"))
								)
							)
						})
				)
			)
	)
})

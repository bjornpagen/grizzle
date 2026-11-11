/**
 * The worked example's arm switch end to end, in both forms, against a model of the switch, exhausted over its inputs,
 * straight to the server.
 *
 * Work installs with its facts and its alternatives, two native containments per armed handle, and its full role
 * switches a task to manual through its login's served workload, each form a member of it. The box is every stored kind
 * of task the facts hold and one no fact holds (t1 automatic in account a1, t4 automatic in a2, t2 manual by Ruth, t7
 * manual by Sam, and a missing id) by the form, the operator (Ruth, Sam) and, for the enumerated form, the previous
 * budget (the stored one, or a stale one). The oracle is a model of the switch over the stored facts:
 *
 * - Enumerated members, a put of the parent among them: on an automatic task with its budget, accepted with Task put 1,
 *   AutomaticTask deleted 1 and ManualTask added 1 (as a set of counts), its read-backs the replaced Task as removed old
 *   plus added new, the removed budget fact and the added arm; with a stale budget the deletion matches nothing, the
 *   remaining arm's tagged composite foreign key fails at COMMIT, and the call is refused with the
 *   Automatic arm's law, a native violation whose witness carries no key; on a manual task the put and the deletion
 *   change nothing, so its own operator is unchanged and another one the key law of ManualTask, witnessed by the task's
 *   key; on a missing task the switch creates it, manual, with its arm.
 * - Members described by queries, applied with parameters: they read stored relations, so on an automatic task the
 *   switch is the enumerated one with the stored budget, and on a manual or missing task every member is empty,
 *   unchanged with empty read-backs.
 *
 * The stored state afterwards is the model's: the facts with the switched task's rows replaced, or as they were after a
 * refusal. The deleted and reinserted Task key leaves TaskNote's reference, deferred, satisfied: t1 has a note.
 *
 * Features: each form over each kind of task, by its outcome.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): arm-switch-put-counted-added.patch (an accepted write's puts counted
 * as additions).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, sameLaw } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { alternatives } from "#compiler/public/schema.ts"
import { quoteString } from "#compiler/sql/print.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, bareRecord, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { Cents } from "#test/support/fixtures/api/contracts.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t2, t4, t7, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { recordEntryOf } from "#test/support/oracle/pick.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Work as the fixture declares it, the schema the login's workload members are written over. */
type Work = typeof W.Work

/**
 * Read-backs of what a switch did: the Task facts it removed and added, and the arms, on the empty ChangeSet each form
 * adds its members to.
 */
const withReads = (s: Work) =>
	ChangeSet.empty(s)
		.read("tasks", (d) =>
			query(s)
				.rule((r) => {
					const { id, account, kind } = v(W.Task, "task")
					return r
						.match(d.added(W.Task), { id, account, kind })
						.find({ side: "added", id, account, kind })
				})
				.rule((r) => {
					const { id, account, kind } = v(W.Task, "task")
					return r
						.match(d.removed(W.Task), { id, account, kind })
						.find({ side: "removed", id, account, kind })
				})
		)
		.read("previous", (d) =>
			query(s).rule((r) => {
				const { task, budget } = v(d.removed(W.AutomaticTask), "removedAutomaticTask")
				return r.match(d.removed(W.AutomaticTask), { task, budget }).find({ task, budget })
			})
		)
		.read("manual", (d) =>
			query(s).rule((r) => {
				const { task, operator } = v(W.ManualTask, "manualTask")
				return r.match(d.added(W.ManualTask), { task, operator }).find({ task, operator })
			})
		)

/**
 * The enumerated switch: the parent put and the arm changes as listed members, array members whose facts each call
 * gives.
 */
const switchToManual = (s: Work) =>
	withReads(s).put(W.Task, []).delete(W.AutomaticTask, []).insert(W.ManualTask, [])

/** The described switch, its members queries over the stored relations, applied with parameters. */
const switchToManualDescribed = (s: Work) =>
	withReads(s)
		.put(
			W.Task,
			query(s).rule((r) => {
				const { account } = v(W.Task, "task")
				return r
					.match(W.Task, { id: r.param("task", W.Task.fields.id), account, kind: "Automatic" })
					.find({ id: r.param("task", W.Task.fields.id), account, kind: "Manual" })
			})
		)
		.delete(
			W.AutomaticTask,
			query(s).rule((r) => {
				const { budget } = v(W.AutomaticTask, "automaticTask")
				return r
					.match(W.AutomaticTask, { task: r.param("task", W.AutomaticTask.fields.task), budget })
					.find({ task: r.param("task", W.AutomaticTask.fields.task), budget })
			})
		)
		.insert(
			W.ManualTask,
			query(s).rule((r) =>
				r.match(W.Task, { id: r.param("task", W.Task.fields.id), kind: "Automatic" }).find({
					task: r.param("task", W.ManualTask.fields.task),
					operator: r.param("operator", W.ManualTask.fields.operator)
				})
			)
		)

type TaskKind = "automatic" | "manual" | "missing"
type Form = "enumerated" | "described"
type Budget = "stored" | "stale"

interface Switch {
	readonly task: Uuid
	readonly form: Form
	readonly budget: Budget
	readonly operator: "Ruth" | "Sam"
}

const tasks = [t1, t4, t2, t7, tMissing] as const

const forms: Arr.NonEmptyReadonlyArray<Form> = ["enumerated", "described"]
const budgets: Arr.NonEmptyReadonlyArray<Budget> = ["stored", "stale"]
const operators: Arr.NonEmptyReadonlyArray<Switch["operator"]> = ["Ruth", "Sam"]

/** Every switch: the task outermost, then the form, the budget for the enumerated form alone, and the operator. */
const switches: Gen<Switch> = (source) => {
	const task = source.draw(element(tasks))
	const form = source.draw(element(forms))
	const budget = form === "enumerated" ? source.draw(element(budgets)) : "stored"
	const operator = source.draw(element(operators))
	return { task, form, budget, operator }
}

type SwitchFeature = `${Form} ${TaskKind} ${"accepted" | "unchanged" | "rejected"}`

/** The stored facts of one task: its Task fact and its arm, as workFacts holds them. */
const taskFact = (id: string) => Arr.findFirst(workFacts.Task, (t) => t.id === id)
const automaticOf = (id: string) => Arr.findFirst(workFacts.AutomaticTask, (a) => a.task === id)
const manualOf = (id: string) => Arr.findFirst(workFacts.ManualTask, (m) => m.task === id)

const counts = (relation: string, added: bigint, deleted: bigint, put: bigint) => ({
	relation,
	added,
	deleted,
	put
})

layer(Substrate.layer, { excludeTestServices: true })(
	"the worked example's arm switch end to end",
	(it) => {
		it.effect(
			"both forms of the switch agree with its model over every kind of task, operator and budget",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {
								enumerated: switchToManual(W.Work),
								described: switchToManualDescribed(W.Work)
							}
						})
						const s = yield* Substrate
						const names = namesOf(o.installed)
						/** The worked example's alternatives, rebuilt through the builders, which names the same laws. */
						const laws = lawNamesOf(W.Work)
						const automaticArm = recordEntryOf(
							laws.alternativesOf(
								alternatives(W.Task, "kind", W.Kind, {
									Automatic: W.AutomaticTask,
									Manual: W.ManualTask
								})
							).arms,
							"Automatic",
							"the alternatives' arms"
						)
						const task = names.table(W.Task)
						const automatic = names.table(W.AutomaticTask)
						const manual = names.table(W.ManualTask)
						/**
						 * The task's rows as workFacts holds them, in one transaction, the alternatives law holding at its end;
						 * its kind as the code its column stores.
						 */
						const restore = (id: string) => {
							const t = taskFact(id)
							const a = automaticOf(id)
							const m = manualOf(id)
							const lit = quoteString
							return transaction(s.admin, [
								`DELETE FROM ${manual} WHERE ${names.column(W.ManualTask, "task")} = ${lit(id)}::uuid`,
								`DELETE FROM ${automatic} WHERE ${names.column(W.AutomaticTask, "task")} = ${lit(id)}::uuid`,
								Option.match(t, {
									onNone: () =>
										`DELETE FROM ${task} WHERE ${names.column(W.Task, "id")} = ${lit(id)}::uuid`,
									onSome: (fact) =>
										`UPDATE ${task} SET ${names.column(W.Task, "kind")} = ${names.code(W.Kind, fact.kind)}, ${names.column(W.Task, "account")} = ${lit(fact.account)}::uuid WHERE ${names.column(W.Task, "id")} = ${lit(id)}::uuid`
								}),
								...Option.toArray(
									Option.map(
										a,
										(arm) =>
											`INSERT INTO ${automatic} (${names.column(W.AutomaticTask, "task")}, ${names.column(W.AutomaticTask, "budget")}) VALUES (${lit(id)}::uuid, ${String(arm.budget)})`
									)
								),
								...Option.toArray(
									Option.map(
										m,
										(arm) =>
											`INSERT INTO ${manual} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES (${lit(id)}::uuid, ${lit(arm.operator)})`
									)
								)
							])
						}
						const state = Effect.all({
							Task: tableState(o.installed, W.Task),
							AutomaticTask: tableState(o.installed, W.AutomaticTask),
							ManualTask: tableState(o.installed, W.ManualTask)
						})
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* exhaust(
								{
									box: "every kind of task the facts hold and a missing one, by form, operator and the enumerated form's budget",
									oracle: {
										kind: "second-implementation",
										name: "a model of the switch over the stored facts: its outcome, counts, read-backs and state after"
									},
									suite: "e2e/arm-switch",
									generator: switches,
									literal: Formatter.format,
									limit: 30,
									caseHang,
									coverage: requiredInSpace<SwitchFeature>([
										"enumerated automatic accepted",
										"enumerated automatic rejected",
										"enumerated manual unchanged",
										"enumerated manual rejected",
										"enumerated missing accepted",
										"described automatic accepted",
										"described manual unchanged",
										"described missing unchanged"
									])
								},
								(w, c) =>
									Effect.gen(function* () {
										yield* restore(w.task)
										const before = yield* state
										const stored = taskFact(w.task)
										const budget = automaticOf(w.task)
										const kind = Option.match(stored, {
											onNone: (): TaskKind => "missing",
											onSome: (fact): TaskKind =>
												fact.kind === "Automatic" ? "automatic" : "manual"
										})
										const account = Option.match(stored, {
											onNone: () => a1,
											onSome: (fact) => fact.account
										})
										/** A stale budget is one the task does not hold; a manual or missing task holds none. */
										const previousBudget = Option.match(budget, {
											onNone: () => 1500n,
											onSome: (held) => (w.budget === "stored" ? held.budget : held.budget + 100n)
										})
										const outcome = yield* w.form === "enumerated"
											? answered(
													db.workload.enumerated.once({
														params: {},
														facts: {
															put: { Task: [{ id: w.task, account, kind: "Manual" }] },
															delete: {
																AutomaticTask: [{ task: w.task, budget: Cents(previousBudget) }]
															},
															insert: { ManualTask: [{ task: w.task, operator: w.operator }] }
														}
													})
												)
											: answered(
													db.workload.described.once({
														params: { task: w.task, operator: w.operator },
														facts: {}
													})
												)
										const after = yield* state
										/** The facts with the switched task's rows replaced. */
										const switched = {
											Task: [
												...Arr.filter(before.Task, (t) => t["id"] !== w.task),
												{ id: w.task, account, kind: "Manual" }
											],
											AutomaticTask: Arr.filter(before.AutomaticTask, (t) => t["task"] !== w.task),
											ManualTask: [
												...Arr.filter(before.ManualTask, (t) => t["task"] !== w.task),
												{ task: w.task, operator: w.operator }
											]
										}
										const unchanged = () => {
											unorderedEqual(after.Task, before.Task)
											unorderedEqual(after.AutomaticTask, before.AutomaticTask)
											unorderedEqual(after.ManualTask, before.ManualTask)
										}
										const accepted = (expected: ReadonlyArray<ReturnType<typeof counts>>) => {
											assert.ok(outcome.kind === "accepted", outcome.kind)
											unorderedEqual(
												Arr.map(outcome.counts, (n) => ({ ...n })),
												[...expected]
											)
											unorderedEqual(after.Task, switched.Task)
											unorderedEqual(after.AutomaticTask, switched.AutomaticTask)
											unorderedEqual(after.ManualTask, switched.ManualTask)
											c.note(`${w.form} ${kind} accepted`)
											return outcome.reads
										}
										if (
											kind === "automatic" &&
											Option.isSome(budget) &&
											Option.isSome(stored) &&
											(w.form === "described" || w.budget === "stored")
										) {
											const reads = accepted([
												counts("AutomaticTask", 0n, 1n, 0n),
												counts("ManualTask", 1n, 0n, 0n),
												counts("Task", 0n, 0n, 1n)
											])
											unorderedEqual(reads.tasks, [
												bareRecord({ side: "added", id: w.task, account, kind: "Manual" }),
												bareRecord({ side: "removed", id: w.task, account, kind: "Automatic" })
											])
											assert.deepEqual(reads.previous, [
												bareRecord({ task: w.task, budget: Cents(budget.value.budget) })
											])
											assert.deepEqual(reads.manual, [
												bareRecord({ task: w.task, operator: w.operator })
											])
											return
										}
										if (kind === "automatic") {
											assert.ok(outcome.kind === "refused", outcome.kind)
											const refused = refusedLaws(outcome.refused)
											assert.ok(
												refused.length === 1 &&
													Arr.every(refused, (law) => sameLaw(law, names.described(automaticArm))),
												`refused by the Automatic arm's law alone: ${Formatter.format(refused)}`
											)
											assert.deepEqual(outcome.witness, { kind: "unreported" })
											unchanged()
											c.note(`${w.form} ${kind} rejected`)
											return
										}
										if (w.form === "described") {
											assert.ok(outcome.kind === "unchanged", outcome.kind)
											assert.deepEqual(outcome.reads.previous, [])
											assert.deepEqual(outcome.reads.tasks, [])
											assert.deepEqual(outcome.reads.manual, [])
											unchanged()
											c.note(`${w.form} ${kind} unchanged`)
											return
										}
										if (kind === "missing") {
											const reads = accepted([
												counts("AutomaticTask", 0n, 0n, 0n),
												counts("ManualTask", 1n, 0n, 0n),
												counts("Task", 0n, 0n, 1n)
											])
											assert.deepEqual(reads.tasks, [
												bareRecord({
													side: "added" as const,
													id: w.task,
													account,
													kind: "Manual" as const
												})
											])
											assert.deepEqual(reads.previous, [])
											assert.deepEqual(reads.manual, [
												bareRecord({ task: w.task, operator: w.operator })
											])
											return
										}
										if (Option.exists(manualOf(w.task), (held) => held.operator === w.operator)) {
											assert.ok(outcome.kind === "unchanged", outcome.kind)
											unchanged()
											c.note(`${w.form} ${kind} unchanged`)
											return
										}
										assert.ok(outcome.kind === "refused", outcome.kind)
										assert.deepEqual(refusedLaws(outcome.refused), [
											{
												kind: "primaryKey",
												relation: "ManualTask",
												fields: ["task"]
											}
										])
										assert.deepEqual(outcome.witness, {
											kind: "key",
											relation: "ManualTask",
											values: { task: w.task }
										})
										unchanged()
										c.note(`${w.form} ${kind} rejected`)
									})
							)
						}).pipe(
							Effect.scoped,
							(body) =>
								Effect.flatMap(Layer.build(o.served.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)

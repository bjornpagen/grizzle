import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteString } from "#compiler/core/text.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import {
	automaticArm,
	automaticOf,
	counts,
	manualOf,
	switches,
	type SwitchFeature,
	taskFact,
	type TaskKind,
	workInstall,
	workTemplate
} from "#test/pg/e2e/arm-switch.fixtures.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { assert, bareRecord, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { Cents } from "#test/support/fixtures/api/contracts.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { untilAnswered } from "#test/support/transient.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * The worked example's arm switch end to end both forms of the switch agree with its model over every kind of task, operator and budget.
 */
export const theWorkedExamplesArmSwitchEndToEndBothFormsOfTheSwitchAgreeWithItsModelOverEveryKindOfTaskOperatorAndBudget =
	property.exhaust(finite(switches), {
		needs: { fixture: Substrate.seat(workTemplate) },
		situations: [
			"enumerated automatic accepted",
			"enumerated automatic rejected",
			"enumerated manual unchanged",
			"enumerated manual rejected",
			"enumerated missing accepted",
			"described automatic accepted",
			"described manual unchanged",
			"described missing unchanged"
		] satisfies ReadonlyArray<Reached<SwitchFeature>>,
		check:
			({ fixture }, c: Case<SwitchFeature>) =>
			(w) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(W.Work, workFacts, workInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
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

									yield* restore(w.task)
									const before = yield* state
									const stored = taskFact(w.task)
									const budget = automaticOf(w.task)
									const kind = Option.match(stored, {
										onNone: (): TaskKind => "missing",
										onSome: (fact): TaskKind => (fact.kind === "Automatic" ? "automatic" : "manual")
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
									const outcome = yield* untilAnswered(
										w.form === "enumerated"
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
												),
										() => undefined
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
										assert.deepEqual(reads.tasksAdded, [
											bareRecord({ id: w.task, account, kind: "Manual" as const })
										])
										assert.deepEqual(reads.tasksRemoved, [
											bareRecord({ id: w.task, account, kind: "Automatic" as const })
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
										assert.deepEqual(outcome.reads.tasksAdded, [])
										assert.deepEqual(outcome.reads.tasksRemoved, [])
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
										assert.deepEqual(reads.tasksAdded, [
											bareRecord({ id: w.task, account, kind: "Manual" as const })
										])
										assert.deepEqual(reads.tasksRemoved, [])
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
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the switch over the stored facts: its outcome, counts, read-backs and state after"
		},
		box: "every kind of task the facts hold and a missing one, by form, operator and the enumerated form's budget",
		kept: [],
		kills: []
	})

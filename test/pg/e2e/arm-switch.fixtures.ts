/** What the properties of arm-switch.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { alternatives } from "#compiler/public/schema.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t1, t2, t4, t7, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { recordEntryOf } from "#test/support/oracle/pick.ts"

/** Work as the fixture declares it, the schema the login's workload members are written over. */
type Work = typeof W.Work

/**
 * Read-backs of what a switch did: the Task facts it removed and added, and the arms, on the empty ChangeSet each form
 * adds its members to.
 */
const withReads = (s: Work) =>
	ChangeSet.empty(s)
		.read("tasksAdded", (d) =>
			query(s).rule((r) => {
				const { id, account, kind } = v(W.Task, "task")
				return r.match(d.added(W.Task), { id, account, kind }).find({ id, account, kind })
			})
		)
		.read("tasksRemoved", (d) =>
			query(s).rule((r) => {
				const { id, account, kind } = v(W.Task, "task")
				return r.match(d.removed(W.Task), { id, account, kind }).find({ id, account, kind })
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

export type TaskKind = "automatic" | "manual" | "missing"

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
export const switches: Gen<Switch> = (source) => {
	const task = source.draw(element(tasks))
	const form = source.draw(element(forms))
	const budget = form === "enumerated" ? source.draw(element(budgets)) : "stored"
	const operator = source.draw(element(operators))
	return { task, form, budget, operator }
}

export type SwitchFeature = `${Form} ${TaskKind} ${"accepted" | "unchanged" | "rejected"}`

/** The stored facts of one task: its Task fact and its arm, as workFacts holds them. */
export const taskFact = (id: string) => Arr.findFirst(workFacts.Task, (t) => t.id === id)

export const automaticOf = (id: string) =>
	Arr.findFirst(workFacts.AutomaticTask, (a) => a.task === id)

export const manualOf = (id: string) => Arr.findFirst(workFacts.ManualTask, (m) => m.task === id)

export const counts = (relation: string, added: bigint, deleted: bigint, put: bigint) => ({
	relation,
	added,
	deleted,
	put
})

/** The worked example's alternatives, rebuilt through the builders, which names the same laws. */
const laws = lawNamesOf(W.Work)

export const automaticArm = recordEntryOf(
	laws.alternativesOf(
		alternatives(W.Task, "kind", W.Kind, {
			Automatic: W.AutomaticTask,
			Manual: W.ManualTask
		})
	).arms,
	"Automatic",
	"the alternatives' arms"
)

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const workInstall = Object.freeze({
	label: "real",
	programs: {
		enumerated: switchToManual(W.Work),
		described: switchToManualDescribed(W.Work)
	}
})

/** W.Work installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const workTemplate = fixtureTemplate(import.meta, W.Work, workInstall)

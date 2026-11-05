import { Array as Arr } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import {
	alternatives,
	check,
	closed,
	closedWith,
	contained,
	f,
	field,
	ge,
	key,
	literal,
	mutable,
	on,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"
import * as work from "#test/support/fixtures/ir/work.ts"

/** The evolving schemas of the deployment tests: each version exercises migration object rules against the one
 * before it. */
const Cents = f.contract("Cents", f.bigint, ge(value, literal(0n)))
/** The contract's predicate tightened: its domain's one constraint replaced in place. */
const CentsV2 = f.contract("Cents", f.bigint, ge(value, literal(1n)))

const Kind = closed("Kind", ["Automatic", "Manual"])
const Priority = closed("Priority", ["low", "high"])
/** A handle added between the existing ones. */
const PriorityV2 = closed("Priority", ["low", "medium", "high"])
const AccountName = f.regex("^.{1,200}$", "su")

const Account = relation("Account", { id: f.uuid, name: AccountName }, ["id"])
const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, ["id"])
const automatic = (budget: FieldDesc) =>
	relation("AutomaticTask", { task: f.uuid, budget }, ["task"])
const ManualTask = relation("ManualTask", { task: f.uuid, operator: f.wildcard }, ["task"])

/** Version 1: tables and a containment; no residual law yet. */
export const shopV1: SchemaDesc = {
	name: "Shop",
	relations: [Kind, Account, Task, automatic(Cents), ManualTask],
	statements: [contained(on("Task", ["account"]), on("Account", ["id"]))],
	extends: undefined
}

/** Version 2: the alternatives law over existing tables (tags, a composite key, tagged references and the residual
 * reverse obligation), a field added, a candidate key, a row check, the contract tightened, a closed relation added,
 * and Task declared mutable. */
export const shopV2: SchemaDesc = {
	name: "Shop",
	relations: [
		Kind,
		Priority,
		Account,
		relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind"), weight: f.integer }, [
			"id"
		]),
		automatic(CentsV2),
		ManualTask
	],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		...alternatives(Task, "kind", Kind, { Automatic: automatic(Cents), Manual: ManualTask }),
		key(on("Account", ["name"])),
		check("WeightNonNegative", "Task", ge(field("weight"), literal(0))),
		mutable("Task")
	],
	extends: undefined
}

/** Version 3: the field removed, `mutable` removed, a handle added, and a serial field added. */
export const shopV3: SchemaDesc = {
	name: "Shop",
	relations: [
		Kind,
		PriorityV2,
		relation("Account", { id: f.uuid, name: AccountName, number: f.bigserial }, ["id"]),
		Task,
		automatic(CentsV2),
		ManualTask
	],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		...alternatives(Task, "kind", Kind, { Automatic: automatic(Cents), Manual: ManualTask }),
		key(on("Account", ["name"]))
	],
	extends: undefined
}

/** The worked example's Plans with Pro's budget changed and the labels unchanged. */
export const plansRepriced = (): SchemaDesc => ({
	...work.PlansDesc,
	relations: Arr.map(work.PlansDesc.relations, (r) =>
		r.kind === "closed" && r.name === "Tier"
			? closedWith(
					"Tier",
					["Free", "Pro"],
					{ budget: work.CentsDesc },
					{ Free: { budget: 100n }, Pro: { budget: 2000n } }
				)
			: r
	)
})

/** The worked example's Plans with Tier's budget a plain bigint and Pro's budget `pro`: a payload no refinement constrains, so a
 * change to it has nothing to validate. */
export const plainPlans = (pro: bigint): SchemaDesc => ({
	...work.PlansDesc,
	relations: Arr.map(work.PlansDesc.relations, (r) =>
		r.kind === "closed" && r.name === "Tier"
			? closedWith(
					"Tier",
					["Free", "Pro"],
					{ budget: f.bigint },
					{ Free: { budget: 100n }, Pro: { budget: pro } }
				)
			: r
	)
})

/** A schema whose Entry changes a field's type, its primary key and a field's name, and whose Note is renamed. */
export const books1: SchemaDesc = {
	name: "Books",
	relations: [
		relation("Entry", { id: f.uuid, book: f.uuid, amount: f.integer, memo: f.wildcard }, ["id"]),
		relation("Note", { id: f.uuid, body: f.wildcard }, ["id"])
	],
	statements: [],
	extends: undefined
}

export const books2: SchemaDesc = {
	name: "Books",
	relations: [
		relation("Entry", { id: f.uuid, book: f.uuid, amount: f.bigint, remark: f.wildcard }, [
			"id",
			"book"
		]),
		relation("Remark", { id: f.uuid, body: f.wildcard }, ["id"])
	],
	statements: [key(on("Entry", ["book"]))],
	extends: undefined
}

/** Version 4 of the shop: a third Kind handle and its arm, which changes the alternatives law for a reason other
 * than `mutable`: its function and triggers replaced in place in its Validate transaction. */
const Kind3 = closed("Kind", ["Automatic", "Manual", "Scheduled"])
const ScheduledTask = relation("ScheduledTask", { task: f.uuid, at: f.bigint }, ["task"])
export const shopV4: SchemaDesc = {
	...shopV3,
	relations: [
		Kind3,
		PriorityV2,
		relation("Account", { id: f.uuid, name: AccountName, number: f.bigserial }, ["id"]),
		Task,
		automatic(CentsV2),
		ManualTask,
		ScheduledTask
	],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		...alternatives(Task, "kind", Kind3, {
			Automatic: automatic(Cents),
			Manual: ManualTask,
			Scheduled: ScheduledTask
		}),
		key(on("Account", ["name"]))
	]
}

/** One relation of two integer columns. */
export const withB: SchemaDesc = {
	name: "Recol",
	relations: [relation("R0", { a: f.integer, b: f.integer }, ["a"])],
	statements: [],
	extends: undefined
}

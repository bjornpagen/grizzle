import { Array as Arr } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import {
	alternatives,
	check,
	closed,
	closedRelation,
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
import { parsedName } from "#test/support/kernel/naming.ts"

/** The evolving schemas of the deployment tests: each version exercises migration object rules against the one
 * before it. */
const Cents = f.contract("Cents", f.bigint, ge(value, literal(0n)))
/** The contract's predicate tightened: its domain's one constraint replaced in place. */
const CentsV2 = f.contract("Cents", f.bigint, ge(value, literal(1n)))

const Kind = closed("Kind", ["Automatic", "Manual"])
const Priority = closed("Priority", ["low", "high"])
/** A handle appended: a roster's order is its codes' order, so a new handle comes last. */
const PriorityV2 = closed("Priority", ["low", "high", "medium"])
const AccountName = f.regex("^.{1,200}$", "su")

const Account = relation("Account", { id: f.uuid, name: AccountName }, ["id"])
const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, ["id"])
const automatic = (budget: FieldDesc) =>
	relation("AutomaticTask", { task: f.uuid, budget }, ["task"])
const ManualTask = relation("ManualTask", { task: f.uuid, operator: f.wildcard }, ["task"])

/** Version 1: tables and a containment; no alternatives yet. */
export const shopV1: SchemaDesc = {
	name: "Shop",
	relations: [Kind, Account, Task, automatic(Cents), ManualTask],
	statements: [contained(on("Task", ["account"]), on("Account", ["id"]))],
	extends: undefined
}

/** Version 2: the alternatives over existing tables (each arm's containment into its parent and each handle's reverse
 * containment), a field added, a candidate key, a row check, the contract tightened, a roster added, and Task declared
 * mutable. */
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
		alternatives(Task, "kind", Kind, { Automatic: automatic(Cents), Manual: ManualTask }),
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
		alternatives(Task, "kind", Kind, { Automatic: automatic(Cents), Manual: ManualTask }),
		key(on("Account", ["name"]))
	],
	extends: undefined
}

/** What shopV3 declares against shopV2, the one drop it makes: Task.weight (`--drop Task.weight`). */
export const shopV3Declared: Declarations = {
	renames: [],
	drops: [{ kind: "field", relation: parsedName("Task"), field: parsedName("weight") }]
}

/** The worked example's Plans with TierBudget's budget `budget` and Pro's row `pro`, the roster Tier unchanged. */
const plansWith = (budget: FieldDesc, pro: bigint): SchemaDesc => ({
	...work.PlansDesc,
	relations: Arr.map(work.PlansDesc.relations, (r) =>
		r.kind === "closedRelation" && r.name === "TierBudget"
			? closedRelation(
					"TierBudget",
					{ tier: f.closedId("Tier"), budget },
					["tier"],
					[
						{ tier: "Free", budget: 100n },
						{ tier: "Pro", budget: pro }
					]
				)
			: r
	)
})

/** The worked example's Plans with TierBudget's budget a plain bigint and Pro's budget `pro`: a payload no refinement
 * constrains, so a change to it has nothing to validate. */
export const plainPlans = (pro: bigint): SchemaDesc => plansWith(f.bigint, pro)

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

/** What books2 declares against books1, its two renames: Note to Remark, and Entry's memo to remark. */
export const books2Declared: Declarations = {
	renames: [
		{
			from: { kind: "relation", relation: parsedName("Note") },
			to: { kind: "relation", relation: parsedName("Remark") }
		},
		{
			from: { kind: "field", relation: parsedName("Entry"), field: parsedName("memo") },
			to: { kind: "field", relation: parsedName("Entry"), field: parsedName("remark") }
		}
	],
	drops: []
}

/** Version 4 of the shop: a third Kind handle, appended, and its arm, which adds that arm's containment and its
 * handle's reverse containment. */
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
		alternatives(Task, "kind", Kind3, {
			Automatic: automatic(Cents),
			Manual: ManualTask,
			Scheduled: ScheduledTask
		}),
		key(on("Account", ["name"]))
	]
}


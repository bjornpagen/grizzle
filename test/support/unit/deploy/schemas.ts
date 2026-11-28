import { Array as Arr } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { Bit, closedId, generated, bool, int4 } from "#compiler/public/fields.ts"
import * as api from "#compiler/public/schema.ts"
import {
	type AuthoredStatementDesc,
	check,
	closed,
	closedRelation,
	contained,
	eq,
	f,
	field,
	ge,
	key,
	literal,
	mirrors,
	mutable,
	on,
	onWhere,
	relation,
	type SchemaDesc,
	unit,
	value
} from "#test/support/fixtures/ir/desc.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

/** The evolving schemas of the deployment tests: each version exercises migration object rules against the one
 * before it. */
const Cents = f.contract("Cents", f.bigint, ge(value, literal(0n)))
/** The contract's predicate tightened: its domain's one constraint replaced in place. */
const CentsV2 = f.contract("Cents", f.bigint, ge(value, literal(1n)))

const Kind = closed.ordered("Kind", ["Automatic", "Manual"])
const Priority = closed.ordered("Priority", ["low", "high"])
/** A handle appended: a roster's order is its codes' order, so a new handle comes last. */
const PriorityV2 = closed.ordered("Priority", ["low", "high", "medium"])
const AccountName = f.regex("^.{1,200}$", "su")

const Account = relation("Account", { id: f.uuid, name: AccountName }, ["id"])
const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, ["id"])
const automatic = (budget: FieldDesc) =>
	relation("AutomaticTask", { task: f.uuid, budget }, ["task"])
const ManualTask = relation("ManualTask", { task: f.uuid, operator: f.wildcard }, ["task"])

/** A kind's arm mirrored with the tasks of that kind: each such task has exactly its arm's row. */
const kindArm = (arm: string, kind: string): ReadonlyArray<AuthoredStatementDesc> =>
	mirrors(on(arm, ["task"]), onWhere("Task", ["id"], eq(field("kind"), literal(kind))))

/** The two kinds' arms. */
export const taskKinds: ReadonlyArray<AuthoredStatementDesc> = [
	...kindArm("AutomaticTask", "Automatic"),
	...kindArm("ManualTask", "Manual")
]

/** Version 1: tables and a containment; no kind's arm yet. */
export const shopV1: SchemaDesc = {
	name: "Shop",
	relations: [Kind, Account, Task, automatic(Cents), ManualTask],
	statements: [contained(on("Task", ["account"]), on("Account", ["id"]))],
	bases: []
}

/** Task open: mutable inside Entity, the unit of its id, which Account sits in too; a version that changes Task in place
 * states these. */
export const openTask: ReadonlyArray<AuthoredStatementDesc> = [
	unit("Entity", { id: f.uuid }),
	mutable("Task")
]

/** Version 2: each kind's arm over existing tables (the arm's containment in its kind's tasks and theirs in the arm),
 * a field added, a candidate key, a row check, the contract tightened, a roster added, and Task open. */
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
		...taskKinds,
		key(on("Account", ["name"])),
		check("WeightNonNegative", "Task", ge(field("weight"), literal(0))),
		...openTask
	],
	bases: []
}

/** Version 3: the field removed, Task closed again (openTask removed), and a handle added. */
export const shopV3: SchemaDesc = {
	name: "Shop",
	relations: [Kind, PriorityV2, Account, Task, automatic(CentsV2), ManualTask],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		...taskKinds,
		key(on("Account", ["name"]))
	],
	bases: []
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
	bases: []
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
	bases: []
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

/** Version 4 of the shop: a third Kind handle, appended, and its arm, which adds that arm's containment in its kind's
 * tasks and theirs in the arm. */
const Kind3 = closed.ordered("Kind", ["Automatic", "Manual", "Scheduled"])
const ScheduledTask = relation("ScheduledTask", { task: f.uuid, at: f.bigint }, ["task"])
export const shopV4: SchemaDesc = {
	...shopV3,
	relations: [Kind3, PriorityV2, Account, Task, automatic(CentsV2), ManualTask, ScheduledTask],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		...taskKinds,
		...kindArm("ScheduledTask", "Scheduled"),
		key(on("Account", ["name"]))
	]
}

/** The changes a set's schema's second version makes to its table alone, each leaving the roster's bits domain as it
 * was: its CHECK's membership test, or its generated field's, reads its two flags the other way round. */
export const setChanges = ["its CHECK", "its generated field"] as const
export type SetChange = (typeof setChanges)[number]

/**
 * A set's schema, its first version or a second one making `version`'s change: Flag, a roster of three handles; Tagged,
 * rows of a flag and another, its generated `covered` whether the other's singleton is within the flag's; and Admitted,
 * Tagged's CHECK that the flag's singleton is within the other's. Each is a membership test, which reads one bit of the
 * other singleton (lower/conservative/expr memberTest), a literal cast to Flag's bits domain, which no column of Tagged
 * is typed by, so only the casts name it; the test reads no constant and holds two bytes of literal data, so it stays
 * in Tagged's own statement (physical/ddl/row-functions.ts).
 */
export const setsSchema = (version: "first" | SetChange) => {
	const Flag = api.closed.ordered("Flag", ["x", "y", "z"])
	const Tagged = api.relation.generated(
		"Tagged",
		{ id: int4, flag: closedId(Flag), other: closedId(Flag) },
		["id"],
		(r) => ({
			covered: generated(
				bool,
				version === "its generated field"
					? Bit.subset(Bit.singleton(r.flag), Bit.singleton(r.other))
					: Bit.subset(Bit.singleton(r.other), Bit.singleton(r.flag))
			)
		})
	)
	return api.schema(
		"Sets",
		[Flag, Tagged],
		[
			api.check("Admitted", Tagged, (t) =>
				t.eq(
					version === "its CHECK"
						? Bit.subset(Bit.singleton(t.other), Bit.singleton(t.flag))
						: Bit.subset(Bit.singleton(t.flag), Bit.singleton(t.other)),
					true
				)
			)
		]
	)
}

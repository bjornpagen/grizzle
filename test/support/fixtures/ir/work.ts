/**
 * The worked example, in IR form: the Work schema, its Reports extension and the Plans schema as SchemaDescs,
 * and the example's queries as checked relational IR.
 *
 * Each query is the IR the checker produces for the example's rule, written out: one MatchRegion per rule with the
 * rule's shared variables as its heading, a ProjectSet for a plain find, a Group over the complete bound tuple for an
 * aggregate head, a Union of rule arms grouped by heading, Take over a completed order, Attach with its correlation
 * and delivered cardinality, and a Base over the materialized view of a derived relation.
 */

import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { SchemaModel } from "#test/support/fixtures/ir/build.ts"

import {
	alternatives,
	closed,
	closedRelation,
	contained,
	decodedQuery,
	decodedSchema,
	f,
	ge,
	literal,
	mutable,
	on,
	relation,
	value
} from "#test/support/fixtures/ir/desc.ts"

const CentsDesc = f.contract("Cents", f.bigint, ge(value, literal(0n)))
const Name = f.wildcard
/** The account name's anchored pattern bounds it to 200 code points, so a B-tree on it is representable. */
const AccountName = f.regex("^.{1,200}$", "su")

const Kind = closed("Kind", ["Automatic", "Manual"])
const Account = relation("Account", { id: f.uuid, name: AccountName }, ["id"])
const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, ["id"])
const AutomaticTask = relation("AutomaticTask", { task: f.uuid, budget: CentsDesc }, ["task"])
const ManualTask = relation("ManualTask", { task: f.uuid, operator: Name }, ["task"])
const TaskNote = relation("TaskNote", { task: f.uuid, note: Name }, ["task"])

/** The Work alternatives expansion: its contained statement and both containments of each arm's mirrors. */
const taskKinds = alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })

/** The laws, with the alternatives helper expanded into its contained statement and both containments per arm. */
export const WorkDesc: SchemaDesc = decodedSchema({
	name: "Work",
	relations: [Kind, Account, Task, AutomaticTask, ManualTask, TaskNote],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		contained(on("TaskNote", ["task"]), on("Task", ["id"])),
		taskKinds,
		mutable("TaskNote")
	],
	extends: undefined
})

/**
 * AccountBudget is the stored automaticBudget query, in a schema.extend level. Its definition is
 * recorded as the IR below (automaticBudget); the Description's QueryDesc form belongs to the query frontend, so
 * the level carries the derived relation with the definition's head as the minimal rules stage.
 */
export const ReportsDesc: SchemaDesc = decodedSchema({
	name: "Reports",
	extends: WorkDesc,
	relations: [
		{
			kind: "derived",
			name: "AccountBudget",
			level: 1,
			storage: "materialized",
			query: decodedQuery({
				kind: "rules",
				arms: [
					{
						vars: [
							{ id: "id", origin: { relation: "Task", field: "id" } },
							{ id: "account", origin: { relation: "Task", field: "account" } },
							{ id: "budget", origin: { relation: "AutomaticTask", field: "budget" } }
						],
						matches: [
							{
								source: { kind: "relation", name: "Task" },
								bindings: {
									id: { kind: "var", var: "id" },
									account: { kind: "var", var: "account" },
									kind: literal("Automatic")
								}
							},
							{
								source: { kind: "relation", name: "AutomaticTask" },
								bindings: {
									task: { kind: "var", var: "id" },
									budget: { kind: "var", var: "budget" }
								}
							}
						],
						where: [],
						head: {
							account: { kind: "var", var: "account" },
							tasks: { kind: "aggregate", fn: "count" },
							budget: { kind: "aggregate", fn: "sum", arg: { kind: "var", var: "budget" } }
						},
						interiors: [],
						attach: []
					}
				]
			})
		}
	],
	statements: []
})

const Tier = closed("Tier", ["Free", "Pro"])

/** Each tier's budget: a closed relation keyed by its tier. */
const TierBudget = closedRelation(
	"TierBudget",
	{ tier: f.closedId("Tier"), budget: CentsDesc },
	["tier"],
	[
		{ tier: "Free", budget: 100n },
		{ tier: "Pro", budget: 1000n }
	]
)

const Subscription = relation("Subscription", { account: f.uuid, tier: f.closedId("Tier") }, [
	"account"
])

export const PlansDesc: SchemaDesc = decodedSchema({
	name: "Plans",
	relations: [Tier, TierBudget, Subscription],
	statements: [contained(on("Subscription", ["tier"]), on("Tier", ["id"]))],
	extends: undefined
})

/** The fixture schemas owned, their law models compiled and their catalogs built, with this module. */
const workFixture = ownedFixture(WorkDesc)

export const workModel = (): SchemaModel => new SchemaModel(workFixture, {})

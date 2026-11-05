/**
 * The worked example, in IR form: the Work schema, its Reports extension and the Plans schema as SchemaDescs,
 * and the example's queries as checked relational IR.
 *
 * Each query is the IR the checker produces for the example's rule, written out: one MatchRegion per rule with the
 * rule's shared variables as its heading, a ProjectSet for a plain find, a Group over the complete bound tuple for an
 * aggregate head, a Union of rule arms grouped by heading, Take over a completed order, Attach with its correlation
 * and delivered cardinality, and a Base over the materialized view of a derived relation.
 */

import { SourceLoc } from "#compiler/core/loc.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import {
	asc,
	type BuiltQuery,
	Ir,
	keyed,
	order,
	plainRegion,
	SchemaModel
} from "#test/support/fixtures/ir/build.ts"

import {
	alternatives,
	closed,
	closedWith,
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

export const CentsDesc = f.contract("Cents", f.bigint, ge(value, literal(0n)))
const Name = f.wildcard
/** The account name's anchored pattern bounds it to 200 code points, so a B-tree on it is representable. */
const AccountName = f.regex("^.{1,200}$", "su")

const Kind = closed("Kind", ["Automatic", "Manual"])
const Account = relation("Account", { id: f.uuid, name: AccountName }, ["id"])
const Task = relation("Task", { id: f.uuid, account: f.uuid, kind: f.closedId("Kind") }, ["id"])
const AutomaticTask = relation("AutomaticTask", { task: f.uuid, budget: CentsDesc }, ["task"])
const ManualTask = relation("ManualTask", { task: f.uuid, operator: Name }, ["task"])
const TaskNote = relation("TaskNote", { task: f.uuid, note: Name }, ["task"])

/** The Work alternatives expansion: its contained statement and one mirrors statement per arm. */
const taskKinds = alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })

/** The laws, with the alternatives helper expanded into its contained statement and one mirrors statement per arm. */
export const WorkDesc: SchemaDesc = decodedSchema({
	name: "Work",
	relations: [Kind, Account, Task, AutomaticTask, ManualTask, TaskNote],
	statements: [
		contained(on("Task", ["account"]), on("Account", ["id"])),
		contained(on("TaskNote", ["task"]), on("Task", ["id"])),
		...taskKinds,
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
	name: "Work",
	extends: WorkDesc,
	relations: [
		{
			kind: "derived",
			name: "AccountBudget",
			level: 1,
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

const Tier = closedWith(
	"Tier",
	["Free", "Pro"],
	{ budget: CentsDesc },
	{ Free: { budget: 100n }, Pro: { budget: 1000n } }
)

const Subscription = relation("Subscription", { account: f.uuid, tier: f.closedId("Tier") }, [
	"account"
])

export const PlansDesc: SchemaDesc = decodedSchema({
	name: "Plans",
	relations: [Tier, Subscription],
	statements: [contained(on("Subscription", ["tier"]), on("Tier", ["id"]))],
	extends: undefined
})

/** The fixture schemas owned, their law models compiled and their catalogs built, with this module. */
const workFixture = ownedFixture(WorkDesc)
const reportsFixture = ownedFixture(ReportsDesc)
const plansFixture = ownedFixture(PlansDesc)

export const workModel = (): SchemaModel => new SchemaModel(workFixture, {})

/** AccountBudget's fields inferred from the head, its key the group key. */
const reportsModel = (): SchemaModel => {
	const work = new SchemaModel(workFixture, {})
	const account = work.type("Task", "account")
	const sumType = numericValue({ digits: 38, scale: 0 })
	const countType = work.fieldType(f.bigint, SourceLoc("AccountBudget.tasks", []))
	return new SchemaModel(reportsFixture, {
		AccountBudget: {
			fields: [
				["account", account],
				["tasks", countType],
				["budget", sumType]
			],
			key: ["account"]
		}
	})
}

const plansModel = (): SchemaModel => new SchemaModel(plansFixture, {})

/**
 * match(Task, { id, account, kind: "Automatic" }).match(AutomaticTask, { task: id, budget }): the rule body the worked
 * example repeats, its variables (id, account, budget).
 */
const automaticBody = (q: Ir): RelNode => {
	const task = q.base("Task")
	return q.region(
		[
			{
				source: task,
				bind: { id: "id", account: "account" },
				constants: { kind: q.litFor(task, "kind", "Automatic") }
			},
			{ source: q.base("AutomaticTask"), bind: { task: "id", budget: "budget" }, constants: {} }
		],
		keyed([["id"]], "many")
	)
}

/** The shared id is the join; the parameter takes its type from use. */
const automaticTasksFor = (): BuiltQuery => {
	const q = new Ir(workModel())
	const task = q.base("Task")
	const automatic = q.base("AutomaticTask")
	const m = q.region(
		[
			{
				source: task,
				bind: { id: "id", account: "account" },
				constants: { kind: q.litFor(task, "kind", "Automatic") }
			},
			{ source: automatic, bind: { task: "id", budget: "budget" }, constants: {} }
		],
		conservativeMeta
	)
	const filtered = q.filter(
		m,
		q.eq(q.col(m, "account"), q.param("account", q.column(m, "account").type, "compare"))
	)
	return q.build(
		q.project(
			filtered,
			[
				["id", "id"],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/**
 * Two arms of different headings sharing the discriminant kind, a heterogeneous union delivered as one
 * statement per heading group.
 */
const taskPayloads = (): BuiltQuery => {
	const q = new Ir(workModel())
	const automaticArm = (() => {
		const task = q.base("Task")
		const m = q.region(
			[
				{
					source: task,
					bind: { id: "id", account: "account" },
					constants: { kind: q.litFor(task, "kind", "Automatic") }
				},
				{ source: q.base("AutomaticTask"), bind: { task: "id", budget: "budget" }, constants: {} }
			],
			conservativeMeta
		)
		return q.project(
			m,
			[
				["id", "id"],
				["account", "account"],
				["kind", q.lit("Automatic", q.column(task, "kind").type)],
				["budget", "budget"]
			],
			conservativeMeta
		)
	})()
	const manualArm = (() => {
		const task = q.base("Task")
		const m = q.region(
			[
				{
					source: task,
					bind: { id: "id", account: "account" },
					constants: { kind: q.litFor(task, "kind", "Manual") }
				},
				{ source: q.base("ManualTask"), bind: { task: "id", operator: "operator" }, constants: {} }
			],
			conservativeMeta
		)
		return q.project(
			m,
			[
				["id", "id"],
				["account", "account"],
				["kind", q.lit("Manual", q.column(task, "kind").type)],
				["operator", "operator"]
			],
			conservativeMeta
		)
	})()
	return q.build(q.union([automaticArm, manualArm], ["kind"], conservativeMeta))
}

/** A relation-valued parameter matched by id. */
const tasksById = (): BuiltQuery => {
	const q = new Ir(workModel())
	const wanted = q.input("ids", [["id", q.model.type("Task", "id")]])
	const m = q.region(
		[
			{ source: wanted, bind: { id: "id" }, constants: {} },
			{ source: q.base("Task"), bind: { id: "id", kind: "kind" }, constants: {} }
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["id", "id"],
				["kind", "kind"]
			],
			conservativeMeta
		)
	)
}

/** The complete binding (id, account, budget) contributes, so two equal budgets both count. */
const automaticBudgetFor = (): BuiltQuery => {
	const q = new Ir(workModel())
	const m = automaticBody(q)
	const filtered = q.filter(
		m,
		q.eq(q.col(m, "account"), q.param("account", q.column(m, "account").type, "compare"))
	)
	const g = q.group(
		filtered,
		["id", "account", "budget"],
		["account"],
		[
			{ name: "tasks", agg: "count" },
			{ name: "budget", agg: "sum", arg: q.col(filtered, "budget") }
		],
		conservativeMeta
	)
	return q.build(g)
}

/**
 * The three largest budgets per account, the order completed by the retained task id; bound to the
 * outer account variable, the take is correlated and lowers LATERAL.
 */
const largestPerAccount = (): BuiltQuery => {
	const q = new Ir(workModel())
	const outer = q.b.reserve()
	const account = q.base("Account")
	/** largestBudgets.bind({ account }): the rule with r.param("account", uuid) replaced by the outer variable. */
	const task = q.base("Task")
	const automatic = q.base("AutomaticTask")
	const outerAccount = q.outerCol(outer, "account", q.model.type("Account", "id"))
	const inner = q.region(
		[
			{
				source: task,
				bind: { id: "id" },
				constants: { kind: q.litFor(task, "kind", "Automatic"), account: outerAccount }
			},
			{ source: automatic, bind: { task: "id", budget: "budget" }, constants: {} }
		],
		keyed([["id"]], "many")
	)
	const largest = q.project(
		inner,
		[
			["id", "id"],
			["budget", "budget"]
		],
		keyed([["id"]], "many")
	)
	const top = q.take(
		largest,
		order(["budget", "desc"], ["id", "asc"]),
		{ kind: "literal", k: 3n },
		keyed([["id"]], "many")
	)
	const m = q.regionWith(
		[
			{ source: account, bind: { id: "account" }, constants: {} },
			{ source: top, bind: { id: "id", budget: "budget" }, constants: {} }
		],
		conservativeMeta,
		{
			...plainRegion,
			id: { kind: "reserved", id: outer },
			heading: { kind: "named", names: ["account", "id", "budget"] }
		}
	)
	return q.build(
		q.project(
			m,
			[
				["account", "account"],
				["id", "id"],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/** The named import is inlined; the outer query introduces the parameter. */
const labeledAutomaticTasks = (): BuiltQuery => {
	const q = new Ir(workModel())
	const automaticTasks = q.project(
		automaticBody(q),
		[
			["id", "id"],
			["account", "account"],
			["budget", "budget"]
		],
		conservativeMeta
	)
	const m = q.region(
		[
			{
				source: automaticTasks,
				bind: { id: "id", account: "account", budget: "budget" },
				constants: {}
			},
			{ source: q.base("Account"), bind: { id: "account", name: "name" }, constants: {} }
		],
		conservativeMeta
	)
	const filtered = q.filter(
		m,
		q.eq(q.col(m, "account"), q.param("account", q.column(m, "account").type, "compare"))
	)
	return q.build(
		q.project(
			filtered,
			[
				["id", "id"],
				["name", "name"],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/** r.not(TaskNote, { task: id }). */
const tasksWithoutNotes = (): BuiltQuery => {
	const q = new Ir(workModel())
	const tasks = q.project(
		q.region([{ source: q.base("Task"), bind: { id: "id" }, constants: {} }], conservativeMeta),
		[["id", "id"]],
		conservativeMeta
	)
	const notes = q.project(
		q.region(
			[{ source: q.base("TaskNote"), bind: { task: "task" }, constants: {} }],
			conservativeMeta
		),
		[["task", "task"]],
		conservativeMeta
	)
	return q.build(q.anti(tasks, notes, [["id", "task"]]))
}

/** Compatible rules contribute a set union. */
const assignedTasks = (): BuiltQuery => {
	const q = new Ir(workModel())
	const arm = (kind: string) => {
		const task = q.base("Task")
		return q.project(
			q.region(
				[{ source: task, bind: { id: "id" }, constants: { kind: q.litFor(task, "kind", kind) } }],
				conservativeMeta
			),
			[["id", "id"]],
			conservativeMeta
		)
	}
	return q.build(q.union([arm("Automatic"), arm("Manual")], [], conservativeMeta))
}

/** The note is an Option by its key; the automatic arm by the alternatives law. */
const taskCards = (): BuiltQuery => {
	const q = new Ir(workModel())
	const m = q.region(
		[
			{
				source: q.base("Task"),
				bind: { id: "id", account: "account", kind: "kind" },
				constants: {}
			}
		],
		conservativeMeta
	)
	const filtered = q.filter(
		m,
		q.eq(q.col(m, "account"), q.param("account", q.column(m, "account").type, "compare"))
	)
	const parent = q.project(
		filtered,
		[
			["id", "id"],
			["kind", "kind"]
		],
		keyed([["id"]], "many")
	)
	const note = q.project(
		q.region(
			[{ source: q.base("TaskNote"), bind: { task: "task", note: "note" }, constants: {} }],
			conservativeMeta
		),
		[
			["task", "task"],
			["note", "note"]
		],
		keyed([["task"]], "many")
	)
	const automatic = q.project(
		q.region(
			[
				{ source: q.base("AutomaticTask"), bind: { task: "task", budget: "budget" }, constants: {} }
			],
			conservativeMeta
		),
		[
			["task", "task"],
			["budget", "budget"]
		],
		keyed([["task"]], "many")
	)
	const withNote = q.attach(parent, note, "note", [["id", "task"]], "option", undefined)
	return q.build(q.attach(withNote, automatic, "automatic", [["id", "task"]], "option", undefined))
}

/** The task list as a set in the declared order; the count as an Option, no row for no task. */
const accountCards = (): BuiltQuery => {
	const q = new Ir(workModel())
	const parent = q.project(
		q.region(
			[{ source: q.base("Account"), bind: { id: "id", name: "name" }, constants: {} }],
			conservativeMeta
		),
		[
			["id", "id"],
			["name", "name"]
		],
		keyed([["id"]], "many")
	)
	const tasks = q.project(
		q.region(
			[
				{
					source: q.base("Task"),
					bind: { id: "id", account: "account", kind: "kind" },
					constants: {}
				}
			],
			conservativeMeta
		),
		[
			["account", "account"],
			["id", "id"],
			["kind", "kind"]
		],
		keyed([["id"]], "many")
	)
	const counted = (() => {
		const task = q.base("Task")
		const m = q.region(
			[
				{
					source: task,
					bind: { id: "id", account: "account" },
					constants: { kind: q.litFor(task, "kind", "Automatic") }
				}
			],
			conservativeMeta
		)
		return q.group(
			m,
			["id", "account"],
			["account"],
			[{ name: "count", agg: "count" }],
			keyed([["account"]], "many")
		)
	})()
	const withTasks = q.attach(parent, tasks, "tasks", [["id", "account"]], "array", asc("id"))
	return q.build(
		q.attach(withTasks, counted, "automaticTasks", [["id", "account"]], "option", undefined)
	)
}

/** A prefix as the half-open interval [lo, hi), two comparisons. */
const accountsByPrefix = (): BuiltQuery => {
	const q = new Ir(workModel())
	const m = q.region(
		[{ source: q.base("Account"), bind: { id: "id", name: "name" }, constants: {} }],
		conservativeMeta
	)
	const nameType = q.column(m, "name").type
	const lo = q.op("ge", [q.col(m, "name"), q.param("lo", nameType, "compare")])
	const hi = q.op("lt", [q.col(m, "name"), q.param("hi", nameType, "compare")])
	const filtered = q.filter(m, q.op("and", [lo, hi]))
	return q.build(
		q.project(
			filtered,
			[
				["id", "id"],
				["name", "name"]
			],
			conservativeMeta
		)
	)
}

/** The definition of AccountBudget, parameterless. */
const automaticBudget = (): BuiltQuery => {
	const q = new Ir(workModel())
	const m = automaticBody(q)
	return q.build(
		q.group(
			m,
			["id", "account", "budget"],
			["account"],
			[
				{ name: "tasks", agg: "count" },
				{ name: "budget", agg: "sum", arg: q.col(m, "budget") }
			],
			conservativeMeta
		)
	)
}

/** A query over Reports reading the derived relation through its materialized view. */
const accountBudgets = (): BuiltQuery => {
	const q = new Ir(reportsModel())
	const m = q.region(
		[
			{
				source: q.base("AccountBudget"),
				bind: { account: "account", tasks: "tasks", budget: "budget" },
				constants: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["account", "account"],
				["tasks", "tasks"],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/** The closed facts as a typed VALUES relation, matched by the tier handle. */
const budgets = (): BuiltQuery => {
	const q = new Ir(plansModel())
	const m = q.region(
		[
			{ source: q.base("Subscription"), bind: { account: "account", tier: "tier" }, constants: {} },
			{ source: q.closed("Tier"), bind: { id: "tier", budget: "budget" }, constants: {} }
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["account", "account"],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/**
 * switchToManualDescribed, whose members are queries over the current facts with parameters
 * { task, operator }. When the task is not automatic, every member is empty.
 *
 * put(Task, ...): the automatic task at `task`, found again as the manual one.
 */
const switchToManualPutMember = (): BuiltQuery => {
	const q = new Ir(workModel())
	const task = q.base("Task")
	const m = q.region(
		[
			{
				source: task,
				bind: { account: "account" },
				constants: {
					id: q.param("task", q.column(task, "id").type, "compare"),
					kind: q.litFor(task, "kind", "Automatic")
				}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["id", q.param("task", q.column(task, "id").type, "emit")],
				["account", "account"],
				["kind", q.lit("Manual", q.column(task, "kind").type)]
			],
			conservativeMeta
		)
	)
}

/** delete(AutomaticTask, ...): the task's current automatic arm, whatever its budget. */
const switchToManualDeleteMember = (): BuiltQuery => {
	const q = new Ir(workModel())
	const automatic = q.base("AutomaticTask")
	const m = q.region(
		[
			{
				source: automatic,
				bind: { budget: "budget" },
				constants: { task: q.param("task", q.column(automatic, "task").type, "compare") }
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["task", q.param("task", q.column(automatic, "task").type, "emit")],
				["budget", "budget"]
			],
			conservativeMeta
		)
	)
}

/** insert(ManualTask, ...): the manual arm, when the task is automatic. */
const switchToManualInsertMember = (): BuiltQuery => {
	const q = new Ir(workModel())
	const task = q.base("Task")
	const m = q.region(
		[
			{
				source: task,
				constants: {
					id: q.param("task", q.column(task, "id").type, "compare"),
					kind: q.litFor(task, "kind", "Automatic")
				},
				bind: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["task", q.param("task", q.model.type("ManualTask", "task"), "emit")],
				["operator", q.param("operator", q.model.type("ManualTask", "operator"), "emit")]
			],
			conservativeMeta
		)
	)
}

/** The example's queries as checked relational IR, by the name of the program each one states. */
export const workQueries = {
	automaticTasksFor,
	taskPayloads,
	tasksById,
	automaticBudgetFor,
	largestPerAccount,
	labeledAutomaticTasks,
	tasksWithoutNotes,
	assignedTasks,
	taskCards,
	accountCards,
	accountsByPrefix,
	automaticBudget,
	accountBudgets,
	switchToManualPutMember,
	switchToManualDeleteMember,
	switchToManualInsertMember,
	budgets
} as const satisfies Readonly<Record<string, () => BuiltQuery>>

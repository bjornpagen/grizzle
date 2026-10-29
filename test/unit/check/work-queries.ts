import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	attach,
	count,
	eq,
	lit,
	match,
	orderBy,
	param,
	parent,
	query,
	ref,
	relationSource,
	rule,
	typedLit,
	vars
} from "#test/unit/check/dsl.ts"

const taskVars = vars("Task", "id", "account", "kind")
/** Kind's typed handle, Kind.handle(h), as the query builder records it: a literal typed by closedId(Kind). */
const kindHandle = (value: LiteralDesc) => typedLit(value, { kind: "closedId", roster: "Kind" })
const automaticVars = vars("AutomaticTask", "task", "budget")

/**
 * The worked example's queries as the Descriptions the query builder records for them.
 *
 * Each is the query's rule, transcribed onto the Description boundary with the DSL: `v(Task)` mints one
 * variable per field, named `Task.<field>` and carrying its origin, and a match binds the fields the rule uses.
 */
export const automaticTasksFor: QueryDesc = query(
	rule({
		vars: [...taskVars, ...automaticVars],
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit("Automatic")
			}),
			match(relationSource("AutomaticTask"), {
				task: ref("Task", "id"),
				budget: ref("AutomaticTask", "budget")
			})
		],
		where: [eq(ref("Task", "account"), param("account"))],
		head: { id: ref("Task", "id"), budget: ref("AutomaticTask", "budget") },
		interiors: [],
		attach: []
	})
)

export const taskPayloads: QueryDesc = query(
	rule({
		vars: [...taskVars, ...automaticVars],
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit("Automatic")
			}),
			match(relationSource("AutomaticTask"), {
				task: ref("Task", "id"),
				budget: ref("AutomaticTask", "budget")
			})
		],
		head: {
			id: ref("Task", "id"),
			account: ref("Task", "account"),
			kind: kindHandle("Automatic"),
			budget: ref("AutomaticTask", "budget")
		},
		where: [],
		interiors: [],
		attach: []
	}),
	rule({
		vars: [...taskVars, ...vars("ManualTask", "task", "operator")],
		matches: [
			match(relationSource("Task"), {
				id: ref("Task", "id"),
				account: ref("Task", "account"),
				kind: lit("Manual")
			}),
			match(relationSource("ManualTask"), {
				task: ref("Task", "id"),
				operator: ref("ManualTask", "operator")
			})
		],
		head: {
			id: ref("Task", "id"),
			account: ref("Task", "account"),
			kind: kindHandle("Manual"),
			operator: ref("ManualTask", "operator")
		},
		where: [],
		interiors: [],
		attach: []
	})
)

export const taskCards: QueryDesc = attach(
	attach(
		query(
			rule({
				vars: taskVars,
				matches: [
					match(relationSource("Task"), {
						id: ref("Task", "id"),
						account: ref("Task", "account"),
						kind: ref("Task", "kind")
					})
				],
				where: [eq(ref("Task", "account"), param("account"))],
				head: { id: ref("Task", "id"), kind: ref("Task", "kind") },
				interiors: [],
				attach: []
			})
		),
		"note",
		query(
			rule({
				vars: vars("TaskNote", "note"),
				matches: [
					match(relationSource("TaskNote"), { task: parent("id"), note: ref("TaskNote", "note") })
				],
				head: { note: ref("TaskNote", "note") },
				where: [],
				interiors: [],
				attach: []
			})
		)
	),
	"automatic",
	query(
		rule({
			vars: vars("AutomaticTask", "budget"),
			matches: [
				match(relationSource("AutomaticTask"), {
					task: parent("id"),
					budget: ref("AutomaticTask", "budget")
				})
			],
			head: { budget: ref("AutomaticTask", "budget") },
			where: [],
			interiors: [],
			attach: []
		})
	)
)

export const accountCards: QueryDesc = attach(
	attach(
		query(
			rule({
				vars: vars("Account", "id", "name"),
				matches: [
					match(relationSource("Account"), {
						id: ref("Account", "id"),
						name: ref("Account", "name")
					})
				],
				head: { id: ref("Account", "id"), name: ref("Account", "name") },
				where: [],
				interiors: [],
				attach: []
			})
		),
		"tasks",
		orderBy(
			query(
				rule({
					vars: taskVars,
					matches: [
						match(relationSource("Task"), {
							id: ref("Task", "id"),
							account: parent("id"),
							kind: ref("Task", "kind")
						})
					],
					head: { id: ref("Task", "id"), kind: ref("Task", "kind") },
					where: [],
					interiors: [],
					attach: []
				})
			),
			["id", "asc"]
		)
	),
	"automaticTasks",
	query(
		rule({
			vars: taskVars,
			matches: [
				match(relationSource("Task"), {
					id: ref("Task", "id"),
					account: parent("id"),
					kind: lit("Automatic")
				})
			],
			head: { count: count() },
			where: [],
			interiors: [],
			attach: []
		})
	)
)

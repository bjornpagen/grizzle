import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import {
	lit,
	match,
	queryDesc,
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
 * The worked example's taskPayloads as the Description the query builder records for it.
 *
 * Its rules are the query's, transcribed onto the Description boundary with the DSL: `v(Task, "task")` mints one
 * variable per field, named `Task.<field>` and carrying its origin, and a match binds the fields the rule uses.
 */
export const taskPayloads: QueryDesc = queryDesc(
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

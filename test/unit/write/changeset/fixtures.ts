import { pipe, String as Str } from "effect"
import type { ChangeSetDesc } from "#compiler/ir/desc.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { contained, key, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	changeSetDesc,
	type ParsedChangeSet,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"

import {
	compileChangeSet,
	type FrontendOptions,
	type WriteFrontend
} from "#compiler/write/frontend/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { AutomaticTask, ManualTask, Task, Work } from "#test/support/fixtures/api/work.ts"
import { checking } from "#test/support/policy.ts"

/** Schemas and ChangeSets for the write front end tests, over the real builders: the worked
 * example, plus small schemas that exercise serial fields, candidate keys,
 * mutable relations, pure sets and foreign keys. */
export const cs = (schemaValue: unknown): ChangeSetValue => ChangeSet.empty(schemaValue)

export const descOf = (value: unknown): ChangeSetDesc => {
	const desc = changeSetDesc(value)
	if (desc === undefined) {
		throw new Error("not a ChangeSet value")
	}
	return desc
}

/** A ChangeSet value as db.apply parses it. */
export const parsedOf = (value: unknown): ParsedChangeSet => {
	const parsed = parseChangeSet(value)
	if (parsed === undefined) {
		throw new Error("not a ChangeSet value")
	}
	return parsed
}

/** The front end's options as compileWrite states them for reality over `schemaValue`: every context's fact held, and the
 * keys of its views as its artifacts know them. */
const frontendOptions = (schemaValue: unknown): FrontendOptions => {
	const artifacts = succeeded(testArtifacts(schemaValue, testCompile))
	return {
		claims: { kind: "every" },
		laws: artifacts.laws,
		derived: artifacts.derived,
		world: { kind: "reality" }
	}
}

export const compiled = (schemaValue: unknown, value: unknown): WriteFrontend =>
	succeeded(compileChangeSet(checking(schemaValue), descOf(value), frontendOptions(schemaValue)))

export const uuidOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The worked example's arm switch, described. */
export const switchToManual = (): ChangeSetValue =>
	cs(Work)
		.put(
			Task,
			query(Work).rule((r: RuleValue) => {
				const { account } = v(Task, "task")
				return r
					.match(Task, { id: r.param("task", Task.fields.id), account, kind: "Automatic" })
					.find({ id: r.param("task", Task.fields.id), account, kind: "Manual" })
			})
		)
		.delete(
			AutomaticTask,
			query(Work).rule((r: RuleValue) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r
					.match(AutomaticTask, { task: r.param("task", AutomaticTask.fields.task), budget })
					.find({ task: r.param("task", AutomaticTask.fields.task), budget })
			})
		)
		.insert(
			ManualTask,
			query(Work).rule((r: RuleValue) =>
				r.match(Task, { id: r.param("task", Task.fields.id), kind: "Automatic" }).find({
					task: r.param("task", ManualTask.fields.task),
					operator: r.param("operator", ManualTask.fields.operator)
				})
			)
		)

const label = str.regex("^[a-z]{1,8}$")

/** A ledger with a serial key, a serial outside the key, a candidate key, a mutable relation, a pure set and a foreign
 * key: Entry references Book. */
const Book = relation("Book", { id: uuid, title: label }, ["id"])
export const Entry = relation("Entry", { id: uuid, book: uuid, code: label, amount: pg.bigint }, [
	"id"
])
const Ticket = relation("Ticket", { id: pg.bigserial, note: label }, ["id"])
const Counter = relation("Counter", { name: label, value: pg.bigint, seq: pg.serial }, ["name"])
const Status = relation("Status", { id: uuid, state: label }, ["id"])
const Tag = relation("Tag", { owner: uuid, tag: label }, ["owner", "tag"])
export const Ledger = schema("Ledger", { Book, Entry, Ticket, Counter, Status, Tag }, [
	key(Entry, ["code"]),
	contained(on(Entry, "book"), on(Book, "id")),
	mutable(Status),
	mutable(Counter),
	mutable(Tag)
])

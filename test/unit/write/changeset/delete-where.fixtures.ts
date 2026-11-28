/** What the properties of delete-where.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, shuffled, subarray, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order as Ord, Record as Rec } from "effect"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { Num } from "#compiler/public/compute.ts"
import { Money, int8 } from "#compiler/public/fields.ts"
import { param } from "#compiler/public/query.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import {
	Bin,
	Book,
	Budget,
	Cart,
	Entry,
	Item,
	Ledger,
	Node,
	Order,
	Pool,
	Tag,
	Task,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { Wherer } from "#test/support/agreement/delete-where.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** The relations a key names: Task, its world entry over the role, and every kind of delete besides. */
const keyNames = [
	"Task",
	"Manual",
	"Budget",
	"Ticket",
	"Ledger",
	"Tag",
	"Order",
	"Cart",
	"Pool",
	"Bin",
	"Node",
	"Entry",
	"Item",
	"Book"
] as const

type KeyName = (typeof keyNames)[number]

/** The relation value a delete names for a key. */
export const relationOf = (name: KeyName): unknown =>
	name === "Manual"
		? Wherer.relations.Manual
		: { Task, Budget, Ticket, Ledger, Tag, Order, Cart, Pool, Bin, Node, Entry, Item, Book }[name]

/**
 * The fields a key's delete names its rows by, each with a parameter of its type by a name and a literal of its
 * type, none for a set, whose value is no JavaScript literal deleteWhere takes: a relation's written fields, a tree's root field, a world
 * entry's head; a family's member's own, which both deletes refuse alike.
 */
const fieldsOf = (
	name: KeyName
): ReadonlyArray<{
	readonly field: string
	readonly param: (name: string) => unknown
	readonly literal: Option.Option<unknown>
}> => {
	switch (name) {
		case "Task":
			return [
				{ field: "id", param: (n) => param(n, Task.fields.id), literal: Option.some(uuidOf(1)) },
				{
					field: "account",
					param: (n) => param(n, Task.fields.account),
					literal: Option.some(uuidOf(2))
				},
				{ field: "kind", param: (n) => param(n, Task.fields.kind), literal: Option.some("Manual") }
			]
		case "Manual":
			return [
				{ field: "id", param: (n) => param(n, Task.fields.id), literal: Option.some(uuidOf(1)) },
				{
					field: "account",
					param: (n) => param(n, Task.fields.account),
					literal: Option.some(uuidOf(2))
				}
			]
		case "Budget":
			return [
				{
					field: "task",
					param: (n) => param(n, Budget.fields.task),
					literal: Option.some(uuidOf(3))
				},
				{ field: "cents", param: (n) => param(n, Budget.fields.cents), literal: Option.some(5n) }
			]
		case "Ticket":
			return [
				{ field: "id", param: (n) => param(n, Ticket.fields.id), literal: Option.some(3n) },
				{
					field: "account",
					param: (n) => param(n, Ticket.fields.account),
					literal: Option.some(uuidOf(2))
				},
				{ field: "amount", param: (n) => param(n, Ticket.fields.amount), literal: Option.some(7n) }
			]
		case "Ledger":
			return [
				{ field: "id", param: (n) => param(n, Ledger.fields.id), literal: Option.some(4n) },
				{
					field: "balance",
					param: (n) => param(n, Ledger.fields.balance),
					literal: Option.some(-9n)
				},
				{
					field: "fee",
					param: (n) => param(n, Ledger.fields.fee),
					literal: Option.some(Money.of(250n))
				}
			]
		case "Tag":
			return [
				{ field: "id", param: (n) => param(n, Tag.fields.id), literal: Option.some(uuidOf(5)) },
				{
					field: "kind",
					param: (n) => param(n, Tag.fields.kind),
					literal: Option.some("Automatic")
				},
				{ field: "flags", param: (n) => param(n, Tag.fields.flags), literal: Option.none() },
				{ field: "answer", param: (n) => param(n, Tag.fields.answer), literal: Option.some("yes") },
				{ field: "grade", param: (n) => param(n, Tag.fields.grade), literal: Option.some("pass") }
			]
		case "Order":
		case "Cart":
		case "Pool":
		case "Bin":
			return [
				{ field: "id", param: (n) => param(n, Order.fields.id), literal: Option.some(uuidOf(6)) }
			]
		case "Node":
			return [
				{ field: "doc", param: (n) => param(n, Node.fields.doc), literal: Option.some(uuidOf(7)) }
			]
		case "Entry":
			return [
				{
					field: "owner",
					param: (n) => param(n, Entry.fields.owner),
					literal: Option.some(uuidOf(8))
				},
				{ field: "qty", param: (n) => param(n, Entry.fields.qty), literal: Option.some(2n) }
			]
		case "Item":
			return [
				{
					field: "owner",
					param: (n) => param(n, Item.fields.owner),
					literal: Option.some(uuidOf(8))
				},
				{ field: "v", param: (n) => param(n, Item.fields.v), literal: Option.some(2n) }
			]
		case "Book":
			return [
				{ field: "id", param: (n) => param(n, Book.fields.id), literal: Option.some(uuidOf(9)) },
				{
					field: "shelf",
					param: (n) => param(n, Book.fields.shelf),
					literal: Option.some(uuidOf(9))
				}
			]
	}
}

/** The rows a key's delete names: every field the caller writes, a tree's root field alone. */
const rowOf = (name: KeyName): ReadonlyArray<string> => {
	switch (name) {
		case "Order":
		case "Cart":
		case "Pool":
		case "Bin":
			return ["id"]
		case "Node":
			return ["doc"]
		case "Entry":
			return ["owner", "qty"]
		case "Item":
			return ["owner", "v"]
		case "Book":
			return ["id", "shelf"]
		case "Task":
		case "Manual":
		case "Budget":
		case "Ticket":
		case "Ledger":
		case "Tag":
			return Arr.map(fieldsOf(name), (f) => f.field)
	}
}

/** What a selected field equals: a parameter, of its field's name or of the bound name `p`, or its literal. */
type Equaled = { readonly kind: "param"; readonly name: string } | { readonly kind: "literal" }

interface Selected {
	readonly field: string
	readonly equaled: Equaled
}

interface Key {
	readonly name: KeyName
	readonly fields: ReadonlyArray<Selected>
}

/** What the deleteWhere is added to. */
const bases = ["empty", "after a stratum", "a bound parameter", "over the role"] as const

type Base = (typeof bases)[number]

/** A JavaScript caller's fault, planted at the first key. */
export const faults = [
	"a field its rows do not state",
	"a variable for a parameter",
	"a scalar term for a parameter",
	"a key of a closed relation",
	"a key of no relation",
	"a selection that is no record"
] as const

type Fault = (typeof faults)[number]

interface DeleteWhereCase {
	readonly base: Base
	readonly keys: Arr.NonEmptyReadonlyArray<Key>
	/** The deletes' order, the keys' positions. */
	readonly order: ReadonlyArray<number>
	readonly fault: Fault | undefined
}

/** The keys a base's ChangeSet writes: the role writes Task only through its entry, and Work has no entry. */
const offered = (base: Base): Arr.NonEmptyReadonlyArray<KeyName> =>
	base === "over the role"
		? ["Manual", "Budget", "Ticket", "Ledger", "Tag", "Order", "Cart", "Entry"]
		: [
				"Task",
				"Budget",
				"Ticket",
				"Ledger",
				"Tag",
				"Order",
				"Cart",
				"Pool",
				"Bin",
				"Node",
				"Entry",
				"Item",
				"Book"
			]

/** A key's field: its parameter and its literal. */
const fieldOf = (name: KeyName, field: string) =>
	Option.getOrThrowWith(
		Arr.findFirst(fieldsOf(name), (f) => f.field === field),
		() => new Error("a field of the key")
	)

const keyGen =
	(name: KeyName): Gen<Key> =>
	(source) => {
		const chosen = source.draw(subarray(Arr.map(fieldsOf(name), (f) => f.field)))
		return {
			name,
			fields: Arr.map(chosen, (field): Selected => {
				const equaled = source.draw(
					element(
						Option.isSome(fieldOf(name, field).literal)
							? (["field", "bound", "literal"] as const)
							: (["field", "bound"] as const)
					)
				)
				return {
					field,
					equaled:
						equaled === "literal"
							? { kind: "literal" }
							: { kind: "param", name: equaled === "bound" ? "p" : field }
				}
			})
		}
	}

/**
 * Whether a key's delete compiles: refused for Order and Pool, closed (their facts are inserted, never deleted), and for
 * Entry, Item and Book, each a family's member, deleted through its owner.
 */
const compiles: { readonly [K in KeyName]: boolean } = {
	Task: true,
	Manual: true,
	Budget: true,
	Ticket: true,
	Ledger: true,
	Tag: true,
	Order: false,
	Cart: true,
	Pool: false,
	Bin: true,
	Node: true,
	Entry: false,
	Item: false,
	Book: false
}

/** The keys whose deletes compile, which a fault is planted at alone, so its refusal is the case's one. */
const compiling = (base: Base): Arr.NonEmptyReadonlyArray<KeyName> => {
	const [first, ...rest] = offered(base)
	return [first, ...Arr.filter(rest, (n) => compiles[n])]
}

export const caseGen: Gen<DeleteWhereCase> = (source) => {
	const base = source.draw(element(bases))
	const fault = source.draw(
		weighted<Fault | undefined>([
			[3, constant(undefined)],
			[1, element(faults)]
		])
	)
	const names =
		fault === undefined
			? source.draw(shuffled(offered(base), { min: 1, max: 5 }))
			: [source.draw(element(compiling(base)))]
	const keys = Arr.map(names, (name) => source.draw(keyGen(name)))
	return {
		base,
		keys: [defined(keys[0], "a key"), ...Arr.drop(keys, 1)],
		order: source.draw(
			shuffled(
				Arr.map(keys, (_, i) => i),
				{ min: keys.length, max: keys.length }
			)
		),
		fault
	}
}

/** Task's facts, its key a parameter `p`, described: a query member whose parameter a bound one of its name yields to. */
const tasksAt = queryOver(Work).rule((r: RuleValue) => {
	const { account, kind } = varsOver(Task, "task")
	const id = r.param("p", Task.fields.id)
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
})

/** A ChangeSet the deleteWhere is added to. */
export const baseOf = (base: Base): ChangeSetValue => {
	switch (base) {
		case "empty":
			return ChangeSet.empty(Work)
		case "after a stratum":
			return ChangeSet.sequence(
				ChangeSet.empty(Work).insert(Pool, [{ id: uuidOf(90) }]),
				ChangeSet.empty(Work)
			)
		case "a bound parameter":
			return ChangeSet.empty(Work)
				.insert(Task, tasksAt)
				.bind({ p: uuidOf(91) })
		case "over the role":
			return ChangeSet.empty(Wherer)
	}
}

/** What a selected field equals, as deleteWhere takes it: a parameter of its field's type, or its literal. */
const valueOf = (name: KeyName, s: Selected): unknown => {
	const f = fieldOf(name, s.field)
	return s.equaled.kind === "param"
		? f.param(s.equaled.name)
		: Option.getOrThrowWith(f.literal, () => new Error("a literal of the field"))
}

/**
 * The query a key's selection is, written with the query builder: the rows its delete names, as variables of the scope
 * `equal` in the heading's canonical order, the engine's, kept where each selected field equals its value.
 */
export const selectionQueryOf = (over: unknown, key: Key): QueryValue =>
	queryOver(over).rule((r: RuleValue) => {
		const relation = relationOf(key.name)
		const vars = varsOver(relation, "equal")
		const heading = Arr.sort(rowOf(key.name), Ord.String)
		const row = Rec.fromEntries(
			Arr.map(heading, (field) => [field, defined(vars[field], "a variable of the row")] as const)
		)
		return Arr.reduce(
			Arr.flatMap(heading, (field) =>
				Arr.map(
					Arr.filter(key.fields, (s) => s.field === field),
					(s) => r.eq(defined(vars[field], "a variable of the field"), valueOf(key.name, s))
				)
			),
			r.match(relation, row),
			(rule, equality) => rule.where(equality)
		).find(row)
	})

/** What a ChangeSet over Work compiles against: Work's reality. */
const reality = Object.freeze(
	(() => {
		const artifacts = succeeded(testArtifacts(Work, testCompile))
		return { checked: checking(Work), options: realityWrite(artifacts) }
	})()
)

/** What a ChangeSet over the role compiles against: the role's world. */
const roleWorld = Object.freeze(
	(() => {
		const artifacts = succeeded(testArtifacts(Wherer, testCompile))
		const world = artifacts.world
		if (world.kind !== "role") {
			return assert.fail("the role's artifacts hold its world")
		}
		return {
			checked: world.checked,
			options: {
				names: artifacts.names,
				reads: artifacts.reads,
				claims: { kind: "every" } as const,
				world: writeWorldOf(world, artifacts.laws),
				laws: artifacts.laws,
				derived: artifacts.derived,
				level: "serializable" as const,
				clock: noClock,
				source: transactionClock
			}
		}
	})()
)

/** A compiled ChangeSet's plan, each realization's statements' SQL and its parameters, or its refusal's reason. */
export const planOf = (base: Base, change: ChangeSetValue) => {
	const { checked, options } = base === "over the role" ? roleWorld : reality
	const compiled = compileWrite(checked, descOf(change), options)
	return compiled.ok
		? {
				kind: "plan" as const,
				optimized: Arr.map(compiled.value.artifact.statements, (s) => s.spec.sql),
				conservative: Arr.map(
					succeeded(conservativeWrite(compiled.value, options)).artifact.statements,
					(s) => s.spec.sql
				),
				params: Arr.map(compiled.value.params, (p) => p.name)
			}
		: { kind: "refused" as const, reason: compiled.error.reason._tag }
}

/** A key's selection as deleteWhere takes it, the fault planted at the first key, at its first row field. */
const selectionOf = (key: Key, fault: Fault | undefined): Readonly<Record<string, unknown>> => {
	const fields = Rec.fromEntries(
		Arr.map(key.fields, (s) => [s.field, valueOf(key.name, s)] as const)
	)
	const first = defined(rowOf(key.name)[0], "a row field")
	switch (fault) {
		case undefined:
		case "a key of a closed relation":
		case "a key of no relation":
			return fields
		case "a field its rows do not state":
			return { ...fields, zz: uuidOf(1) }
		case "a variable for a parameter":
			return { ...fields, [first]: varsOver(relationOf(key.name), "x")[first] }
		case "a scalar term for a parameter":
			return { ...fields, [first]: Num.add(param("q", int8), 1n) }
		case "a selection that is no record":
			return new Proxy({}, { getPrototypeOf: () => Date.prototype })
	}
}

/** The record a case's deleteWhere takes, its fault planted at its first key. */
export const recordOf = (
	sketch: DeleteWhereCase
): Readonly<Record<string, Readonly<Record<string, unknown>>>> => {
	const [first, ...rest] = sketch.keys
	const firstName =
		sketch.fault === "a key of a closed relation"
			? "Kind"
			: sketch.fault === "a key of no relation"
				? "Nowhere"
				: first.name
	return Rec.fromEntries([
		[firstName, selectionOf(first, sketch.fault)] as const,
		...Arr.map(rest, (k) => [k.name, selectionOf(k, undefined)] as const)
	])
}

export type DeleteWhereFeature =
	| "one key"
	| "four keys or more"
	| "an empty selection"
	| "several fields"
	| "a literal"
	| "a parameter two keys share"
	| "a parameter of the bound name"
	| "a unit's delete"
	| "a tree's root"
	| "a world entry's key"
	| "a stratum before"
	| "deleted in another order"
	| "a plan compiled"
	| "a compile refused"
	| `planted: ${Fault}`

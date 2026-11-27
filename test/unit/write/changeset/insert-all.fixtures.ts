/** What the properties of insert-all.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Stream } from "effect"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { descText } from "#compiler/ir/desc.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { query, v } from "#compiler/public/query.ts"
import { role } from "#compiler/public/schema.ts"
import {
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	type MemberInput
} from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import {
	Budget,
	Chip,
	Item,
	Node,
	Order,
	Pool,
	Task,
	Ticket,
	toCents,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { checking } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** Manual tasks, a world entry over Task whose head leaves out the kind its selection fixes. */
const Manual = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account, kind: "Manual" }).find({ id, account })
})

/** A role writing Work's relations, Task through its Manual entry alone. */
const Insall = role(
	Work,
	"insall",
	{ ...Work.relations, Manual },
	{
		insert: ["Order", "Line", "Pool", "Item"],
		write: ["Manual", "Budget", "Ticket", "Bin", "Chip", "Node"]
	}
)

/** The relations a key names: Task, its world entry over the role, and relations of every kind of insert besides. */
const keyNames = [
	"Task",
	"Manual",
	"Budget",
	"Ticket",
	"Order",
	"Pool",
	"Item",
	"Chip",
	"Node"
] as const

type KeyName = (typeof keyNames)[number]

/** The relation value an insert names for a key. */
export const relationOf = (name: KeyName): unknown =>
	name === "Manual"
		? Insall.relations.Manual
		: { Task, Budget, Ticket, Order, Pool, Item, Chip, Node }[name]

/** What the insertAll is added to: an empty ChangeSet over Work, one after a stratum, one with a bound parameter, or
 * an empty ChangeSet over the role. */
const bases = ["empty", "after a stratum", "a bound parameter", "over the role"] as const

type Base = (typeof bases)[number]

/** How a key's members travel. */
type Travel = "array" | "stream" | "query"

interface Key {
	readonly name: KeyName
	readonly travel: Travel
	/** The facts' numbers: the first fact's, and how many. */
	readonly first: number
	readonly count: number
}

interface InsertAllCase {
	readonly base: Base
	/** The record's keys, in its order. */
	readonly keys: ReadonlyArray<Key>
	/** The inserts' order, the keys' positions. */
	readonly order: ReadonlyArray<number>
}

/** Task's facts, its key a parameter `p`, described: a query member whose parameter a bound one of its name yields to. */
const tasksAt = query(Work).rule((r) => {
	const { account, kind } = v(Task, "task")
	const id = r.param("p", Task.fields.id)
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
})

/** The fact numbered n of a relation, as its insert takes it. */
const factOf = (name: KeyName, n: number): Readonly<Record<string, unknown>> => {
	switch (name) {
		case "Task":
			return { id: uuidOf(n), account: uuidOf(n), kind: "Manual" }
		case "Manual":
			return { id: uuidOf(n), account: uuidOf(n) }
		case "Budget":
			return { task: uuidOf(n), cents: toCents(BigInt(n)) }
		case "Ticket":
			return { account: uuidOf(n), amount: toCents(5n) }
		case "Order":
			return { id: uuidOf(n), n: [{ qty: 1n }, { qty: BigInt(n) }] }
		case "Pool":
			return { id: uuidOf(n) }
		case "Item":
		case "Chip":
			return { owner: uuidOf(n), v: BigInt(n) }
		case "Node":
			return {
				doc: uuidOf(n),
				label: 0,
				children: [{ label: 1, children: [] }]
			}
	}
}

/** A key's members as the facade takes them, the same value for the insertAll and for the insert. */
export const membersOf = (key: Key): MemberInput => {
	const facts = upTo(key.count, (i) => factOf(key.name, key.first + i))
	switch (key.travel) {
		case "array":
			return facts
		case "stream":
			return Stream.fromIterable(facts)
		case "query":
			return tasksAt
	}
}

/** A ChangeSet the insertAll is added to. */
export const baseOf = (base: Base): ChangeSetValue => {
	switch (base) {
		case "empty":
			return ChangeSet.empty(Work)
		case "after a stratum":
			return ChangeSet.sequence(
				ChangeSet.empty(Work).insert(Pool, [factOf("Pool", 90)]),
				ChangeSet.empty(Work)
			)
		case "a bound parameter":
			return ChangeSet.empty(Work)
				.insert(Task, tasksAt)
				.bind({ p: uuidOf(91) })
		case "over the role":
			return ChangeSet.empty(Insall)
	}
}

/** The keys a base's ChangeSet writes: the role writes Task only through its entry, and Work has no entry. */
const offered = (base: Base): Arr.NonEmptyReadonlyArray<KeyName> =>
	base === "over the role"
		? ["Manual", "Budget", "Ticket", "Order", "Pool", "Item", "Chip", "Node"]
		: ["Task", "Budget", "Ticket", "Order", "Pool", "Item", "Chip", "Node"]

export const caseGen: Gen<InsertAllCase> = (source) => {
	const base = source.draw(element(bases))
	const names = source.draw(shuffled(offered(base), { min: 1, max: offered(base).length }))
	const keys = Arr.map(names, (name, i): Key => ({
		name,
		travel:
			name === "Task"
				? source.draw(element(["array", "stream", "query"] as const))
				: name === "Order" || name === "Node"
					? "array"
					: source.draw(element(["array", "stream"] as const)),
		first: 10 * (i + 1),
		count: source.draw(int(1, 2))
	}))
	return {
		base,
		keys,
		order: source.draw(
			shuffled(
				Arr.map(keys, (_, i) => i),
				{ min: keys.length, max: keys.length }
			)
		)
	}
}

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
		const artifacts = succeeded(testArtifacts(Insall, testCompile))
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

/** A compiled ChangeSet's plan, each artifact's statements' SQL and its parameters, or its refusal's reason. */
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

/** A ChangeSet's canonical Description text. */
export const textOf = (change: ChangeSetValue): string => succeeded(descText(descOf(change)))

/** A ChangeSet's inputs by slot: an array's facts, a Stream itself. */
export const inputsOf = (change: ChangeSetValue) =>
	Arr.map([...parsedOf(change).inputs], ([slot, input]) =>
		input.kind === "array" ? [slot, input.facts] : [slot, input.stream]
	)

export type InsertAllFeature =
	| "one key"
	| "four keys or more"
	| "a Stream member"
	| "a query member"
	| "a nested member"
	| "a world entry's key"
	| "a stratum before"
	| "a bound parameter yielding"
	| "inserted in another order"
	| "a plan compiled"
	| "a compile refused"

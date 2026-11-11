import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Stream } from "effect"
import { descText } from "#compiler/ir/desc.ts"
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
	Cents,
	Chip,
	Item,
	Node,
	Order,
	Pool,
	Task,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { conservativeWrite } from "#test/support/conservative.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * ChangeSet#insertAll (write/changeset/value.ts) is the inserts of its keys: over the ChangeSet agreement's Work
 * (test/support/agreement/changeset-schema.ts), and over a role that writes a world entry, a ChangeSet begun empty,
 * after a stratum, or with a parameter bound, given one insertAll of a record of relations, each key's members an
 * array, a Stream or a query, has the Description, the inputs and the bound values of the same ChangeSet given one
 * insert of each key's members in any order; so it compiles to the same plan, statement by statement, or is refused
 * for the same reason. The oracle is the specification: inserts within one stratum are one set.
 *
 * Features: one key, four keys or more, a Stream member, a query member, a nested member, a world entry's key, a
 * stratum before, a bound parameter yielding, another order, a plan compiled, a compile refused.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): insert-all-last-key-dropped.
 */

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
		write: ["Manual", "Budget", "Ticket", "Order", "Line", "Pool", "Item", "Bin", "Chip", "Node"]
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
const relationOf = (name: KeyName): unknown =>
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
			return { task: uuidOf(n), cents: Cents(BigInt(n)) }
		case "Ticket":
			return { account: uuidOf(n), amount: Cents(5n) }
		case "Order":
			return { id: uuidOf(n), n: [{ qty: 1n }, { qty: BigInt(n) }] }
		case "Pool":
			return { id: uuidOf(n) }
		case "Item":
		case "Chip":
			return { owner: uuidOf(n), v: BigInt(n) }
		case "Node":
			return {
				id: uuidOf(n),
				doc: uuidOf(n),
				label: 0,
				children: [{ id: uuidOf(n + 100), label: 1, children: [] }]
			}
	}
}

/** A key's members as the facade takes them, the same value for the insertAll and for the insert. */
const membersOf = (key: Key): MemberInput => {
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
const baseOf = (base: Base): ChangeSetValue => {
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

const caseGen: Gen<InsertAllCase> = (source) => {
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
const reality = (() => {
	const artifacts = succeeded(testArtifacts(Work, testCompile))
	return { checked: checking(Work), options: realityWrite(artifacts) }
})()

/** What a ChangeSet over the role compiles against: the role's world. */
const roleWorld = (() => {
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
			world: { kind: "role", names: world.names } as const,
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable" as const
		}
	}
})()

/** A compiled ChangeSet's plan, each artifact's statements' SQL and its parameters, or its refusal's reason. */
const planOf = (base: Base, change: ChangeSetValue) => {
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
const textOf = (change: ChangeSetValue): string => succeeded(descText(descOf(change)))

/** A ChangeSet's inputs by slot: an array's facts, a Stream itself. */
const inputsOf = (change: ChangeSetValue) =>
	Arr.map([...parsedOf(change).inputs], ([slot, input]) =>
		input.kind === "array" ? [slot, input.facts] : [slot, input.stream]
	)

type InsertAllFeature =
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

describe("ChangeSet#insertAll", () => {
	it.effect(
		"is the inserts of its keys in any order: one Description, the same inputs and values, and one plan",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a stratum's inserts are one set, so insertAll is its keys' inserts in any order"
						},
						suite: "unit/write/changeset/insert-all",
						literal: Formatter.format,
						draw: drawn(caseGen),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						coverage: required<InsertAllFeature>(
							[
								"one key",
								"four keys or more",
								"a Stream member",
								"a query member",
								"a nested member",
								"a world entry's key",
								"a stratum before",
								"a bound parameter yielding",
								"inserted in another order",
								"a plan compiled",
								"a compile refused"
							],
							{ cases: 400, sense: notesOnly }
						),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const members = Arr.map(sketch.keys, (k) => [k.name, membersOf(k)] as const)
							const base = baseOf(sketch.base)
							const all = base.insertAll(Rec.fromEntries(members))
							const each = Arr.reduce(sketch.order, base, (cs, at) => {
								const [name, facts] = defined(members[at], "a key of the record")
								return cs.insert(relationOf(name), facts)
							})
							assert.equal(textOf(all), textOf(each), "one Description")
							assert.deepEqual(inputsOf(all), inputsOf(each), "the same inputs, by slot")
							assert.deepEqual(
								[...parsedOf(all).values],
								[...parsedOf(each).values],
								"the same bound values"
							)
							const plan = planOf(sketch.base, all)
							assert.deepEqual(plan, planOf(sketch.base, each), "one plan")
							c.note(plan.kind === "plan" ? "a plan compiled" : "a compile refused")
							if (sketch.keys.length === 1) {
								c.note("one key")
							}
							if (sketch.keys.length >= 4) {
								c.note("four keys or more")
							}
							for (const k of sketch.keys) {
								if (k.travel === "stream") {
									c.note("a Stream member")
								}
								if (k.travel === "query") {
									c.note("a query member")
									if (sketch.base === "a bound parameter") {
										c.note("a bound parameter yielding")
									}
								}
								if (k.name === "Order" || k.name === "Node") {
									c.note("a nested member")
								}
								if (k.name === "Manual") {
									c.note("a world entry's key")
								}
							}
							if (sketch.base === "after a stratum") {
								c.note("a stratum before")
							}
							if (Arr.some(sketch.order, (at, i) => at !== i)) {
								c.note("inserted in another order")
							}
						})
				)
			)
	)
})

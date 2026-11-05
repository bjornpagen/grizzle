import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	codePoint,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	string
} from "@grizzle/testing/gen"
import { lsw, passed, type WildKind } from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record, Stream } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { descText } from "#compiler/ir/desc.ts"
import { queryInput, querySchema } from "#compiler/program/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { record } from "#compiler/schema/record.ts"
import type { QueryBase } from "#compiler/types/query/query.ts"
import {
	arraySlot,
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	changeSetState,
	isChangeSetValue,
	streamSlot
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { assert, defined, throwsRefused } from "#test/support/assert.ts"
import { schemaInputOf } from "#test/support/compile.ts"
import { Employer, Payroll, Reporting } from "#test/support/fixtures/api/payroll.ts"
import { Account, Kind, Reports, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { dictionaryNameGen, type IdentifierFeature } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	compiled,
	cs,
	descOf,
	Entry,
	Ledger,
	parsedOf,
	switchToManual,
	uuidOf
} from "#test/unit/write/changeset/fixtures.ts"

/** The sealed canonical ChangeSet value. */
const text = (value: unknown): string => {
	const t = descText(descOf(value))
	if (!t.ok) {
		throw t.error
	}
	return t.value
}

/** The MalformedDescription `f` throws. */
const malformed = (f: () => unknown): CompileError => throwsRefused(f, "MalformedDescription")

const note = (n: number) => ({ task: uuidOf(n), note: `n${n}` })
const tasksOf = query(Work).rule((r: RuleValue) => {
	const { id, account, kind } = v(Task, "task")
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
})

/** A change set with the rule set `same` read back from it. */
const readBack = (x: ChangeSetValue) => x.read("same", () => tasksOf)

describe("ChangeSet.empty", () => {
	it("refuses anything but a schema", () => {
		malformed(() => ChangeSet.empty({}))
		malformed(() => ChangeSet.empty(Work, Work))
	})
})

describe("canonical form (build order never matters within a stratum)", () => {
	it.effect("gives one Description for any order of the members", (ctx) =>
		Effect.gen(function* () {
			/** The members a stratum may hold: arrays, a query, its repeat, and Streams, on two relations and three operations. */
			const manualTasks = query(Work).rule((r: RuleValue) => {
				const { id, account } = v(Task, "task")
				return r.match(Task, { id, account, kind: "Manual" }).find({ id, account, kind: "Manual" })
			})
			const notes = Stream.fromIterable([note(3)])
			const more = Stream.fromIterable([note(4)])
			const pool: Arr.NonEmptyReadonlyArray<{
				readonly add: (c: ChangeSetValue) => ChangeSetValue
				readonly kind: "array" | "query" | "stream"
				readonly target: string
			}> = [
				{ add: (c) => c.insert(TaskNote, [note(1)]), kind: "array", target: "insert TaskNote" },
				{
					add: (c) => c.insert(TaskNote, [note(2), note(1)]),
					kind: "array",
					target: "insert TaskNote"
				},
				{ add: (c) => c.delete(TaskNote, [note(2)]), kind: "array", target: "delete TaskNote" },
				{ add: (c) => c.put(TaskNote, [note(5)]), kind: "array", target: "put TaskNote" },
				{ add: (c) => c.put(Task, tasksOf), kind: "query", target: "put Task" },
				{ add: (c) => c.put(Task, manualTasks), kind: "query", target: "put Task" },
				{ add: (c) => c.insert(TaskNote, notes), kind: "stream", target: "insert TaskNote" },
				{ add: (c) => c.insert(TaskNote, more), kind: "stream", target: "insert TaskNote" }
			]
			/** The change set of the pooled members in `order`, each added in turn. */
			const built = (order: ReadonlyArray<number>) =>
				Arr.reduce(order, cs(Work), (set, i) => defined(pool[i], "a pooled member").add(set))
			yield* searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/member-order",
						draw: drawn((source) => {
							const members = source.draw(array(int(0, pool.length - 1), { min: 1, max: 6 }))
							return [
								members,
								source.draw(shuffled(members, { min: members.length, max: members.length }))
							] as const
						}),
						literal: Formatter.format,
						coverage: required<MemberOrderFeature>(
							[
								"an array member",
								"a query member",
								"a Stream member",
								"two members of one operation on one relation",
								"a repeated member"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([members, reordered], c) =>
						Effect.sync(() => {
							const picked = Arr.map(members, (i) => defined(pool[i], "a pooled member"))
							for (const m of picked) {
								c.note(
									m.kind === "array"
										? "an array member"
										: m.kind === "query"
											? "a query member"
											: "a Stream member"
								)
							}
							if (new Set(Arr.map(picked, (m) => m.target)).size < picked.length) {
								c.note("two members of one operation on one relation")
							}
							if (new Set(members).size < members.length) {
								c.note("a repeated member")
							}
							assert.equal(text(built(reordered)), text(built(members)))
						})
				)
			)
		})
	)

	it("makes the array members of one operation on one relation one member, their facts concatenated", () => {
		const a = cs(Work)
			.insert(TaskNote, [note(1)])
			.insert(TaskNote, [note(2), note(1)])
		assert.equal(text(a), text(cs(Work).insert(TaskNote, [note(1), note(2), note(1)])))
	})

	it("deduplicates equal query members and keeps Streams in order, each in its own slot", () => {
		const s1 = Stream.fromIterable([note(1)])
		const s2 = Stream.fromIterable([note(2)])
		const a = cs(Work)
			.put(Task, tasksOf)
			.put(Task, tasksOf)
			.insert(TaskNote, s1)
			.insert(TaskNote, s2)
		const d = descOf(a)
		assert.deepEqual(
			Arr.map(defined(d.strata[0], "the first stratum").members, (m) => m.member.kind),
			["query", "stream", "stream"]
		)
		const inputs = parsedOf(a).inputs
		assert.deepEqual(inputs.get(streamSlot(0, "insert", "TaskNote", 0)), {
			kind: "stream",
			stream: s1
		})
		assert.deepEqual(inputs.get(streamSlot(0, "insert", "TaskNote", 1)), {
			kind: "stream",
			stream: s2
		})
	})
})

describe("sealed and immutable", () => {
	it("returns a new value from every method and changes no earlier one", () => {
		const base = cs(Work)
		const next = base.insert(TaskNote, [note(1)])
		assert.notEqual(next, base)
		assert.deepEqual(descOf(base).strata[0]?.members, [])
		assert.equal(Object.isFrozen(base), true)
		assert.equal(isChangeSetValue(next), true)
		assert.equal(isChangeSetValue({}), false)
	})

	it("copies an array member's facts, so a later mutation of the caller's array changes nothing", () => {
		const facts = [{ ...note(1) }]
		const a = cs(Work).insert(TaskNote, facts)
		facts.push(note(2))
		const first = facts[0]
		if (first === undefined) {
			throw new Error("one fact")
		}
		first.note = "changed"
		const input = parsedOf(a).inputs.get(arraySlot(0, "insert", "TaskNote"))
		assert.deepEqual(input?.kind === "array" ? input.facts : undefined, [note(1)])
		assert.equal(input?.kind === "array" && Object.isFrozen(input.facts[0]), true)
	})
})

describe("strata", () => {
	it("are made only by sequence; insert, delete and put add to the last", () => {
		const s = ChangeSet.sequence(
			cs(Work).insert(TaskNote, [note(1)]),
			cs(Work).delete(TaskNote, [note(1)])
		)
		const d = descOf(s.put(TaskNote, [note(2)]))
		assert.deepEqual(
			Arr.map(defined(d.strata[0], "the first stratum").members, (m) => m.op),
			["insert"]
		)
		assert.deepEqual(
			Arr.map(defined(d.strata[1], "the second stratum").members, (m) => m.op),
			["delete", "put"]
		)
	})

	it("combine position by position under union, which is commutative on the Description", () => {
		const a = ChangeSet.sequence(
			cs(Work).insert(TaskNote, [note(1)]),
			cs(Work).delete(TaskNote, [note(2)])
		)
		const b = ChangeSet.sequence(
			ChangeSet.sequence(cs(Work), cs(Work).put(TaskNote, [note(3)])),
			cs(Work).insert(TaskNote, [note(4)])
		)
		const u = ChangeSet.union(a, b)
		const d = descOf(u)
		assert.deepEqual(
			Arr.map(d.strata, (s) => Arr.map(s.members, (m) => m.op)),
			[["insert"], ["delete", "put"], ["insert"]]
		)
		assert.equal(text(ChangeSet.union(b, a)), text(u))
	})

	it("keep an empty stratum, which union aligns by position", () => {
		const d = descOf(ChangeSet.sequence(cs(Work), cs(Work).insert(TaskNote, [note(1)])))
		assert.deepEqual(
			Arr.map(d.strata, (s) => s.members.length),
			[0, 1]
		)
	})
})

describe("members", () => {
	it("are arrays, Streams or queries, never an Ordered", () => {
		malformed(() => cs(Work).insert(TaskNote, tasksOf.orderBy(["id", "asc"])))
		/** A value that is none of them, though shaped like a query to a type checker: the typed API admits a Stream only at
		 * its exact type, so a non-member reaches the builder as a look-alike from a JavaScript caller. It even carries the
		 * builders' brand, which no barrel exports: the builder still refuses it, since only the values it made are queries. */
		const rows = record()
		const lookAlike: QueryBase = { ...builtMark, rows, immediate: rows, named: () => lookAlike }
		malformed(() => cs(Work).insert(TaskNote, lookAlike))
	})

	it("name an ordinary relation of the schema: no closed or derived relation, nor another schema's relation", () => {
		malformed(() => cs(Work).insert(Kind, [{ id: "Automatic" }]))
		malformed(() => cs(Work).insert(Entry, []))
		malformed(() => cs(Work).insert(closed("Other", ["a"]), []))
	})

	it("may be a query over a level of the schema, never over an unrelated schema", () => {
		const Ext = schema.extend(Work, {}, [])
		const over = cs(Ext).put(Task, tasksOf)
		assert.equal(descOf(over).schema, "Work")
		const other = schema("Elsewhere", { Task }, [])
		const foreign = query(other).rule((r: RuleValue) => {
			const { id, account, kind } = v(Task, "task")
			return r.match(Task, { id, account, kind }).find({ id, account, kind })
		})
		malformed(() => cs(Work).put(Task, foreign))
	})
})

describe("levels", () => {
	it("make union and sequence over the higher schema, and refuse unrelated schemas", () => {
		const Ext = schema.extend(Work, {}, [])
		const u = ChangeSet.union(cs(Work), cs(Ext))
		assert.equal(changeSetState(u)?.schema, Ext)
		assert.equal(changeSetState(ChangeSet.sequence(cs(Ext), cs(Work)))?.schema, Ext)
		malformed(() => ChangeSet.union(cs(Work), cs(Ledger)))
		malformed(() => ChangeSet.sequence(cs(Work), cs(Ledger)))
	})
})

/** The level check every entry point shares (`isLevelOf`): a ChangeSet admits a query over a
 * schema exactly when the query compiler would compile it against the ChangeSet's schema (querySchema), whatever the
 * pair: the schema itself, one of its levels, a root rebuilt under another name, a root of other content, or a schema
 * of no level. */
interface LevelSubject {
	readonly label: string
	readonly schema: object
	readonly relation: { readonly name: string }
}

const levelSubjects: Arr.NonEmptyReadonlyArray<LevelSubject> = [
	{ label: "Work", schema: Work, relation: Account },
	{ label: "Reports", schema: Reports, relation: Account },
	{ label: "Payroll", schema: Payroll, relation: Employer },
	{ label: "Reporting", schema: Reporting, relation: Employer }
]

/** The roots, each rebuilt from its own relations and statements under another name, with a relation added, or with
 * its last statement removed. */
interface LevelRoot {
	readonly label: string
	readonly renamed: (name: string) => object
	readonly relationAdded: object
	readonly statementRemoved: object
}
const Extra = relation("Extra", { id: uuid }, ["id"])
const levelRoots: Arr.NonEmptyReadonlyArray<LevelRoot> = [
	{
		label: "Work",
		renamed: (name) => schema(name, Work.relations, Work.statements),
		relationAdded: schema("Work", { ...Work.relations, Extra }, Work.statements),
		statementRemoved: schema("Work", Work.relations, Work.statements.slice(0, -1))
	},
	{
		label: "Payroll",
		renamed: (name) => schema(name, Payroll.relations, Payroll.statements),
		relationAdded: schema("Payroll", { ...Payroll.relations, Extra }, Payroll.statements),
		statementRemoved: schema("Payroll", Payroll.relations, Payroll.statements.slice(0, -1))
	}
]

/** The schema a case names: one of the fixtures, a root under a drawn name, a root with a relation added, or a root with
 * its last statement removed. */
type Named =
	| { readonly kind: "fixture"; readonly subject: LevelSubject }
	| { readonly kind: "renamed"; readonly feature: IdentifierFeature; readonly schema: object }
	| { readonly kind: "relation added"; readonly schema: object }
	| { readonly kind: "statement removed"; readonly schema: object }

type MemberOrderFeature =
	| "an array member"
	| "a query member"
	| "a Stream member"
	| "two members of one operation on one relation"
	| "a repeated member"

/** Where a hostile value sat in bind's map, or that the map was live throughout. */
type BindFeature = "a live map" | `${WildKind} as the map` | `${WildKind} as a fact`

type LevelPairFeature =
	| "the schema itself"
	| "a level"
	| "no level"
	| `renamed: ${IdentifierFeature}`
	| "a relation added"
	| "a statement removed"

const namedGen: Gen<Named> = oneOf([
	map(element(levelSubjects), (subject): Named => ({ kind: "fixture", subject })),
	map(
		filter(
			(source) => [source.draw(element(levelRoots)), source.draw(dictionaryNameGen)] as const,
			([root, name]) => root.label !== name.declared,
			100
		),
		([root, name]): Named => ({
			kind: "renamed",
			feature: name.feature,
			schema: root.renamed(name.declared)
		})
	),
	map(element(levelRoots), (root): Named => ({
		kind: "relation added",
		schema: root.relationAdded
	})),
	map(element(levelRoots), (root): Named => ({
		kind: "statement removed",
		schema: root.statementRemoved
	}))
])

describe("the level check", () => {
	it.effect(
		"admits a query over a schema exactly where the query compiler compiles it against the ChangeSet's schema",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/level-pairs",
						draw: drawn(
							(source) => [source.draw(element(levelSubjects)), source.draw(namedGen)] as const
						),
						literal: Formatter.format,
						coverage: required<LevelPairFeature>(
							[
								"the schema itself",
								"a level",
								"no level",
								"renamed: plain",
								"a relation added",
								"a statement removed"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([carried, named], c) =>
						Effect.sync(() => {
							const namedSchema = named.kind === "fixture" ? named.subject.schema : named.schema
							const q = query(carried.schema).rule((r: RuleValue) => {
								const vars = v(carried.relation, "relation")
								return r.match(carried.relation, vars).find(vars)
							})
							const input = queryInput(q)
							const compiles = input.ok && querySchema(input.value, schemaInputOf(namedSchema)).ok
							switch (named.kind) {
								case "fixture":
									c.note(
										named.subject === carried
											? "the schema itself"
											: compiles
												? "a level"
												: "no level"
									)
									break
								case "renamed":
									c.note(`renamed: ${named.feature}`)
									break
								case "relation added":
									c.note("a relation added")
									break
								case "statement removed":
									c.note("a statement removed")
									break
							}
							/** A refusal is a CompileError, never a defect: anything else thrown fails the case. */
							const admitted = catchCompileError(() =>
								ChangeSet.empty(namedSchema).read("r", () => q)
							).ok
							assert.equal(
								admitted,
								compiles,
								`a query over ${carried.label} in a ChangeSet over a ${named.kind} schema`
							)
						})
				)
			)
	)
})

describe("read-backs", () => {
	it("record a delta source per delta.added and delta.removed, of an ordinary relation only", () => {
		const a = cs(Work).read("gone", (delta: DeltaValue) =>
			query(Work).rule((r: RuleValue) => {
				const { task, note: n } = v(delta.removed(TaskNote), "removedTaskNote")
				return r.match(delta.removed(TaskNote), { task, note: n }).find({ task, note: n })
			})
		)
		const source = descOf(a).reads[0]?.query.stage
		assert.deepEqual(source?.kind === "rules" ? source.arms[0].matches[0]?.source : undefined, {
			kind: "delta",
			side: "removed",
			relation: "TaskNote"
		})
		malformed(() => cs(Work).read("bad", (delta: DeltaValue) => delta.added(Kind)))
	})

	it("refuse a second read-back of one name, across unions and strata too", () => {
		malformed(() => readBack(readBack(cs(Work))))
		malformed(() => ChangeSet.union(readBack(cs(Work)), readBack(cs(Work))))
		malformed(() => ChangeSet.sequence(readBack(cs(Work)), readBack(cs(Work))))
	})

	it("are sorted by name in the Description", () => {
		const d = descOf(
			cs(Work)
				.read("b", () => tasksOf)
				.read("a", () => tasksOf.orderBy(["id", "asc"]))
		)
		assert.deepEqual(
			Arr.map(d.reads, (r) => r.name),
			["a", "b"]
		)
	})

	it("accept only a function returning a query or an ordered query", () => {
		malformed(() => cs(Work).read("x", tasksOf))
		malformed(() => cs(Work).read("x", () => 1))
	})
})

describe("bind", () => {
	it("closes every parameter with a value carried beside the Description", () => {
		const bound = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
		assert.deepEqual(descOf(bound).bindings, ["operator", "task"])
		assert.equal(parsedOf(bound).values.get("task"), uuidOf(1))
	})

	it("requires a value for every parameter and none for a name the ChangeSet does not need", () => {
		malformed(() => switchToManual().bind({ task: uuidOf(1) }))
		malformed(() => switchToManual().bind({ task: uuidOf(1), operator: "ann", extra: 1 }))
		malformed(() => switchToManual().bind({ task: uuidOf(1), operator: null }))
	})

	/** The arm switch with a relation parameter beside its scalar ones: the notes it is bound to, inserted as they are. */
	const withNotes = (): ChangeSetValue =>
		switchToManual().insert(
			TaskNote,
			query(Work).rule((r: RuleValue) => {
				const { task, note: body } = v(TaskNote, "taskNote")
				return r
					.match(r.relation("notes", TaskNote), { task, note: body })
					.find({ task, note: body })
			})
		)
	/** A map, or a fact in its array, whose reading runs the caller's code and throws: an enumerable getter that throws,
	 * or a proxy whose every trap throws (getPrototypeOf and ownKeys among them). */
	const hostile: Arr.NonEmptyReadonlyArray<WildKind> = ["throwing-getter", "proxy"]

	it.effect(
		"reads the caller's map once: a map or a fact whose reading throws is refused, a live one bound as a copy",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/bind-host-read",
						draw: drawn(
							lsw({
								live: (source) => ({
									task: source.draw(map(int(0, 1000), uuidOf)),
									operator: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 8 })),
									notes: source.draw(
										array(
											lsw({ live: map(int(0, 1000), note), stale: Option.none(), wild: hostile }),
											{ min: 0, max: 4 }
										)
									)
								}),
								stale: Option.none(),
								wild: hostile
							})
						),
						literal: Formatter.format,
						coverage: required<BindFeature>(
							[
								"a live map",
								"throwing-getter as the map",
								"proxy as the map",
								"throwing-getter as a fact",
								"proxy as a fact"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(map, c) =>
						Effect.sync(() => {
							if (map.kind === "wild") {
								c.note(`${map.wild.kind} as the map`)
								malformed(() => withNotes().bind(passed(map)))
								return
							}
							const { task, operator, notes } = map.value
							const wild = Arr.flatMap(notes, (f) => (f.kind === "wild" ? [f.wild.kind] : []))
							if (wild.length > 0) {
								c.noteAll(Arr.map(wild, (kind): BindFeature => `${kind} as a fact`))
								malformed(() =>
									withNotes().bind({ task, operator, notes: Arr.map(notes, (f) => passed(f)) })
								)
								return
							}
							c.note("a live map")
							const facts = Arr.flatMap(notes, (f) => (f.kind === "wild" ? [] : [f.value]))
							const callers = Arr.map(facts, (f) => ({ ...f }))
							const bound = withNotes().bind({ task, operator, notes: callers })
							callers.push(note(1001))
							for (const f of callers) {
								f.note = "changed"
							}
							assert.deepEqual(Record.fromEntries(parsedOf(bound).values), {
								task,
								operator,
								notes: facts
							})
						})
				)
			)
	)

	/** Hygiene: a bound parameter leaves the ChangeSet's namespace, so a parameter of the same
	 * name added later, or brought by a combined ChangeSet, is a separate, free parameter. */
	const needsTask = query(Work).rule((r: RuleValue) =>
		r
			.match(Task, { id: r.param("task", Task.fields.id) })
			.find({ task: r.param("task", Task.fields.id), note: "x" })
	)

	/** A value's bindings, strings by their text and any other value by its formatted text. */
	const bindingValues = (value: unknown) =>
		Arr.sort(
			[...parsedOf(value).values.values()],
			Order.mapInput(Order.String, (v: unknown) =>
				typeof v === "string" ? v : Formatter.format(v)
			)
		)

	/**
	 * A value's parameters as its compilation holds them: how many its bindings close, and the names left free for its
	 * caller to bind, whatever private names the bound ones took.
	 */
	const parametersOf = (value: unknown) => {
		const bindings = descOf(value).bindings
		return {
			bound: bindings.length,
			free: Arr.filter(
				Arr.map(compiled(Work, value).params, (p) => p.name),
				(name) => !bindings.includes(name)
			)
		}
	}

	it("keeps a later member's or read-back's parameter of a bound name separate and free", () => {
		const bound = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
		const more = bound.insert(TaskNote, needsTask)
		assert.deepEqual(parametersOf(more), { bound: 2, free: ["task"] })
		assert.deepEqual(bindingValues(more), Arr.sort(["ann", uuidOf(1)], Order.String))
		/** The free task is bound on its own, to another value. */
		const fullyBound = more.bind({ task: uuidOf(2) })
		assert.deepEqual(
			bindingValues(fullyBound),
			Arr.sort(["ann", uuidOf(1), uuidOf(2)], Order.String)
		)
		assert.deepEqual(parametersOf(fullyBound), { bound: 3, free: [] })
		assert.deepEqual(compiled(Work, fullyBound).bindings, descOf(fullyBound).bindings)
		const read = bound.read("again", () => needsTask)
		const readBindings = descOf(read).bindings
		assert.equal(readBindings.length, 2)
		assert.ok(!readBindings.includes("task"), "the read-back's task is free")
		malformed(() => bound.bind({ task: uuidOf(2) }))
	})

	it("renames a private parameter out of the way of a free one spelled like it", () => {
		const bound = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
		const spelled = query(Work).rule((r: RuleValue) =>
			r
				.match(Task, { id: r.param("task#1", Task.fields.id) })
				.find({ task: r.param("task#1", Task.fields.id), note: "y" })
		)
		const more = bound.insert(TaskNote, needsTask).insert(TaskNote, spelled)
		assert.deepEqual(parametersOf(more), { bound: 2, free: ["task", "task#1"] })
		assert.deepEqual(bindingValues(more), Arr.sort(["ann", uuidOf(1)], Order.String))
	})

	it.effect("combines a bound ChangeSet with one whose parameter of that name is free", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/write/changeset/bound-beside-free",
					generator: element(["a union", "a sequence"] as const),
					literal: Formatter.format,
					limit: 2,
					coverage: noCoverage,
					caseHang
				},
				(how) =>
					Effect.sync(() => {
						const bound = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
						const combined =
							how === "a union"
								? ChangeSet.union(bound, switchToManual())
								: ChangeSet.sequence(switchToManual(), bound)
						assert.deepEqual(parametersOf(combined), { bound: 2, free: ["operator", "task"] })
						assert.deepEqual(bindingValues(combined), Arr.sort(["ann", uuidOf(1)], Order.String))
					})
			)
		)
	)

	it("combines two ChangeSets that bind one name to different values, and merges equal bindings", () => {
		const one = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
		const two = switchToManual().bind({ task: uuidOf(2), operator: "ann" })
		const both = ChangeSet.union(one, two)
		assert.deepEqual(parametersOf(both), { bound: 3, free: [] })
		assert.deepEqual(bindingValues(both), Arr.sort(["ann", uuidOf(1), uuidOf(2)], Order.String))
		assert.deepEqual(compiled(Work, both).bindings, descOf(both).bindings)
		assert.equal(text(ChangeSet.union(two, one)), text(both))
		const seq = ChangeSet.sequence(one, two)
		assert.deepEqual(parametersOf(seq), { bound: 3, free: [] })
		assert.deepEqual(bindingValues(seq), Arr.sort(["ann", uuidOf(1), uuidOf(2)], Order.String))
		/** Equal bindings of equal members are one member and one parameter. */
		const again = switchToManual().bind({ task: uuidOf(1), operator: "ann" })
		assert.equal(text(ChangeSet.union(one, again)), text(one))
		assert.deepEqual(descOf(ChangeSet.union(one, again)).bindings, descOf(one).bindings)
	})
})

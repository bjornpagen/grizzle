/** What the properties of value.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	accepted,
	type Answer,
	type Machine,
	type Real,
	refused as refusedVerdict,
	type StepFeature,
	took,
	type Verdict
} from "@bjornpagen/testing/commands"
import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import type { WildKind } from "@bjornpagen/testing/lsw"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { DecoderForm, FieldForm } from "#compiler/core/decoder.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties } from "#compiler/core/record.ts"
import {
	type ChangeSetDesc,
	descIdentity,
	descText,
	memberParamNames,
	type QueryDesc,
	queryParamNames,
	renameQueryParams,
	type WriteOp
} from "#compiler/ir/desc.ts"

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { queryOver as query, type QueryValue, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { record } from "#compiler/schema/record.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import type { QueryBase } from "#compiler/types/query/query.ts"
import {
	arraySlot,
	changeSetOver as ChangeSet,
	type ChangeSetValue,
	isChangeSetValue,
	parseChangeSet
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { throwsRefused } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { Employer, Payroll, Reporting } from "#test/support/fixtures/api/payroll.ts"
import {
	Account,
	Kind,
	ManualTask,
	Reports,
	Task,
	TaskNote,
	Work
} from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import {
	type Admitted,
	admittedNames,
	dictionaryNameGenOtherThan,
	type IdentifierFeature
} from "#test/support/kernel/dict.ts"
import {
	BookEntry,
	descOf,
	LedgerSchema,
	switchToManual,
	uuidOf
} from "#test/support/unit/write/changeset/fixtures.ts"
import { upTo } from "#test/support/up-to.ts"

/** The relation an extension of Work adds, so Work is a level of the extension and not the other way round. */
const Extra = relation("Extra", { id: Id }, ["id"])

const Ext = schema.extend([Work], "Ext", [Extra], [])

type LevelName = "Work" | "Ext" | "Ledger"

const levelValues: Readonly<Record<LevelName, object>> = { Work, Ext, Ledger: LedgerSchema }

/** The level of a schema value, by identity. */
const levelOfValue = (value: unknown): LevelName =>
	value === Work
		? "Work"
		: value === Ext
			? "Ext"
			: value === LedgerSchema
				? "Ledger"
				: assert.fail("a ChangeSet over one of the pool's levels")

/** The higher of two levels, or none when neither is a level of the other. */
const higherLevel = (a: LevelName, b: LevelName): LevelName | undefined =>
	a === b ? a : a === "Ledger" || b === "Ledger" ? undefined : "Ext"

/** The relations a member's array is written into: Work's, and the one only Ext holds. */
const writables = ["Task", "TaskNote", "ManualTask", "Extra"] as const

type Writable = (typeof writables)[number]

const writableValues: Readonly<Record<Writable, object>> = { Task, TaskNote, ManualTask, Extra }

/** A fact as a member's array carries it: its number, read back from the value's inputs. */
const factOf = (n: number): { id: string; n: number } => ({ id: uuidOf(n), n })

/** The number of a fact a value's input holds. */
const factNumber = (fact: unknown): number =>
	hasProperties(fact) && typeof fact["n"] === "number"
		? fact["n"]
		: assert.fail("an input fact the pool made")

/** The queries a member is written from, each over a relation, with the free parameters its shape names. */
const memberShapes = ["tasks", "byId", "spelled", "operator", "noted"] as const

type MemberShape = (typeof memberShapes)[number]

const shapeRelation: Readonly<Record<MemberShape, "Task" | "ManualTask" | "TaskNote">> = {
	tasks: "Task",
	byId: "Task",
	spelled: "Task",
	operator: "ManualTask",
	noted: "TaskNote"
}

/**
 * A member shape's query over `over`: every Task; the Task a parameter `p` names; the manual Task a parameter spelled
 * `p#1` names, as a private name of `p` would be spelled; a ManualTask of the Task `p` names with the operator `s`; a
 * note `s` on every Task.
 */
const memberQuery = (shape: MemberShape, over: object): QueryValue => {
	switch (shape) {
		case "tasks":
			return query(over).rule((r: RuleValue) => {
				const { id, account, kind } = v(Task, "task")
				return r.match(Task, { id, account, kind }).find({ id, account, kind })
			})
		case "byId":
			return query(over).rule((r: RuleValue) => {
				const { account, kind } = v(Task, "task")
				const id = r.param("p", Task.fields.id)
				return r.match(Task, { id, account, kind }).find({ id, account, kind })
			})
		case "spelled":
			return query(over).rule((r: RuleValue) => {
				const { account } = v(Task, "task")
				const id = r.param("p#1", Task.fields.id)
				return r.match(Task, { id, account, kind: "Manual" }).find({ id, account, kind: "Manual" })
			})
		case "operator":
			return query(over).rule((r: RuleValue) =>
				r.match(Task, { id: r.param("p", Task.fields.id), kind: "Manual" }).find({
					task: r.param("p", ManualTask.fields.task),
					operator: r.param("s", ManualTask.fields.operator)
				})
			)
		case "noted":
			return query(over).rule((r: RuleValue) => {
				const { id } = v(Task, "task")
				return r
					.match(Task, { id })
					.find({ task: id, note: r.param("s", ManualTask.fields.operator) })
			})
	}
}

/** The queries a read-back returns: a member shape's, every Task ordered, and the deltas of TaskNote, Task and Extra. */
const readShapes = [...memberShapes, "ordered", "added", "removed", "addedExtra"] as const

type ReadShape = (typeof readShapes)[number]

/** A read-back shape's callback, its query over `over`; the delta of Extra is over Ext, the one level holding it. */
const readBack =
	(shape: ReadShape, over: object) =>
	(delta: DeltaValue): unknown => {
		switch (shape) {
			case "tasks":
			case "byId":
			case "spelled":
			case "operator":
			case "noted":
				return memberQuery(shape, over)
			case "ordered":
				return memberQuery("tasks", over).orderBy(["id", "asc"])
			case "added":
				return query(over).rule((r: RuleValue) => {
					const { task, note } = v(delta.added(TaskNote), "addedNote")
					return r.match(delta.added(TaskNote), { task, note }).find({ task, note })
				})
			case "removed":
				return query(over).rule((r: RuleValue) => {
					const { account, kind } = v(delta.removed(Task), "removedTask")
					const id = r.param("p", Task.fields.id)
					return r.match(delta.removed(Task), { id, account, kind }).find({ id, account, kind })
				})
			case "addedExtra":
				return query(Ext).rule((r: RuleValue) => {
					const { id } = v(delta.added(Extra), "addedExtra")
					return r.match(delta.added(Extra), { id }).find({ id })
				})
		}
	}

/** A shape's query as a Description holds it, with its free parameters in walk order. */
interface Reference {
	readonly desc: QueryDesc
	readonly params: ReadonlyArray<string>
}

const referenceOf = (desc: QueryDesc): Reference => ({ desc, params: [...queryParamNames(desc)] })

const memberReferences: ReadonlyArray<readonly [MemberShape, Reference]> = Arr.map(
	memberShapes,
	(shape): readonly [MemberShape, Reference] => {
		const member = defined(
			descOf(
				ChangeSet.empty(Ext).insert(writableValues[shapeRelation[shape]], memberQuery(shape, Ext))
			).strata[0]?.members[0],
			"the shape's member"
		).member
		return member.kind === "query"
			? [shape, referenceOf(member.query)]
			: assert.fail("a query member")
	}
)

const readReferences: ReadonlyArray<readonly [ReadShape, Reference]> = Arr.map(
	readShapes,
	(shape): readonly [ReadShape, Reference] => [
		shape,
		referenceOf(
			defined(
				descOf(ChangeSet.empty(Ext).read("r", readBack(shape, Ext))).reads[0],
				"the read-back"
			).query
		)
	]
)

/**
 * Each read-back shape's field in the outcome's record of read-backs: the one field of the record a ChangeSet of that
 * read-back alone decodes.
 */
const readFields: ReadonlyArray<readonly [ReadShape, FieldForm]> = Arr.map(
	readShapes,
	(shape): readonly [ReadShape, FieldForm] => {
		const form = ChangeSet.empty(Ext).read("r", readBack(shape, Ext)).reads.form
		const [only, ...rest] = form.kind === "record" ? form.fields : []
		return only !== undefined && rest.length === 0 && only[0] === "r"
			? [shape, only[1]]
			: assert.fail("one read-back's decoder: one record of its one field")
	}
)

const paramsOf = (shape: ReadShape): ReadonlyArray<string> =>
	defined(
		Arr.findFirst(readReferences, ([s]) => s === shape).pipe(Option.getOrUndefined),
		"a shape's reference"
	)[1].params

/** A query member's or read-back's parameters: free, or bound to values in its shape's parameter order. */
type Binding =
	| { readonly kind: "free" }
	| { readonly kind: "bound"; readonly values: ReadonlyArray<string> }

const free: Binding = { kind: "free" }

type ModelMember =
	| {
			readonly kind: "array"
			readonly op: WriteOp
			readonly relation: Writable
			readonly facts: ReadonlyArray<number>
	  }
	| {
			readonly kind: "query"
			readonly op: WriteOp
			readonly shape: MemberShape
			readonly binding: Binding
	  }

const readNames = ["a", "b", "c"] as const

type ReadName = (typeof readNames)[number]

interface ModelRead {
	readonly name: ReadName
	readonly shape: ReadShape
	readonly binding: Binding
}

interface ModelChangeSet {
	readonly level: LevelName
	readonly strata: ReadonlyArray<ReadonlyArray<ModelMember>>
	readonly reads: ReadonlyArray<ModelRead>
}

/** The pool of ChangeSets a program has made, in order. */
interface Model {
	readonly handles: ReadonlyArray<ModelChangeSet>
}

const emptyOf = (level: LevelName): ModelChangeSet => ({ level, strata: [[]], reads: [] })

/** The free parameters of a ChangeSet: its free members' and read-backs' shapes'. */
const freeNames = (m: ModelChangeSet): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(m.strata, (stratum) =>
			Arr.flatMap(stratum, (member) =>
				member.kind === "query" && member.binding.kind === "free" ? paramsOf(member.shape) : []
			)
		),
		...Arr.flatMap(m.reads, (r) => (r.binding.kind === "free" ? paramsOf(r.shape) : []))
	])

/** The names a ChangeSet has bound: its bound members' and read-backs' shapes' parameters. */
const boundNamesOf = (m: ModelChangeSet): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(m.strata, (stratum) =>
			Arr.flatMap(stratum, (member) =>
				member.kind === "query" && member.binding.kind === "bound" ? paramsOf(member.shape) : []
			)
		),
		...Arr.flatMap(m.reads, (r) => (r.binding.kind === "bound" ? paramsOf(r.shape) : []))
	])

/** A value bound under a name, or a JavaScript caller's NULL. */
type BindValue = { readonly kind: "value"; readonly value: string } | { readonly kind: "null" }

interface BindEntry {
	readonly name: string
	readonly value: BindValue
}

type MemberSource =
	| { readonly kind: "array"; readonly relation: Writable; readonly facts: ReadonlyArray<number> }
	| { readonly kind: "query"; readonly shape: MemberShape; readonly over: "Work" | "Ext" }

/** The malformed calls a JavaScript caller can make, each on a valid ChangeSet of the pool. */
export const faults = [
	"a schema that is none",
	"a second schema",
	"an Ordered member",
	"a look-alike member",
	"a closed relation",
	"another schema's relation",
	"a closed relation of no schema",
	"a query over an unrelated schema",
	"a read-back that is no function",
	"a read-back that returns no query",
	"a delta of a closed relation",
	"a union with no ChangeSet",
	"a sequence of three",
	"an insertAll key of a closed relation",
	"an insertAll key of no relation",
	"an insertAll record with a symbol key",
	"an insertAll record that is no plain record",
	"an insertAll record whose reading throws"
] as const

type Fault = (typeof faults)[number]

interface Params {
	readonly begin: { readonly level: LevelName }
	readonly write: { readonly handle: number; readonly op: WriteOp; readonly source: MemberSource }
	readonly read: {
		readonly handle: number
		readonly name: ReadName
		readonly shape: ReadShape
		readonly over: "Work" | "Ext"
	}
	readonly bind: { readonly handle: number; readonly values: ReadonlyArray<BindEntry> }
	/** One ChangeSet bound twice, to two maps of values for its free parameters, and the two combined by union. */
	readonly fork: {
		readonly handle: number
		readonly first: ReadonlyArray<BindEntry>
		readonly second: ReadonlyArray<BindEntry>
	}
	readonly union: { readonly a: number; readonly b: number }
	readonly sequence: { readonly a: number; readonly b: number }
	readonly fault: { readonly handle: number; readonly fault: Fault }
}

/** Every refusal of the builder is one reason. */
type Refusal = Extract<CompileReasonTag, "MalformedDescription">

const malformedTag: Refusal = "MalformedDescription"

/** The rule a refused step breaks, as its feature names it. */
type Rule =
	| "unrelated levels"
	| "one read-back name over two queries"
	| "an extra value"
	| "a NULL value"
	| "a query over a higher level"
	| "a relation of a higher level"
	| "a delta outside the level"

const handleOf = (m: Model, i: number): ModelChangeSet => defined(m.handles[i], "a handle")

/** The model with one handle more. */
const made = (m: Model, next: ModelChangeSet): Model => ({ handles: [...m.handles, next] })

const withMember = (c: ModelChangeSet, member: ModelMember): ModelChangeSet => ({
	...c,
	strata: Arr.map(c.strata, (stratum, i) =>
		i === c.strata.length - 1 ? [...stratum, member] : stratum
	)
})

const writeRule = (m: Model, p: Params["write"]): Rule | undefined => {
	const level = handleOf(m, p.handle).level
	if (level !== "Work") {
		return undefined
	}
	return p.source.kind === "query"
		? p.source.over === "Ext"
			? "a query over a higher level"
			: undefined
		: p.source.relation === "Extra"
			? "a relation of a higher level"
			: undefined
}

/** Whether two bindings of one shape bind its parameters alike: both free, or both to the same values. */
const sameBinding = (a: Binding, b: Binding): boolean =>
	a.kind === "free"
		? b.kind === "free"
		: b.kind === "bound" &&
			a.values.length === b.values.length &&
			Arr.every(Arr.zip(a.values, b.values), ([x, y]) => x === y)

/** Whether two read-backs are one: one name over one query, a query being its shape and its binding. */
const sameRead = (a: ModelRead, b: ModelRead): boolean =>
	a.name === b.name && a.shape === b.shape && sameBinding(a.binding, b.binding)

/** Whether read-backs of `b` read a name of `a`'s over another query. */
const clashingReads = (a: ReadonlyArray<ModelRead>, b: ReadonlyArray<ModelRead>): boolean =>
	Arr.some(a, (r) => Arr.some(b, (q) => q.name === r.name && !sameRead(r, q)))

/**
 * The read-backs of `a` and `b` as one set (write/changeset/value.ts readBackSet): `a`'s, then each of `b`'s whose name
 * `a` does not read, a read-back of one name over one query being one read-back, read once after the whole ChangeSet.
 */
const joinReads = (
	a: ReadonlyArray<ModelRead>,
	b: ReadonlyArray<ModelRead>
): ReadonlyArray<ModelRead> => [
	...a,
	...Arr.filter(b, (q) => !Arr.some(a, (r) => r.name === q.name))
]

/** A read-back `p` adds to its handle: its name and shape, free. */
const readOfStep = (p: Params["read"]): ModelRead => ({
	name: p.name,
	shape: p.shape,
	binding: free
})

const readRule = (m: Model, p: Params["read"]): Rule | undefined => {
	const c = handleOf(m, p.handle)
	return clashingReads(c.reads, [readOfStep(p)])
		? "one read-back name over two queries"
		: c.level === "Work" && p.shape === "addedExtra"
			? "a delta outside the level"
			: c.level === "Work" && p.over === "Ext"
				? "a query over a higher level"
				: undefined
}

const bindRule = (m: Model, p: Params["bind"]): Rule | undefined => {
	const names = freeNames(handleOf(m, p.handle))
	const given = new Set(Arr.map(p.values, (e) => e.name))
	return Arr.some([...given], (name) => !names.has(name))
		? "an extra value"
		: Arr.some(p.values, (e) => e.value.kind === "null")
			? "a NULL value"
			: undefined
}

const combineRule = (m: Model, p: Params["union"]): Rule | undefined => {
	const a = handleOf(m, p.a)
	const b = handleOf(m, p.b)
	return higherLevel(a.level, b.level) === undefined
		? "unrelated levels"
		: clashingReads(a.reads, b.reads)
			? "one read-back name over two queries"
			: undefined
}

/** The rule a fork breaks: the read-backs of its two bindings, one name over two queries. */
const forkRule = (c: ModelChangeSet, p: Params["fork"]): Rule | undefined =>
	clashingReads(bound(c, p.first).reads, bound(c, p.second).reads)
		? "one read-back name over two queries"
		: undefined

/** The binding a free member or read-back of `shape` takes from bind's values. */
const boundBy = (
	shape: ReadShape,
	binding: Binding,
	values: ReadonlyMap<string, string>
): Binding =>
	binding.kind === "bound" || paramsOf(shape).length === 0
		? binding
		: {
				kind: "bound",
				values: Arr.map(paramsOf(shape), (name) => defined(values.get(name), "a bound value"))
			}

const bound = (c: ModelChangeSet, entries: ReadonlyArray<BindEntry>): ModelChangeSet => {
	const values = new Map(
		Arr.flatMap(entries, (e) =>
			e.value.kind === "value" ? [[e.name, e.value.value] as const] : []
		)
	)
	return {
		...c,
		strata: Arr.map(c.strata, (stratum) =>
			Arr.map(stratum, (member) =>
				member.kind === "query"
					? { ...member, binding: boundBy(member.shape, member.binding, values) }
					: member
			)
		),
		reads: Arr.map(c.reads, (r) => ({ ...r, binding: boundBy(r.shape, r.binding, values) }))
	}
}

const unionOf = (a: ModelChangeSet, b: ModelChangeSet): ModelChangeSet => ({
	level: defined(higherLevel(a.level, b.level), "related levels"),
	strata: upTo(Math.max(a.strata.length, b.strata.length), (i) => [
		...(a.strata[i] ?? []),
		...(b.strata[i] ?? [])
	]),
	reads: joinReads(a.reads, b.reads)
})

const sequenceOf = (a: ModelChangeSet, b: ModelChangeSet): ModelChangeSet => ({
	level: defined(higherLevel(a.level, b.level), "related levels"),
	strata: [...a.strata, ...b.strata],
	reads: joinReads(a.reads, b.reads)
})

/** The verdict of a step whose rule, when it has one, refuses it. */
const judged = (rule: Rule | undefined, next: () => Model): Verdict<Model, Refusal> =>
	rule === undefined ? accepted(next()) : refusedVerdict(malformedTag)

const memberOps: Arr.NonEmptyReadonlyArray<WriteOp> = ["insert", "delete", "put"]

/** A handle the members and read-backs are written into: one over Work or Ext. */
const writableHandles = (m: Model): ReadonlyArray<number> =>
	Arr.flatMap(m.handles, (c, i) => (c.level === "Ledger" ? [] : [i]))

/** One of the handles `xs`, the latest most often, so a program grows one ChangeSet through many steps. */
const pickOf = (xs: ReadonlyArray<number>): Gen<number> =>
	weighted([
		[3, constant(defined(xs.at(-1), "a pooled index"))],
		[1, map(int(0, xs.length - 1), (i) => defined(xs[i], "a pooled index"))]
	])

const anyHandle = (m: Model): Gen<number> => pickOf(Arr.map(m.handles, (_, i) => i))

/**
 * The ChangeSets to combine: any two handles, or as often a handle and one over another level than its or of another
 * number of strata, so a union and a sequence meet a higher level and a level unrelated to theirs, and a union meets
 * strata one side alone holds.
 */
const pairOf =
	(m: Model): Gen<{ readonly a: number; readonly b: number }> =>
	(s) => {
		const a = s.draw(anyHandle(m))
		const { level, strata } = handleOf(m, a)
		const other = Arr.flatMap(m.handles, (c, i) =>
			c.level === level && c.strata.length === strata.length ? [] : [i]
		)
		return {
			a,
			b: s.draw(other.length === 0 ? anyHandle(m) : oneOf([anyHandle(m), pickOf(other)]))
		}
	}

/**
 * A handle to write a member into: any writable one, or as often one that has bound a name, where a member may meet
 * it (sourceOn).
 */
const writeHandle = (m: Model): Gen<number> => {
	const writable = writableHandles(m)
	const binding = Arr.filter(writable, (i) => boundNamesOf(handleOf(m, i)).size > 0)
	return binding.length === 0 ? pickOf(writable) : oneOf([pickOf(writable), pickOf(binding)])
}

/** A handle to bind: one with free parameters most often, when there is one. */
const bindHandle = (m: Model): Gen<number> => {
	const open = Arr.flatMap(m.handles, (c, i) => (freeNames(c).size > 0 ? [i] : []))
	return open.length === 0
		? anyHandle(m)
		: weighted([
				[3, pickOf(open)],
				[1, anyHandle(m)]
			])
}

/**
 * A handle to fork: as bindHandle draws one; as often one of no read-back whose free parameters name one it has
 * bound, so the two bindings put members of one shape beside a private parameter one of them shares; and as often one
 * with a read-back, so the two bindings meet at each of its names, one read-back where they bind its query alike and
 * refused where they do not.
 */
const forkHandle = (m: Model): Gen<number> => {
	const meeting = Arr.flatMap(m.handles, (c, i) => {
		const bound = boundNamesOf(c)
		return c.reads.length === 0 && Arr.some([...freeNames(c)], (name) => bound.has(name)) ? [i] : []
	})
	const reading = Arr.flatMap(m.handles, (c, i) => (c.reads.length > 0 ? [i] : []))
	return oneOf([
		bindHandle(m),
		...(meeting.length === 0 ? [] : [pickOf(meeting)]),
		...(reading.length === 0 ? [] : [pickOf(reading)])
	])
}

/**
 * A fork's second binding of the free parameters `names` of the ChangeSet `c`: drawn as its first is; where `c` has
 * bound one of them, as often the first with that name's other value, so the two members of one shape it binds tie
 * beside the private parameter one of them shares; and where `c` has a read-back, as often the first itself, so each
 * of its read-backs meets itself bound alike.
 */
const secondOf = (
	c: ModelChangeSet,
	names: ReadonlyArray<string>,
	first: ReadonlyArray<BindEntry>
): Gen<ReadonlyArray<BindEntry>> => {
	const bound = boundNamesOf(c)
	const shared = Arr.filter(names, (name) => bound.has(name))
	const apart: ReadonlyArray<Gen<ReadonlyArray<BindEntry>>> = Arr.isReadonlyArrayNonEmpty(shared)
		? [
				(s) => {
					const name = s.draw(element(shared))
					return Arr.map(first, (e): BindEntry =>
						e.name === name && e.value.kind === "value"
							? { name, value: { kind: "value", value: otherValue(name, e.value.value) } }
							: e
					)
				}
			]
		: []
	return oneOf([valuesGen(names), ...apart, ...(c.reads.length === 0 ? [] : [constant(first)])])
}

/** A member's shape, those with parameters most often, so bound and free parameters of one name meet. */
const shapeGen: Gen<MemberShape> = weighted<MemberShape>([
	[3, constant("byId")],
	[2, constant("spelled")],
	[2, constant("operator")],
	[1, constant("noted")],
	[1, constant("tasks")]
])

/**
 * The member shapes that meet a name the ChangeSet `c` has bound: each that names it again, and, beside a bound p,
 * `spelled`, which spells p as its private name would be (p#1).
 */
const meetingShapes = (c: ModelChangeSet): ReadonlyArray<MemberShape> => {
	const bound = boundNamesOf(c)
	return Arr.filter(memberShapes, (shape) =>
		shape === "spelled" ? bound.has("p") : Arr.some(paramsOf(shape), (name) => bound.has(name))
	)
}

/** A member's source: an array of facts, or a query of any shape over Work or Ext. */
const sourceGen: Gen<MemberSource> = oneOf<MemberSource>([
	(s) => ({
		kind: "array",
		relation: s.draw(element(writables)),
		facts: s.draw(array(int(1, 4), { min: 0, max: 3 }))
	}),
	(s) => ({
		kind: "query",
		shape: s.draw(shapeGen),
		over: s.draw(element(["Work", "Ext"] as const))
	})
])

/**
 * A member's source on the ChangeSet `c`: as sourceGen draws one, or, where `c` has bound a name, as often a query
 * of a shape that meets it (meetingShapes) over a level `c` admits, so a free parameter meets a private one of its name
 * or of its spelling.
 */
const sourceOn = (c: ModelChangeSet): Gen<MemberSource> => {
	const meeting = meetingShapes(c)
	return Arr.isReadonlyArrayNonEmpty(meeting)
		? weighted<MemberSource>([
				[1, sourceGen],
				[
					3,
					(s) => ({
						kind: "query",
						shape: s.draw(element(meeting)),
						over: c.level === "Work" ? "Work" : s.draw(element(["Work", "Ext"] as const))
					})
				]
			])
		: sourceGen
}

/** A read-back's shape: a member shape's query, every Task ordered, or a delta, each kind as often as another. */
const readShapeGen: Gen<ReadShape> = oneOf<ReadShape>([
	element(memberShapes),
	constant("ordered"),
	element(["added", "removed", "addedExtra"] as const)
])

/** The values a parameter name takes: a uuid of two, or a text of two under s, so equal values meet. */
const valuesOf = (name: string): readonly [string, string] =>
	name === "s" ? ["a", "b"] : [uuidOf(1), uuidOf(2)]

/** A value under a parameter name. */
const valueFor = (name: string): Gen<string> => element(valuesOf(name))

/** The value under a parameter name other than `value`. */
const otherValue = (name: string, value: string): string => {
	const [first, second] = valuesOf(name)
	return value === first ? second : first
}

/**
 * How bind's values depart from the free parameters: not at all, one more, or one NULL. bind closes the names it is
 * given and leaves the rest free, a member then half bound, which this model's bindings, a member's every parameter
 * bound or none, do not hold: a bind that names some free parameters is test/pg/served/bound-rows' and
 * test/unit/write/bound-rows' (a write's relation parameter bound, its other parameters left to the call).
 */
type Flaw = "none" | "extra" | "null"

/** A value for every free parameter. */
const valuesGen =
	(names: ReadonlyArray<string>): Gen<ReadonlyArray<BindEntry>> =>
	(s) =>
		Arr.map(names, (name): BindEntry => ({
			name,
			value: { kind: "value", value: s.draw(valueFor(name)) }
		}))

/** The values bind is given: one for every free parameter, or that with one more, or one NULL. */
const bindValuesGen =
	(names: ReadonlyArray<string>): Gen<ReadonlyArray<BindEntry>> =>
	(s) => {
		const entries = s.draw(valuesGen(names))
		const extraNames = Arr.filter(["p", "s", "p#1", "x"] as const, (n) => !names.includes(n))
		const flaws: ReadonlyArray<Flaw> = [
			...(entries.length > 0 ? (["null"] as const) : []),
			...(extraNames.length > 0 ? (["extra"] as const) : [])
		]
		const flaw = s.draw(
			Arr.isReadonlyArrayNonEmpty(flaws)
				? weighted<Flaw>([
						[3, constant("none")],
						[1, element(flaws)]
					])
				: constant("none")
		)
		switch (flaw) {
			case "none":
				return entries
			case "null": {
				const at = s.draw(int(0, entries.length - 1))
				return Arr.map(entries, (e, i): BindEntry =>
					i === at ? { name: e.name, value: { kind: "null" } } : e
				)
			}
			case "extra": {
				const name = defined(extraNames[s.draw(int(0, extraNames.length - 1))], "an extra name")
				return [...entries, { name, value: { kind: "value", value: s.draw(valueFor(name)) } }]
			}
		}
	}

export const machine: Machine<Model, Params, Refusal> = {
	initial: { handles: [emptyOf("Work")] },
	commands: {
		begin: {
			weight: 2,
			applies: () => true,
			parameters: () => map(element(["Work", "Ext", "Ledger"] as const), (level) => ({ level })),
			judge: (m, p) => accepted(made(m, emptyOf(p.level)))
		},
		write: {
			weight: 8,
			applies: (m) => writableHandles(m).length > 0,
			parameters: (m) => (s) => {
				const handle = s.draw(writeHandle(m))
				return {
					handle,
					op: s.draw(element(memberOps)),
					source: s.draw(sourceOn(handleOf(m, handle)))
				}
			},
			judge: (m, p) =>
				judged(writeRule(m, p), () => {
					const c = handleOf(m, p.handle)
					const source = p.source
					switch (source.kind) {
						case "array":
							return made(
								m,
								withMember(c, {
									kind: "array",
									op: p.op,
									relation: source.relation,
									facts: source.facts
								})
							)
						case "query":
							return made(
								m,
								withMember(c, { kind: "query", op: p.op, shape: source.shape, binding: free })
							)
					}
				})
		},
		read: {
			weight: 2,
			applies: (m) => writableHandles(m).length > 0,
			parameters: (m) => (s) => {
				const handle = s.draw(pickOf(writableHandles(m)))
				const again = Arr.filter(handleOf(m, handle).reads, (r) => r.binding.kind === "free")
				const fresh: Gen<Pick<ModelRead, "name" | "shape">> = (t) => ({
					name: t.draw(element(readNames)),
					shape: t.draw(readShapeGen)
				})
				const { name, shape } = s.draw(
					Arr.isReadonlyArrayNonEmpty(again) ? oneOf([fresh, element(again)]) : fresh
				)
				return { handle, name, shape, over: s.draw(element(["Work", "Ext"] as const)) }
			},
			judge: (m, p) =>
				judged(readRule(m, p), () => {
					const c = handleOf(m, p.handle)
					return made(m, { ...c, reads: joinReads(c.reads, [readOfStep(p)]) })
				})
		},
		bind: {
			weight: 5,
			applies: () => true,
			parameters: (m) => (s) => {
				const handle = s.draw(bindHandle(m))
				return {
					handle,
					values: s.draw(bindValuesGen([...freeNames(handleOf(m, handle))]))
				}
			},
			judge: (m, p) => judged(bindRule(m, p), () => made(m, bound(handleOf(m, p.handle), p.values)))
		},
		fork: {
			weight: 4,
			applies: () => true,
			parameters: (m) => (s) => {
				const handle = s.draw(forkHandle(m))
				const names = [...freeNames(handleOf(m, handle))]
				const first = s.draw(valuesGen(names))
				return { handle, first, second: s.draw(secondOf(handleOf(m, handle), names, first)) }
			},
			judge: (m, p) => {
				const c = handleOf(m, p.handle)
				return judged(forkRule(c, p), () => made(m, unionOf(bound(c, p.first), bound(c, p.second))))
			}
		},
		union: {
			weight: 4,
			applies: () => true,
			parameters: pairOf,
			judge: (m, p) =>
				judged(combineRule(m, p), () => made(m, unionOf(handleOf(m, p.a), handleOf(m, p.b))))
		},
		sequence: {
			weight: 2,
			applies: () => true,
			parameters: pairOf,
			judge: (m, p) =>
				judged(combineRule(m, p), () => made(m, sequenceOf(handleOf(m, p.a), handleOf(m, p.b))))
		},
		fault: {
			weight: 6,
			applies: (m) => writableHandles(m).length > 0,
			parameters: (m) => (s) => ({
				handle: s.draw(pickOf(writableHandles(m))),
				fault: s.draw(element(faults))
			}),
			judge: () => refusedVerdict(malformedTag)
		}
	}
}

/** A query member as the canonical form holds it: its shape and binding. */
interface CanonQuery {
	readonly shape: MemberShape
	readonly binding: Binding
}

/** The members of one operation on one relation in one stratum. */
interface CanonGroup {
	readonly relation: string
	readonly op: WriteOp
	/** The one array member's facts, sorted, when there is one. */
	readonly arrays: ReadonlyArray<ReadonlyArray<number>>
	readonly queries: ReadonlyArray<CanonQuery>
}

interface CanonRead {
	readonly name: string
	readonly shape: ReadShape
	readonly binding: Binding
}

/** A ChangeSet's meaning, the same for the model's and for the real value read back. */
interface Canon {
	readonly level: LevelName
	readonly strata: ReadonlyArray<ReadonlyArray<CanonGroup>>
	readonly reads: ReadonlyArray<CanonRead>
}

const bindingOrder: Order.Order<Binding> = Order.make((a, b) =>
	a.kind === "free"
		? b.kind === "free"
			? 0
			: -1
		: b.kind === "free"
			? 1
			: Order.Array(Order.String)(a.values, b.values)
)

const queryOrder: Order.Order<CanonQuery> = Order.combine(
	Order.mapInput(Order.String, (q: CanonQuery) => q.shape),
	Order.mapInput(bindingOrder, (q: CanonQuery) => q.binding)
)

const groupOrder: Order.Order<GroupKey> = Order.combine(
	Order.mapInput(Order.String, (g: GroupKey) => g.relation),
	Order.mapInput(Order.String, (g: GroupKey) => g.op)
)

const memberRelation = (m: ModelMember): string =>
	m.kind === "query" ? shapeRelation[m.shape] : m.relation

/** Where a member is: its relation and operation. */
interface GroupKey {
	readonly relation: string
	readonly op: WriteOp
}

/** A run of consecutive items of one operation on one relation. */
interface GroupRun<A> extends GroupKey {
	readonly items: ReadonlyArray<A>
}

/** Runs of consecutive items of one operation on one relation. */
const runsOf = <A>(
	items: ReadonlyArray<A>,
	key: (a: A) => GroupKey
): ReadonlyArray<GroupRun<A>> => {
	const runs: Array<GroupRun<A>> = []
	for (const item of items) {
		const k = key(item)
		const last = runs.at(-1)
		if (last !== undefined && last.relation === k.relation && last.op === k.op) {
			runs[runs.length - 1] = { ...last, items: [...last.items, item] }
		} else {
			runs.push({ relation: k.relation, op: k.op, items: [item] })
		}
	}
	return runs
}

/** The model's read-backs in name order. */
const readsInOrder = (c: ModelChangeSet): ReadonlyArray<ModelRead> =>
	Arr.sort(
		c.reads,
		Order.mapInput(Order.String, (r: ModelRead) => r.name)
	)

/**
 * The decoder of the model's outcome record of read-backs, as a served file holds it: one record, in name order, each
 * read-back's field under its name (readFields), whatever order its read-backs were read, combined or bound in.
 */
const readsForm = (c: ModelChangeSet): DecoderForm => ({
	kind: "record",
	fields: Arr.map(readsInOrder(c), (r): readonly [string, FieldForm] => [
		r.name,
		defined(
			Arr.findFirst(readFields, ([shape]) => shape === r.shape).pipe(Option.getOrUndefined),
			"a shape's field"
		)[1]
	])
})

/** The model's ChangeSet in canonical form (see the header). */
const canonOf = (c: ModelChangeSet): Canon => ({
	level: c.level,
	strata: Arr.map(c.strata, (stratum) =>
		Arr.map(
			runsOf(
				Arr.sort(
					stratum,
					Order.mapInput(groupOrder, (m: ModelMember) => ({
						relation: memberRelation(m),
						op: m.op
					}))
				),
				(m) => ({ relation: memberRelation(m), op: m.op })
			),
			(run): CanonGroup => {
				const arrays = Arr.flatMap(run.items, (m) => (m.kind === "array" ? [m.facts] : []))
				return {
					relation: run.relation,
					op: run.op,
					arrays: arrays.length === 0 ? [] : [Arr.sort(Arr.flatten(arrays), Order.Number)],
					queries: Arr.sort(
						Arr.dedupeWith(
							Arr.flatMap(run.items, (m) =>
								m.kind === "query" ? [{ shape: m.shape, binding: m.binding }] : []
							),
							(a, b) => queryOrder(a, b) === 0
						),
						queryOrder
					)
				}
			}
		)
	),
	reads: Arr.sort(
		Arr.map(c.reads, (r): CanonRead => ({ name: r.name, shape: r.shape, binding: r.binding })),
		Order.mapInput(Order.String, (r: CanonRead) => r.name)
	)
})

/** The identity digest of a Description, by which a stratum orders its described members. */
const identityOf = (desc: unknown): string => {
	const d = descIdentity(desc)
	return d.ok ? d.value : assert.fail(`a Description's identity: ${d.error.message}`)
}

/** The canonical identity text of a Description. */
const textOf = (desc: unknown): string => {
	const t = descText(desc)
	return t.ok ? t.value : assert.fail(`a Description's text: ${t.error.message}`)
}

const valueText = (value: ChangeSetValue): string => textOf(descOf(value))

/**
 * The shape and binding of a query a Description holds: the one shape whose query, its parameters renamed in walk
 * order to the query's own, has the query's text; bound when every parameter it uses is one bind closed, each value
 * the one the ChangeSet carries under that private name, and free when none is, under the shape's own names.
 */
const recognised = <S extends string>(
	q: QueryDesc,
	references: ReadonlyArray<readonly [S, Reference]>,
	bindings: ReadonlySet<string>,
	values: ReadonlyMap<string, unknown>
): { readonly shape: S; readonly binding: Binding } => {
	const used = [...queryParamNames(q)]
	const text = textOf(q)
	const shapes = Arr.filter(
		references,
		([, ref]) =>
			ref.params.length === used.length &&
			textOf(renameQueryParams(ref.desc, new Map(Arr.zip(ref.params, used)))) === text
	)
	const [only, ...more] = shapes
	if (only === undefined || more.length > 0) {
		return assert.fail("a query of exactly one of the pool's shapes")
	}
	const [shape, ref] = only
	if (Arr.every(used, (name) => !bindings.has(name))) {
		assert.deepEqual(used, [...ref.params], "a free parameter keeps its own name")
		return { shape, binding: free }
	}
	if (!Arr.every(used, (name) => bindings.has(name))) {
		return assert.fail("a member's parameters all bound or all free")
	}
	return {
		shape,
		binding: {
			kind: "bound",
			values: Arr.map(used, (name) => {
				const value = values.get(name)
				return typeof value === "string" ? value : assert.fail("a bound value of the pool")
			})
		}
	}
}

/** Every parameter a Description's members and read-backs use. */
const usedParams = (desc: ChangeSetDesc): ReadonlySet<string> =>
	new Set([
		...Arr.flatMap(desc.strata, (stratum) =>
			Arr.flatMap(stratum.members, (m) => [...memberParamNames(m.member)])
		),
		...Arr.flatMap(desc.reads, (r) => [...queryParamNames(r.query)])
	])

const kindRank = { array: 0, query: 1, equal: 2, computed: 3 } as const

/**
 * The real value read back into the canonical form, and held to the invariants the form does not show: members sorted
 * by relation, operation, kind and query identity digest (ir/desc.ts descIdentity), read-backs by name and bindings by name; each array member at
 * the slot its place names, its input there and nothing else; every input's facts frozen; and every binding one the
 * members or read-backs use, with its value carried.
 */
const readBackValue = (value: ChangeSetValue): Canon => {
	const parsed = defined(parseChangeSet(value), "a ChangeSet value's parse")
	const desc = parsed.desc
	const bindings = new Set(desc.bindings)
	assert.deepEqual([...desc.bindings], Arr.sort(desc.bindings, Order.String), "bindings by name")
	assert.deepEqual(
		Arr.sort([...parsed.values.keys()], Order.String),
		[...desc.bindings],
		"a value for every binding"
	)
	const used = usedParams(desc)
	assert.ok(
		Arr.every(desc.bindings, (name) => used.has(name)),
		"every binding is used"
	)
	assert.deepEqual(
		Arr.map(desc.reads, (r) => r.name),
		Arr.sort(
			Arr.map(desc.reads, (r) => r.name),
			Order.String
		),
		"read-backs by name"
	)
	let slots = 0
	const strata = Arr.map(desc.strata, (stratum, s) => {
		const sortKeys = Arr.map(stratum.members, (m) => ({
			relation: m.relation,
			op: m.op,
			kind: kindRank[m.member.kind],
			identity:
				m.member.kind === "query" || m.member.kind === "computed"
					? identityOf(m.member.query)
					: m.member.kind === "equal"
						? identityOf(m.member.fields)
						: ""
		}))
		assert.deepEqual(
			sortKeys,
			Arr.sort(
				sortKeys,
				Order.combineAll([
					Order.mapInput(Order.String, (k: (typeof sortKeys)[number]) => k.relation),
					Order.mapInput(Order.String, (k: (typeof sortKeys)[number]) => k.op),
					Order.mapInput(Order.Number, (k: (typeof sortKeys)[number]) => k.kind),
					Order.mapInput(Order.String, (k: (typeof sortKeys)[number]) => k.identity)
				])
			),
			"members by relation, operation, kind and identity digest"
		)
		return Arr.map(
			runsOf(stratum.members, (m) => ({ relation: m.relation, op: m.op })),
			(run): CanonGroup => {
				const arrays: Array<ReadonlyArray<number>> = []
				const queries: Array<CanonQuery> = []
				for (const m of run.items) {
					const source = m.member
					switch (source.kind) {
						case "array": {
							slots += 1
							assert.equal(source.slot, arraySlot(s, m.op, m.relation), "an array's slot")
							const input = parsed.inputs.get(source.slot)
							if (input === undefined) {
								return assert.fail("an array member's facts at its slot")
							}
							assert.ok(
								Object.isFrozen(input) && Arr.every(input, (f) => Object.isFrozen(f)),
								"an array member's facts are frozen"
							)
							arrays.push(Arr.sort(Arr.map(input, factNumber), Order.Number))
							break
						}
						case "query":
							queries.push(
								recognisedMember(
									recognised(source.query, memberReferences, bindings, parsed.values),
									m.relation
								)
							)
							break
						case "equal":
							return assert.fail("a field-equality member, which no step of the program makes")
						case "computed":
							return assert.fail("an insert's computed fields, which no step of the program makes")
					}
				}
				return {
					relation: run.relation,
					op: run.op,
					arrays,
					queries: Arr.sort(queries, queryOrder)
				}
			}
		)
	})
	assert.equal(parsed.inputs.size, slots, "an input for every array member, and no other")
	return {
		level: levelOfValue(parsed.over.value),
		strata,
		reads: Arr.map(desc.reads, (r): CanonRead => {
			const read = recognised(r.query, readReferences, bindings, parsed.values)
			return { name: r.name, shape: read.shape, binding: read.binding }
		})
	}
}

/** A recognised query member, written into its shape's relation. */
const recognisedMember = (
	q: { readonly shape: MemberShape; readonly binding: Binding },
	relationName: string
): CanonQuery => {
	assert.equal(relationName, shapeRelation[q.shape], "a query member into its shape's relation")
	return q
}

/** A ChangeSet with every parameter of `shape` bound as `binding` says. */
const boundAs = (c: ChangeSetValue, shape: ReadShape, binding: Binding): ChangeSetValue =>
	binding.kind === "free" ? c : c.bind(Rec.fromEntries(Arr.zip(paramsOf(shape), binding.values)))

/**
 * The model's ChangeSet built in normal form: each member and read-back a ChangeSet of its own over the model's level,
 * bound alone; the members of each stratum and, in the first, the read-backs after them, combined by union in the order
 * `orders` gives each stratum's, a permutation of its positions; and the strata by sequence. Build order never shows in
 * a Description, so every order gives the value's.
 */
const normalForm = (
	c: ModelChangeSet,
	orders: ReadonlyArray<ReadonlyArray<number>>
): ChangeSetValue => {
	const level = levelValues[c.level]
	const one = (m: ModelMember): ChangeSetValue => {
		const empty = ChangeSet.empty(level)
		switch (m.kind) {
			case "array":
				return empty[m.op](writableValues[m.relation], Arr.map(m.facts, factOf))
			case "query":
				return boundAs(
					empty[m.op](writableValues[shapeRelation[m.shape]], memberQuery(m.shape, Work)),
					m.shape,
					m.binding
				)
		}
	}
	const reads = Arr.map(c.reads, (r) =>
		boundAs(ChangeSet.empty(level).read(r.name, readBack(r.shape, Work)), r.shape, r.binding)
	)
	const strata = Arr.map(c.strata, (stratum, i) => {
		const units = [...Arr.map(stratum, one), ...(i === 0 ? reads : [])]
		return Arr.reduce(defined(orders[i], "a stratum's order"), ChangeSet.empty(level), (x, at) =>
			ChangeSet.union(x, defined(units[at], "a unit of the stratum"))
		)
	})
	const [first, ...rest] = strata
	return Arr.reduce(rest, defined(first, "a first stratum"), (x, y) => ChangeSet.sequence(x, y))
}

/** How many units a normal form combines in each stratum: its members, and in the first the read-backs too. */
const unitCounts = (c: ModelChangeSet): ReadonlyArray<number> =>
	Arr.map(c.strata, (stratum, i) => stratum.length + (i === 0 ? c.reads.length : 0))

/** Each stratum's units in model order. */
const modelOrder = (c: ModelChangeSet): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.map(unitCounts(c), (n) => Array.from({ length: n }, (_, i) => i))

/** Each stratum's units in a drawn order. */
const drawnOrder =
	(c: ModelChangeSet): Gen<ReadonlyArray<ReadonlyArray<number>>> =>
	(s) =>
		Arr.map(modelOrder(c), (order) =>
			s.draw(shuffled(order, { min: order.length, max: order.length }))
		)

/** What a program reaches: its steps' verdicts, the shapes its ChangeSets take, and every refusal and fault. */
export type AlgebraFeature =
	| StepFeature<Params, Refusal>
	| "an array member"
	| "a query member"
	| "array members merged"
	| "a query member deduplicated"
	| "an empty stratum kept"
	| "three strata"
	| "a delta read-back"
	| "an ordered read-back"
	| "two private parameters of one name"
	| "a private parameter shared by two uses"
	| "tied members, one sharing a private parameter"
	| "a free parameter beside a private one of its name"
	| "a free parameter spelled like a private name"
	| "a union over a higher level"
	| "a union of more strata on one side"
	| "a read-back repeated over one query"
	| "read-backs read out of name order"
	| `refused: ${Rule}`
	| `fault: ${Fault}`

/** The bound uses of a ChangeSet in canonical form: each parameter name with its value, once per member or read-back. */
const boundUses = (c: Canon): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(
		[...Arr.flatMap(c.strata, (stratum) => Arr.flatMap(stratum, (g) => g.queries)), ...c.reads],
		(u: { readonly shape: ReadShape; readonly binding: Binding }) =>
			u.binding.kind === "bound" ? Arr.zip(paramsOf(u.shape), u.binding.values) : []
	)

/** The features a model ChangeSet shows. */
/**
 * Whether a read-back is read after another whose name sorts after its own: the order the read-backs were read,
 * unioned and sequenced in is not their name order, which the outcome's decoder of them follows alone.
 */
const outOfNameOrder = (reads: ReadonlyArray<ModelRead>): boolean =>
	Arr.some(reads, (r, i) => Arr.some(reads, (q, j) => i < j && q.name < r.name))

const shapeFeatures = (c: ModelChangeSet): ReadonlyArray<AlgebraFeature> => {
	const canon = canonOf(c)
	const members = Arr.flatten(c.strata)
	const groups = Arr.flatten(canon.strata)
	const uses = boundUses(canon)
	const names = new Set(Arr.map(uses, ([name]) => name))
	const freeOnes = freeNames(c)
	const twoOfOneName = Arr.some([...names], (name) =>
		Arr.some(uses, ([n, x]) => n === name && Arr.some(uses, ([o, y]) => o === name && x !== y))
	)
	const shared = Arr.some(uses, ([n, x], i) =>
		Arr.some(uses, ([o, y], j) => i !== j && n === o && x === y)
	)
	/** How many uses bind `name` to `value`. */
	const usesOf = (name: string, value: string): number =>
		Arr.reduce(uses, 0, (k, [o, y]) => (o === name && y === value ? k + 1 : k))
	/** Two members of one shape in one group, bound to other values under one name, where another use shares the one's
	 * value and none shares the other's: the case where only the values, never the build order, may decide which of
	 * the two takes the parameter's own name. */
	const tied = Arr.some(groups, (g) =>
		Arr.some(g.queries, (a, i) =>
			Arr.some(g.queries, (b, j) => {
				if (
					i === j ||
					a.shape !== b.shape ||
					a.binding.kind !== "bound" ||
					b.binding.kind !== "bound"
				) {
					return false
				}
				const other = b.binding.values
				return Arr.some(
					Arr.zip(paramsOf(a.shape), a.binding.values),
					([n, x], k) => other[k] !== x && usesOf(n, x) >= 2 && usesOf(n, other[k] ?? x) === 1
				)
			})
		)
	)
	const out: Array<AlgebraFeature> = []
	const when = (holds: boolean, feature: AlgebraFeature) => {
		if (holds) {
			out.push(feature)
		}
	}
	when(
		Arr.some(members, (m) => m.kind === "array"),
		"an array member"
	)
	when(outOfNameOrder(c.reads), "read-backs read out of name order")
	when(
		Arr.some(members, (m) => m.kind === "query"),
		"a query member"
	)
	when(
		Arr.some(c.strata, (stratum) =>
			Arr.some(stratum, (m, i) =>
				Arr.some(
					stratum,
					(n, j) =>
						i < j &&
						m.kind === "array" &&
						n.kind === "array" &&
						m.relation === n.relation &&
						m.op === n.op
				)
			)
		),
		"array members merged"
	)
	when(
		Arr.reduce(groups, 0, (sum, g) => sum + g.queries.length) <
			Arr.reduce(members, 0, (sum, m) => sum + (m.kind === "query" ? 1 : 0)),
		"a query member deduplicated"
	)
	when(
		c.strata.length >= 2 && Arr.some(c.strata, (stratum) => stratum.length === 0),
		"an empty stratum kept"
	)
	when(c.strata.length >= 3, "three strata")
	when(
		Arr.some(
			c.reads,
			(r) => r.shape === "added" || r.shape === "removed" || r.shape === "addedExtra"
		),
		"a delta read-back"
	)
	when(
		Arr.some(c.reads, (r) => r.shape === "ordered"),
		"an ordered read-back"
	)
	when(twoOfOneName, "two private parameters of one name")
	when(shared, "a private parameter shared by two uses")
	when(tied, "tied members, one sharing a private parameter")
	when(
		Arr.some([...freeOnes], (name) => names.has(name)),
		"a free parameter beside a private one of its name"
	)
	when(freeOnes.has("p#1") && names.has("p"), "a free parameter spelled like a private name")
	return out
}

const lookAlikeRows = record()

/**
 * A value that is none of the members, though shaped like a query to a type checker: it even carries the builders'
 * brand, which no barrel exports, and the builder still refuses it, since only the values it made are queries.
 */
const lookAlike: QueryBase = {
	...builtMark,
	rows: lookAlikeRows,
	immediate: lookAlikeRows,
	named: () => lookAlike
}

const foreign = query(schema("Elsewhere", [Task], [])).rule((r: RuleValue) => {
	const { id, account, kind } = v(Task, "task")
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
})

/** An array of no facts. */
const noFacts: ReadonlyArray<unknown> = []

/** The malformed call a fault makes on the ChangeSet `c`. */
const faultCall = (fault: Fault, c: ChangeSetValue): unknown => {
	switch (fault) {
		case "a schema that is none":
			return ChangeSet.empty({})
		case "a second schema":
			return ChangeSet.empty(Work, Work)
		case "an Ordered member":
			return c.insert(Task, memberQuery("tasks", Work).orderBy(["id", "asc"]))
		case "a look-alike member":
			return c.insert(TaskNote, lookAlike)
		case "a closed relation":
			return c.insert(Kind, [{ id: "Automatic" }])
		case "another schema's relation":
			return c.insert(BookEntry, [])
		case "a closed relation of no schema":
			return c.insert(closed.ordered("Other", ["a"]), [])
		case "a query over an unrelated schema":
			return c.put(Task, foreign)
		case "a read-back that is no function":
			return c.read("x", memberQuery("tasks", Work))
		case "a read-back that returns no query":
			return c.read("x", () => 1)
		case "a delta of a closed relation":
			return c.read("x", (delta: DeltaValue) => delta.added(Kind))
		case "a union with no ChangeSet":
			return ChangeSet.union(c, {})
		case "a sequence of three":
			return ChangeSet.sequence(c, c, c)
		case "an insertAll key of a closed relation":
			return c.insertAll({ Kind: [{ id: "Automatic" }] })
		case "an insertAll key of no relation":
			return c.insertAll({ Nowhere: noFacts })
		case "an insertAll record with a symbol key":
			return c.insertAll({ [Symbol.for("Task")]: noFacts })
		case "an insertAll record that is no plain record":
			return c.insertAll(new Proxy({}, { getPrototypeOf: () => Date.prototype }))
		case "an insertAll record whose reading throws":
			return c.insertAll(
				new Proxy(
					{},
					{
						ownKeys: () => {
							throw new Error("a record whose keys throw")
						}
					}
				)
			)
	}
}

const bindArgument = (entries: ReadonlyArray<BindEntry>): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(
		Arr.map(entries, (e) => [e.name, e.value.kind === "value" ? e.value.value : null] as const)
	)

/**
 * The real builder a program runs against, one for each case: each step's call made on the values the program made,
 * every earlier value's Description unchanged after it, and a new value held to the model's ChangeSet (see the header).
 */
export const algebraOf = (c: Case<AlgebraFeature>): Real<Model, Params, Refusal, never, never> => {
	const values: Array<ChangeSetValue> = [ChangeSet.empty(Work)]
	const texts: Array<string> = Arr.map(values, valueText)
	const real = (i: number): ChangeSetValue => defined(values[i], "a value of the program")
	const settle = (
		attempt: Result.Result<unknown, CompileError>,
		after: Model,
		verdict: Verdict<Model, Refusal>,
		rule: Rule | undefined
	): Answer<Refusal> => {
		for (const [i, earlier] of values.entries()) {
			assert.equal(
				valueText(earlier),
				defined(texts[i], "a value's Description as it was made"),
				`value ${i} is as it was made`
			)
		}
		if (rule !== undefined) {
			c.note(`refused: ${rule}`)
		}
		if (!attempt.ok) {
			return attempt.error.reason._tag === malformedTag
				? refusedVerdict(malformedTag)
				: assert.fail(`a builder refusal of another reason: ${attempt.error.reason._tag}`)
		}
		const value = attempt.value
		if (verdict.kind === "refused") {
			return took
		}
		if (!isChangeSetValue(value)) {
			return assert.fail("a step makes a ChangeSet value")
		}
		assert.ok(Object.isFrozen(value), "a ChangeSet value is frozen")
		const expected = defined(after.handles.at(-1), "the model's new ChangeSet")
		assert.deepEqual(readBackValue(value), canonOf(expected), "the model's ChangeSet")
		assert.equal(
			valueText(normalForm(expected, modelOrder(expected))),
			valueText(value),
			"the Description of the normal form in model order"
		)
		const drawn = normalForm(expected, c.draw(drawnOrder(expected)))
		assert.equal(
			valueText(drawn),
			valueText(value),
			"the Description of the normal form in a drawn order"
		)
		assert.deepEqual(
			value.reads.form,
			readsForm(expected),
			"the read-backs' decoder: one record of the model's read-backs, in name order"
		)
		assert.deepEqual(
			drawn.reads.form,
			value.reads.form,
			"the read-backs' decoder of the normal form in a drawn order"
		)
		c.noteAll(shapeFeatures(expected))
		values.push(value)
		texts.push(valueText(value))
		return took
	}
	/** A step admitted that brings read-backs of one name together, each pair one query: one read-back. */
	const repeated = (
		a: ReadonlyArray<ModelRead>,
		b: ReadonlyArray<ModelRead>,
		rule: Rule | undefined
	): void => {
		if (rule === undefined && Arr.some(a, (r) => Arr.some(b, (q) => q.name === r.name))) {
			c.note("a read-back repeated over one query")
		}
	}
	const algebra: Real<Model, Params, Refusal, never, never> = {
		begin: (p, _before, after, verdict) =>
			Effect.sync(() =>
				settle(
					catchCompileError(() => ChangeSet.empty(levelValues[p.level])),
					after,
					verdict,
					undefined
				)
			),
		write: (p, before, after, verdict) =>
			Effect.sync(() => {
				const target = real(p.handle)
				const source = p.source
				switch (source.kind) {
					case "array": {
						const facts = Arr.map(source.facts, factOf)
						const attempt = catchCompileError(() =>
							target[p.op](writableValues[source.relation], facts)
						)
						facts.push(factOf(1000))
						for (const fact of facts) {
							fact.n = 1001
						}
						return settle(attempt, after, verdict, writeRule(before, p))
					}
					case "query":
						return settle(
							catchCompileError(() =>
								target[p.op](
									writableValues[shapeRelation[source.shape]],
									memberQuery(source.shape, levelValues[source.over])
								)
							),
							after,
							verdict,
							writeRule(before, p)
						)
				}
			}),
		read: (p, before, after, verdict) =>
			Effect.sync(() => {
				repeated(handleOf(before, p.handle).reads, [readOfStep(p)], readRule(before, p))
				return settle(
					catchCompileError(() =>
						real(p.handle).read(p.name, readBack(p.shape, levelValues[p.over]))
					),
					after,
					verdict,
					readRule(before, p)
				)
			}),
		bind: (p, before, after, verdict) =>
			Effect.sync(() =>
				settle(
					catchCompileError(() => real(p.handle).bind(bindArgument(p.values))),
					after,
					verdict,
					bindRule(before, p)
				)
			),
		fork: (p, before, after, verdict) =>
			Effect.sync(() => {
				const forked = handleOf(before, p.handle)
				repeated(bound(forked, p.first).reads, bound(forked, p.second).reads, forkRule(forked, p))
				const target = real(p.handle)
				return settle(
					catchCompileError(() =>
						ChangeSet.union(target.bind(bindArgument(p.first)), target.bind(bindArgument(p.second)))
					),
					after,
					verdict,
					forkRule(handleOf(before, p.handle), p)
				)
			}),
		union: (p, before, after, verdict) =>
			Effect.sync(() => {
				const a = handleOf(before, p.a).level
				const b = handleOf(before, p.b).level
				if (a !== b && higherLevel(a, b) !== undefined) {
					c.note("a union over a higher level")
				}
				if (
					handleOf(before, p.a).strata.length !== handleOf(before, p.b).strata.length &&
					combineRule(before, p) === undefined
				) {
					c.note("a union of more strata on one side")
				}
				repeated(handleOf(before, p.a).reads, handleOf(before, p.b).reads, combineRule(before, p))
				return settle(
					catchCompileError(() => ChangeSet.union(real(p.a), real(p.b))),
					after,
					verdict,
					combineRule(before, p)
				)
			}),
		sequence: (p, before, after, verdict) =>
			Effect.sync(() => {
				repeated(handleOf(before, p.a).reads, handleOf(before, p.b).reads, combineRule(before, p))
				return settle(
					catchCompileError(() => ChangeSet.sequence(real(p.a), real(p.b))),
					after,
					verdict,
					combineRule(before, p)
				)
			}),
		fault: (p, _before, after, verdict) =>
			Effect.sync(() => {
				c.note(`fault: ${p.fault}`)
				return settle(
					catchCompileError(() => faultCall(p.fault, real(p.handle))),
					after,
					verdict,
					undefined
				)
			})
	}
	return algebra
}

export const commandNames = [
	"begin",
	"write",
	"read",
	"bind",
	"fork",
	"union",
	"sequence",
	"fault"
] as const

export const rules: ReadonlyArray<Rule> = [
	"unrelated levels",
	"one read-back name over two queries",
	"an extra value",
	"a NULL value",
	"a query over a higher level",
	"a relation of a higher level",
	"a delta outside the level"
]

/** The MalformedDescription `f` throws. */
export const malformed = (f: () => unknown): CompileError =>
	throwsRefused(f, "MalformedDescription")

/** The level check every entry point shares (`isLevelOf`): a ChangeSet admits a query over a
 * schema exactly when the query compiler would compile it against the ChangeSet's schema (querySchema), whatever the
 * pair: the schema itself, one of its levels, a root rebuilt under another name, a root of other content, a schema
 * of no level, a role, and a role built again of one content or under another name. */
interface LevelSubject {
	readonly label: string
	readonly schema: FixtureSchema
	readonly relation: { readonly name: string }
}

/** A role over Work holding two of its relations, built by `name`. */
const writerRole = (name: string): FixtureSchema => role(Work, name, { Task, TaskNote })

const levelSubjects: Arr.NonEmptyReadonlyArray<LevelSubject> = [
	{ label: "Work", schema: Work, relation: Account },
	{ label: "Reports", schema: Reports, relation: Account },
	{ label: "Payroll", schema: Payroll, relation: Employer },
	{ label: "Reporting", schema: Reporting, relation: Employer },
	{ label: "Writer", schema: writerRole("Writer"), relation: Task }
]

/** The roots, each rebuilt from its own relations and statements under another name, with a relation added, or with
 * its last statement removed. */
interface LevelRoot {
	readonly label: string
	readonly renamed: (name: string) => FixtureSchema
	readonly relationAdded: FixtureSchema
	readonly statementRemoved: FixtureSchema
}

const levelRoots: Arr.NonEmptyReadonlyArray<LevelRoot> = [
	{
		label: "Work",
		renamed: (name) => schema(name, Rec.values(Work.relations), Work.statements),
		relationAdded: schema("Work", [...Rec.values(Work.relations), Extra], Work.statements),
		statementRemoved: schema("Work", Rec.values(Work.relations), Work.statements.slice(0, -1))
	},
	{
		label: "Payroll",
		renamed: (name) => schema(name, Rec.values(Payroll.relations), Payroll.statements),
		relationAdded: schema("Payroll", [...Rec.values(Payroll.relations), Extra], Payroll.statements),
		statementRemoved: schema(
			"Payroll",
			Rec.values(Payroll.relations),
			Payroll.statements.slice(0, -1)
		)
	}
]

/** The schema a case names: one of the fixtures, a root under a drawn name, a root with a relation added, a root with
 * its last statement removed, the role built again, or the role under a drawn name. */
type Named =
	| { readonly kind: "fixture"; readonly subject: LevelSubject }
	| {
			readonly kind: "renamed"
			readonly feature: IdentifierFeature
			readonly schema: FixtureSchema
	  }
	| { readonly kind: "relation added"; readonly schema: FixtureSchema }
	| { readonly kind: "statement removed"; readonly schema: FixtureSchema }
	| { readonly kind: "role rebuilt"; readonly schema: FixtureSchema }
	| {
			readonly kind: "role renamed"
			readonly feature: IdentifierFeature
			readonly schema: FixtureSchema
	  }

/** Where a hostile value sat in bind's map, or that the map was live throughout. */
export type BindFeature = "a live map" | `${WildKind} as the map` | `${WildKind} as a fact`

export type LevelPairFeature =
	| "the schema itself"
	| "a level"
	| "no level"
	| `renamed: ${IdentifierFeature}`
	| "a relation added"
	| "a statement removed"
	| "a role rebuilt"
	| `role renamed: ${IdentifierFeature}`

/**
 * Each root with the dictionary's names other than its own, which a rename draws from, every feature alike, and its plain
 * ones alone: no draw renames it to itself.
 */
const renamings = Object.freeze(
	Arr.map(levelRoots, (root) => ({
		root,
		names: dictionaryNameGenOtherThan(new Set([root.label])),
		plain: element(
			nonEmpty(
				Arr.filter(admittedNames, (n) => n.feature === "plain" && n.declared !== root.label),
				`a plain name other than ${root.label}`
			)
		)
	}))
)

type Renaming = (typeof renamings)[number]

/** A root renamed to a name of those `names` gives it. */
const renamedGen =
	(names: (renaming: Renaming) => Gen<Admitted>): Gen<Named> =>
	(source) => {
		const renaming = source.draw(element(renamings))
		const name = source.draw(names(renaming))
		return { kind: "renamed", feature: name.feature, schema: renaming.root.renamed(name.declared) }
	}

const namedGen: Gen<Named> = oneOf([
	map(element(levelSubjects), (subject): Named => ({ kind: "fixture", subject })),
	renamedGen((renaming) => renaming.names),
	map(element(levelRoots), (root): Named => ({
		kind: "relation added",
		schema: root.relationAdded
	})),
	map(element(levelRoots), (root): Named => ({
		kind: "statement removed",
		schema: root.statementRemoved
	})),
	(): Named => ({ kind: "role rebuilt", schema: writerRole("Writer") }),
	map(dictionaryNameGenOtherThan(new Set(["Writer"])), (name): Named => ({
		kind: "role renamed",
		feature: name.feature,
		schema: writerRole(name.declared)
	}))
])

/** A query's subject and the schema of the ChangeSet that reads it. */
const levelPairOf =
	(named: Gen<Named>): Gen<readonly [LevelSubject, Named]> =>
	(source) =>
		[source.draw(element(levelSubjects)), source.draw(named)] as const

/**
 * A subject and the schema a ChangeSet over it is named, aimed at a root renamed to a plain name, which the rename arm
 * draws one case in seven and namedGen one in 42: the floor and steered streams of the level check's bare identity, which
 * its kills run, reached none in 250 cases.
 */
export const levelPairSpace: Aimed<readonly [LevelSubject, Named], LevelPairFeature> = aimed(
	levelPairOf(namedGen),
	[["renamed: plain", levelPairOf(renamedGen((renaming) => renaming.plain))]]
)

/** The arm switch with a relation parameter beside its scalar ones: the notes it is bound to, inserted as they are. */
export const withNotes = (): ChangeSetValue =>
	switchToManual().insert(
		TaskNote,
		query(Work).rule((r: RuleValue) => {
			const { task, note: body } = v(TaskNote, "taskNote")
			return r.match(r.relation("notes", TaskNote), { task, note: body }).find({ task, note: body })
		})
	)

/** A map, or a fact in its array, whose reading runs the caller's code and throws: an enumerable getter that throws,
 * or a proxy whose every trap throws (getPrototypeOf and ownKeys among them). */
export const hostile: Arr.NonEmptyReadonlyArray<WildKind> = ["throwing-getter", "proxy"]

export const note = (n: number) => ({ task: uuidOf(n), note: `n${n}` })

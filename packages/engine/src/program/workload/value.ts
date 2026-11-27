import * as Result from "@bjornpagen/grizzle-text/base/result"
import { admitHostKey } from "#compiler/core/brand.ts"
import { type ClockUnit, isClockUnit } from "#compiler/core/clock.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { deepFreeze, hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import { type ClockBinding, noClock } from "#compiler/ir/clock.ts"
import {
	declaredNameAt,
	type ProgramDesc,
	type QueryDesc,
	type WorkloadDesc
} from "#compiler/ir/desc.ts"
import {
	queryInput,
	levelSchema,
	type Over,
	parseBuiltSchema,
	parseOver,
	parseSchemaInput,
	type SchemaInput
} from "#compiler/program/input.ts"
import { isKeyPosition, type KeyPosition, keyLookup } from "#compiler/query/build/key.ts"
import {
	isOrderedValue,
	isQueryValue,
	type OrderedValue,
	type QueryValue
} from "#compiler/query/build/query.ts"
import { builderLoc, builderRefusal, malformed } from "#compiler/schema/protocol.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { Answered, Clocked, Paged, Workload } from "#compiler/types/db/workload.ts"
import {
	type ChangeSetValue,
	changeSetState,
	isChangeSetValue
} from "#compiler/write/changeset/value.ts"

/**
 * A read's Description as its member serves it, which reads no clock: live (`query`), or answered at its call's instant
 * alone (`answered`), where answered(...) made its member (answeredMember).
 */
type UnclockedReadDesc = Extract<ProgramDesc, { readonly kind: "query" | "answered" }>

/**
 * A query or ordered query's Description as its member serves it (UnclockedReadDesc), or, where its member binds
 * parameters to the database's clock (clocked), the answered read under that binding, never live, since time passing
 * is no change: the one place a read's liveness and its clock are stated.
 */
export type ReadDesc =
	| UnclockedReadDesc
	| {
			readonly kind: "clocked"
			readonly clock: ClockBinding
			readonly program: Extract<ProgramDesc, { readonly kind: "answered" }>
	  }

/**
 * How a read member is called: `live`, its watch woken by each change of its footprint, or `answered`, at its call's
 * instant alone, never live.
 */
export type ReadCalled = "live" | "answered"

/** How a read is called, read off its Description (ReadDesc): answered where its program is, a clocked read's too. */
export const readCalled = (desc: ReadDesc): ReadCalled => {
	const program = desc.kind === "clocked" ? desc.program : desc
	switch (program.kind) {
		case "query":
			return "live"
		case "answered":
			return "answered"
	}
}

/**
 * A read program value of a workload, by kind, as the builders made it, with its Description (ReadDesc): a query, an
 * ordered query read only, or one that pages (paged), whose Description is its ordered query's, which a clock never
 * reads.
 */
type ReadValue =
	| { readonly kind: "query"; readonly value: QueryValue; readonly desc: ReadDesc }
	| { readonly kind: "ordered"; readonly value: OrderedValue; readonly desc: ReadDesc }
	| { readonly kind: "paged"; readonly value: OrderedValue; readonly desc: UnclockedReadDesc }

/** A program value of a workload, by kind, as the builders made it, with its Description: a read or a ChangeSet. */
type ProgramValue =
	| ReadValue
	| {
			readonly kind: "changeSet"
			readonly value: ChangeSetValue
			readonly desc: Extract<ProgramDesc, { readonly kind: "changeSet" }>
			readonly clock: ClockBinding
	  }

/**
 * One program of a workload, by kind, as `grizzle generate` compiles it: a query or ordered query value, or a key,
 * which reads through its lookup query (query/build/key.ts keyQuery) at the key position the workload admitted, built
 * once over the workload's schema, the query every role the workload runs on compiles, each a read, answered where it
 * is answered(...) (answeredMember) or clocked, its isolation the compile's to infer (core/isolation.ts ReadIsolation),
 * and a ChangeSet value, each with the Description the migration generator plans (a key's is its lookup's).
 */
export type WorkloadProgram = { readonly name: string } & (
	| ReadValue
	| {
			readonly kind: "key"
			readonly target: KeyPosition
			readonly query: unknown
			readonly desc: UnclockedReadDesc
	  }
	| Extract<ProgramValue, { readonly kind: "changeSet" }>
)

/** What a workload value carries: its schema parsed, its Description, and its programs in its record's order. */
interface WorkloadState {
	readonly schema: SchemaInput
	readonly desc: WorkloadDesc
	readonly programs: ReadonlyArray<WorkloadProgram>
}

const states = new WeakMap<object, WorkloadState>()

const label = "workload"

const orThrow = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw r.error
	}
	return r.value
}

/**
 * One program value with its Description, and the schema or fragment it was written over, undefined for a query rebuilt
 * from its Description alone.
 */
interface ProgramFound {
	readonly program: ProgramValue
	readonly schema: Over | undefined
}

/**
 * A query or ordered query value, as `program` names it with its query's Description, and the schema it was written
 * over.
 */
const queryFound = (
	program: (query: QueryDesc) => ProgramValue,
	value: QueryValue | OrderedValue
): ProgramFound => {
	const input = orThrow(queryInput(value))
	return {
		program: program(input.desc),
		schema: input.kind === "built" ? input.schema : undefined
	}
}

/** The ordered query each value paged(...) made pages (pagedMember). */
const pagedValues = new WeakMap<object, OrderedValue>()

/**
 * paged(ordered): the workload member that pages `ordered`, an ordered query, as well as reading it: its handle pages
 * (`db.workload.<name>.page`), and the layer compiles its page template once, at startup. A plain ordered member reads
 * only, and no page template is compiled for it. A value that is no ordered query throws CompileError
 * MalformedDescription synchronously, as every builder refuses a value its signature forbids.
 */
export const pagedMember = <O>(ordered: O, ...extra: ReadonlyArray<unknown>): Paged<O> => {
	if (extra.length > 0) {
		throw malformed("paged", "paged(ordered): one argument")
	}
	if (!isOrderedValue(ordered)) {
		throw malformed("paged", "an ordered query, built by orderBy(...)")
	}
	const value: Paged<O> = Object.freeze({ paged: ordered })
	pagedValues.set(value, ordered)
	return value
}

/** The program each value clocked(...) made serves, with the parameters it binds to the clock (clockedMember). */
const clockedValues = new WeakMap<
	object,
	{ readonly program: QueryValue | OrderedValue | ChangeSetValue; readonly clock: ClockBinding }
>()

/**
 * The binding `binding` states, read once at the boundary (core/host.ts hostRead) into a frozen copy: a plain record of
 * at least one declared parameter name, each to a clock unit; or the refusal of any other value.
 */
const clockBinding = (binding: unknown): ClockBinding => {
	const refused = (): CompileError =>
		malformed(
			"clocked",
			'a binding of at least one declared parameter name to a clock unit, "micros" or "millis"'
		)
	const read = hostRead(refused, () => {
		if (!isPlainRecord(binding)) {
			return Result.err(refused())
		}
		const copy: Record<string, ClockUnit> = {}
		for (const name of Object.keys(binding)) {
			const unit: unknown = binding[name]
			if (!isClockUnit(unit) || !declaredNameAt("workload", ["clock", name], name).ok) {
				return Result.err(refused())
			}
			copy[name] = unit
		}
		return Object.keys(copy).length > 0
			? Result.ok(Object.freeze(copy))
			: Result.err(
					builderRefusal(
						"clocked",
						"clocked binds at least one parameter of the program to the database's clock"
					)
				)
	})
	return orThrow(read)
}

/**
 * What clocked(program, binding) takes after its binding, `rest`, as a JavaScript caller passes it (types/db
 * ClockKeysOf): none, or a record of keys by the names of parameters the binding binds, each a value mintOf would take
 * (core/brand.ts admitHostKey), which a parameter of a consumer's contract needs, since the reading is cast to its
 * domain at bind. Whose each key is, and which parameter needs one, the types judge.
 */
const admitClockKeys = (binding: ClockBinding, rest: ReadonlyArray<unknown>): void => {
	const [keys, ...extra] = rest
	if (rest.length === 0) {
		return
	}
	if (
		extra.length > 0 ||
		!isPlainRecord(keys) ||
		Object.keys(keys).some((name) => !Object.hasOwn(binding, name))
	) {
		throw malformed(
			"clocked",
			"clocked(program, binding, keys): keys holds the key of each consumer's contract the binding binds a parameter of, by the parameter's name"
		)
	}
	for (const name of Object.keys(keys)) {
		admitHostKey(keys[name], `clocked key ${name}`)
	}
}

/**
 * clocked(program, binding, keys): the workload member that serves `program`, a query, an ordered query or a ChangeSet,
 * with each parameter `binding` names bound to the database's clock in its unit: the instant the call's transaction
 * began, transaction_timestamp(), one value in every statement of the call, which no call supplies, cast to the
 * parameter's type, a consumer's contract's under its key in `keys` (admitClockKeys). A clocked read is an answered one
 * (answeredMember) with its clock, read at that instant and never live, since time passing is no change: its handle
 * answers `once` alone. Whether each name is a bigint parameter of the program is the compile's to judge (check/clock.ts
 * clockParams); a program that is none of the three, a paged one among them, and a binding of no parameter or of a
 * unit that is no clock unit throw CompileError MalformedDescription synchronously.
 */
export const clockedMember = <X, B>(
	program: X,
	binding: B,
	...rest: ReadonlyArray<unknown>
): Clocked<X, B> => {
	const clock = clockBinding(binding)
	admitClockKeys(clock, rest)
	const served: unknown = program
	if (!isQueryValue(served) && !isOrderedValue(served) && !isChangeSetValue(served)) {
		throw malformed("clocked", "a query, an ordered query or a ChangeSet the builders made")
	}
	const value: Clocked<X, B> = Object.freeze({ clocked: program, clock: binding })
	clockedValues.set(value, { program: served, clock })
	return value
}

/** The read each value answered(...) made answers (answeredMember). */
const answeredValues = new WeakMap<object, unknown>()

/**
 * Whether `read` is a read answered(...) takes: a query, an ordered query, a paged(...) ordered query or a relation's
 * key, each known by what made it (its registration), so no property of the value is read and a caller's value, a
 * refusing proxy among them, runs none of its code.
 */
export const isAnswerableRead = (read: unknown): boolean =>
	(hasProperties(read) && pagedValues.has(read)) ||
	isQueryValue(read) ||
	isOrderedValue(read) ||
	isKeyPosition(read)

/**
 * answered(read): the workload member that answers `read`, a query, an ordered query, a paged(...) ordered query or a
 * relation's key, at its call's instant alone and never live: its handle holds `once`, its explains and no `watch`, and
 * over HTTP its answer is its reset, its upserts, its ready, then its end, since no change wakes it. Its workload plans
 * no footprint for it, so a login whose reads are all answered serves no live read and its layer needs no live source.
 * A clocked read is answered already, with its clock (clockedMember). A value that is no such read, a ChangeSet, a
 * clocked one and an answered member among them, throws CompileError MalformedDescription synchronously.
 */
export const answeredMember = <X>(read: X, ...extra: ReadonlyArray<unknown>): Answered<X> => {
	if (extra.length > 0) {
		throw malformed("answered", "answered(read): one argument")
	}
	if (!isAnswerableRead(read)) {
		throw malformed(
			"answered",
			"answered takes a read: a query, an ordered query, a paged one or a relation's key"
		)
	}
	const value: Answered<X> = Object.freeze({ answered: read })
	answeredValues.set(value, read)
	return value
}

/**
 * One program value, its Description and the schema it was written over, when it is a query, ordered query, paged
 * ordered query, clocked or ChangeSet value; undefined otherwise. A read's Description is `served` of its query's: live,
 * or answered where its member is answered(...); a clocked read's is its answered query under its clock.
 */
const programDescOf = (
	program: unknown,
	served: (query: QueryDesc) => UnclockedReadDesc
): ProgramFound | undefined => {
	const clocked = hasProperties(program) ? clockedValues.get(program) : undefined
	if (clocked !== undefined) {
		return clockedFound(clocked.program, clocked.clock)
	}
	const pagedQuery = hasProperties(program) ? pagedValues.get(program) : undefined
	if (pagedQuery !== undefined) {
		return queryFound(
			(query) => ({ kind: "paged", value: pagedQuery, desc: served(query) }),
			pagedQuery
		)
	}
	if (isQueryValue(program)) {
		return queryFound((query) => ({ kind: "query", value: program, desc: served(query) }), program)
	}
	if (isOrderedValue(program)) {
		return queryFound(
			(query) => ({ kind: "ordered", value: program, desc: served(query) }),
			program
		)
	}
	return changeSetFound(program, noClock)
}

/** A ChangeSet value with its Description and the schema it was built over, its member binding `clock`. */
const changeSetFound = (program: unknown, clock: ClockBinding): ProgramFound | undefined => {
	const change = changeSetState(program)
	if (change === undefined || !isChangeSetValue(program)) {
		return undefined
	}
	const over = orThrow(parseOver(change.over.value))
	return {
		program: {
			kind: "changeSet",
			value: program,
			desc: { kind: "changeSet", changeSet: change.desc },
			clock
		},
		schema: over
	}
}

/**
 * The program a clocked member serves, with its Description and the schema it was written over: a query or ordered
 * query answered at its call's instant alone under its binding, or a ChangeSet with its binding.
 */
const clockedFound = (
	program: QueryValue | OrderedValue | ChangeSetValue,
	clock: ClockBinding
): ProgramFound | undefined => {
	const desc = (query: QueryDesc): ReadDesc => ({
		kind: "clocked",
		clock,
		program: { kind: "answered", query }
	})
	if (isQueryValue(program)) {
		return queryFound((query) => ({ kind: "query", value: program, desc: desc(query) }), program)
	}
	if (isOrderedValue(program)) {
		return queryFound((query) => ({ kind: "ordered", value: program, desc: desc(query) }), program)
	}
	return changeSetFound(program, clock)
}

/**
 * The Description a workload records of a program: a read's as its member serves it (ReadDesc), and a ChangeSet's own,
 * or, where its member binds parameters to the clock, the ChangeSet under that binding (ir/desc.ts ProgramDesc clocked).
 */
const workloadDescOf = (program: WorkloadProgram): ProgramDesc => {
	switch (program.kind) {
		case "changeSet":
			return Object.keys(program.clock).length > 0
				? { kind: "clocked", clock: program.clock, program: program.desc }
				: program.desc
		case "query":
		case "ordered":
		case "paged":
		case "key":
			return program.desc
	}
}

/**
 * One named program of a workload over `schema`, or the refusal of a value that is none: a query, ordered query or
 * ChangeSet over a level of the schema, or a key of a relation of it, whose lookup query is built over the schema; a
 * read answered where answered(...) made it (answeredMember).
 */
const workloadProgram = (
	name: string,
	program: unknown,
	schema: unknown,
	built: SchemaInput
): WorkloadProgram => {
	const answered = hasProperties(program) ? answeredValues.get(program) : undefined
	const read = answered === undefined ? program : answered
	const served = (query: QueryDesc): UnclockedReadDesc =>
		answered === undefined ? { kind: "query", query } : { kind: "answered", query }
	const found = programDescOf(read, served)
	if (found !== undefined) {
		const over = found.schema
		if (over !== undefined && !levelSchema(over, built, builderLoc(label, ["programs", name])).ok) {
			throw malformed(
				label,
				`program ${JSON.stringify(name)}: a program over ${built.desc.name}, a schema it extends, a fragment one of them lists or the empty level, not over ${over.desc.name}`
			)
		}
		return { name, ...found.program }
	}
	const lookup = keyLookup(schema, read)
	if (lookup === undefined) {
		throw malformed(
			label,
			`program ${JSON.stringify(name)}: a query, an ordered query, a paged ordered query, a ChangeSet, a clocked one of them, a relation's key or an answered read the builders made`
		)
	}
	return {
		name,
		kind: "key",
		target: lookup.target,
		query: lookup.query,
		desc: served(orThrow(queryInput(lookup.query)).desc)
	}
}

/** A shallow copy of a record's own enumerable string-keyed members, in their order, as Object.keys lists them. */
const copyRecord = <P extends object>(record: P): P => {
	const copy = { ...record }
	for (const key of Object.getOwnPropertySymbols(copy)) {
		Reflect.deleteProperty(copy, key)
	}
	return copy
}

/**
 * workload(schema, programs): the exported query workload as a value.
 *
 * The workload is an application artifact naming, by name, the queries, ordered queries, ChangeSets and relation keys
 * the application runs, which a login owns (schema/world.ts loginBuilder): `grizzle generate` compiles each once, into
 * the login's served file, and a Db reaches it as `db.workload.<name>`. Its WorkloadDesc holds every program. Like
 * every builder, workload is pure and synchronous and records a
 * Description: the value is frozen, exposes `schema` and `programs` exactly as given, and carries its
 * WorkloadDesc privately, so the migration generator reads the schema and the workload together (program/workload/compile.ts).
 * A malformed argument the TypeScript signature already forbids, from a JavaScript caller, throws CompileError
 * MalformedDescription synchronously: a schema that schema(...), schema.extend(...) or role(...) did not build, a
 * programs argument that is not a plain object, an empty name, or a program that is not a query, ordered query or
 * ChangeSet over a level of the schema (program/schema.ts levelSchema: a full role's base among them), nor a key of a
 * relation of it (query/build/key.ts). Every semantic diagnostic is the workload compiler's.
 */
export const workload = <S, P extends object>(
	schema: S,
	programs: P,
	...extra: ReadonlyArray<unknown>
): Workload<S, P> => {
	if (extra.length > 0) {
		throw malformed(label, "workload(schema, programs): two arguments")
	}
	/** A role, or a schema schema(...) or schema.extend(...) built. */
	const built: SchemaInput = orThrow(
		roleDescOf(schema) === undefined
			? parseBuiltSchema(schema, builderLoc(label, []))
			: parseSchemaInput(schema)
	)
	if (built.kind !== "built" && built.kind !== "role") {
		throw malformed(label, "a schema built by schema(...), schema.extend(...) or role(...)")
	}
	/**
	 * The caller's record is read once at the boundary (core/host.ts hostRead), its prototype and then its members into
	 * the copy the value holds: a record whose reading throws is refused, never escaping as a defect.
	 */
	const read = hostRead(
		() =>
			malformed(label, "programs: a plain object of named programs whose reading throws nothing"),
		() =>
			isPlainRecord(programs)
				? Result.ok(copyRecord(programs))
				: Result.err(malformed(label, "programs: a plain object of named programs"))
	)
	if (!read.ok) {
		throw read.error
	}
	const descs: Record<string, ProgramDesc> = {}
	const named = read.value
	const entries: Array<WorkloadProgram> = []
	for (const name of Object.keys(named)) {
		const program = workloadProgram(name, named[name], schema, built)
		entries.push(program)
		Object.defineProperty(descs, name, {
			value: workloadDescOf(program),
			enumerable: true,
			writable: true,
			configurable: true
		})
	}
	/** A role's workload is its base's: its programs plan the base's indexes. */
	const base = built.kind === "role" ? built.desc.base.name : built.desc.name
	for (const name of Object.keys(descs)) {
		orThrow(declaredNameAt("workload", ["programs", name], name))
	}
	const desc: WorkloadDesc = deepFreeze({ schema: base, programs: descs })
	const value: Workload<S, P> = Object.freeze({ schema, programs: Object.freeze(named) })
	states.set(value, { schema: built, desc, programs: entries })
	return value
}

/** The state of a workload value the builder made, or undefined. */
export const workloadState = (value: unknown): WorkloadState | undefined =>
	hasProperties(value) ? states.get(value) : undefined

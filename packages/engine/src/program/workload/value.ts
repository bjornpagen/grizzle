import type { CompileError } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { type WorkloadDesc, decodeDesc, type ProgramDesc } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/compile.ts"
import {
	levelSchema,
	parseBuiltSchema,
	parseSchemaInput,
	type SchemaInput
} from "#compiler/program/schema.ts"
import { type KeyPosition, keyLookup } from "#compiler/query/build/key.ts"
import {
	isOrderedValue,
	isQueryValue,
	type OrderedValue,
	type QueryValue
} from "#compiler/query/build/query.ts"
import { builderLoc, malformed } from "#compiler/schema/protocol.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { Paged, Workload } from "#compiler/types/db/workload.ts"
import {
	type ChangeSetValue,
	changeSetState,
	isChangeSetValue
} from "#compiler/write/changeset/value.ts"

type QueryProgramDesc = Extract<ProgramDesc, { readonly kind: "query" }>

/**
 * A program value of a workload, by kind, as the builders made it, with its Description: an ordered query read only,
 * or one that pages (paged), whose Description is its ordered query's.
 */
type ProgramValue =
	| { readonly kind: "query"; readonly value: QueryValue; readonly desc: QueryProgramDesc }
	| { readonly kind: "ordered"; readonly value: OrderedValue; readonly desc: QueryProgramDesc }
	| { readonly kind: "paged"; readonly value: OrderedValue; readonly desc: QueryProgramDesc }
	| {
			readonly kind: "changeSet"
			readonly value: ChangeSetValue
			readonly desc: Extract<ProgramDesc, { readonly kind: "changeSet" }>
	  }

/**
 * One program of a workload, by kind, as the layer compiles it at startup: a query or ordered query value, a ChangeSet
 * value, or a key, which reads through its lookup query (query/build/key.ts keyQuery) at the key position the workload
 * admitted. Its Description is what the migration generator plans: a key's is its lookup's, built over the workload's
 * schema.
 */
type WorkloadProgram = { readonly name: string } & (
	| ProgramValue
	| { readonly kind: "key"; readonly target: KeyPosition; readonly desc: QueryProgramDesc }
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
 * One program value with its Description, and the schema it was written over, undefined for a query rebuilt from its
 * Description alone.
 */
interface ProgramFound {
	readonly program: ProgramValue
	readonly schema: SchemaInput | undefined
}

/** A query or ordered query value, as `program` names it with its Description, and the schema it was written over. */
const queryFound = (
	program: (desc: QueryProgramDesc) => ProgramValue,
	value: QueryValue | OrderedValue
): ProgramFound => {
	const input = orThrow(queryInput(value))
	return {
		program: program({ kind: "query", query: input.desc }),
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

/**
 * One program value, its Description and the schema it was written over, when it is a query, ordered query, paged
 * ordered query or ChangeSet value; undefined otherwise.
 */
export const programDescOf = (program: unknown): ProgramFound | undefined => {
	const pagedQuery = hasProperties(program) ? pagedValues.get(program) : undefined
	if (pagedQuery !== undefined) {
		return queryFound((desc) => ({ kind: "paged", value: pagedQuery, desc }), pagedQuery)
	}
	if (isQueryValue(program)) {
		return queryFound((desc) => ({ kind: "query", value: program, desc }), program)
	}
	if (isOrderedValue(program)) {
		return queryFound((desc) => ({ kind: "ordered", value: program, desc }), program)
	}
	const change = changeSetState(program)
	if (change === undefined || !isChangeSetValue(program)) {
		return undefined
	}
	const over = orThrow(parseSchemaInput(change.over.value))
	return {
		program: {
			kind: "changeSet",
			value: program,
			desc: { kind: "changeSet", changeSet: change.desc }
		},
		schema: over
	}
}

/**
 * One named program of a workload over `schema`, or the refusal of a value that is none: a query, ordered query or
 * ChangeSet over a level of the schema, or a key of a relation of it, whose lookup query is built over the schema.
 */
const workloadProgram = (
	name: string,
	program: unknown,
	schema: object,
	built: SchemaInput
): WorkloadProgram => {
	const found = programDescOf(program)
	if (found !== undefined) {
		const over = found.schema
		if (over !== undefined && !levelSchema(over, built, builderLoc(label, ["programs", name])).ok) {
			throw malformed(
				label,
				`program ${JSON.stringify(name)}: a program over ${built.desc.name} or a schema it extends, not over ${over.desc.name}`
			)
		}
		return { name, ...found.program }
	}
	const lookup = keyLookup(schema, program)
	if (lookup === undefined) {
		throw malformed(
			label,
			`program ${JSON.stringify(name)}: a query, an ordered query, a paged ordered query, a ChangeSet or a relation's key the builders made`
		)
	}
	return {
		name,
		kind: "key",
		target: lookup.target,
		desc: { kind: "query", query: orThrow(queryInput(lookup.query)).desc }
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
 * the application runs, which a login owns (schema/world.ts login): DbLayer.make compiles each once, at startup, and a
 * Db reaches it as `db.workload.<name>`. Like every builder, workload is pure and synchronous and records a
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
		const program = workloadProgram(name, named[name], built.value, built)
		entries.push(program)
		Object.defineProperty(descs, name, {
			value: program.desc,
			enumerable: true,
			writable: true,
			configurable: true
		})
	}
	/** A role's workload is its base's: its programs plan the base's indexes. */
	const base = built.kind === "role" ? built.desc.base.name : built.desc.name
	const desc = orThrow(decodeDesc("workload", { schema: base, programs: descs }))
	const value: Workload<S, P> = Object.freeze({ schema, programs: Object.freeze(named) })
	states.set(value, { schema: built, desc, programs: entries })
	return value
}

/** The state of a workload value the builder made, or undefined. */
export const workloadState = (value: unknown): WorkloadState | undefined =>
	hasProperties(value) ? states.get(value) : undefined

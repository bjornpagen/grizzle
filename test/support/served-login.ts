import { array, boolean, element, type Gen, subarray } from "@grizzle/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import {
	type CompiledServed,
	type ServedEntry,
	type ServedRefusal,
	servedEntryOf,
	snapshotCompiled
} from "#adapter/served/compile.ts"
import { builtLogin, type LayerRole, ownLoginOver } from "#adapter/served/login.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { contextFieldAdmits } from "#compiler/ir/desc.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { context, login, role, wholeEntriesOf } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { ownBuilt } from "#compiler/schema/own.ts"
import { fieldDescOf } from "#compiler/schema/protocol.ts"
import { contextDescOf } from "#compiler/schema/world.ts"
import type { ServedFile, ServedRoleForm } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyContext, EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { compiledSnapshot } from "#test/support/compiled-served.ts"
import { type BuiltSchema, buildRoot } from "#test/support/oracle/public/build.ts"
import type {
	ProgramCase,
	ProgramField,
	Root,
	Stored
} from "#test/support/oracle/public/program.ts"

/**
 * A login drawn over a generated public schema (test/support/oracle/public), and its served file compiled as `grizzle
 * generate` compiles it, with no database: what the served file's reach (test/unit/served/reach.test.ts) and its
 * classifier's cut (test/unit/served/refusals.test.ts) are searched over.
 *
 * A login holds one or more roles over the case's schema, each holding every relation whole. A role draws:
 *
 * - the relations it may write, some of the schema's;
 * - perhaps a query entry, `Mine`, over one relation, which it writes too, reading a context of two claims: `key`,
 *   typed as a field of the entry's relation, which selects the relation's facts the entry holds, and `held`, typed as a
 *   field of any relation of the schema, its very descriptor, so its domain is that field's domain;
 * - its workload's ChangeSets, each an insert or a delete into one relation it writes or into `Mine`, the facts the
 *   call's;
 * - and its workload's reads, some of the case's queries.
 *
 * Each draw is a choice among the case's own relations, fields and queries: the counts are the case's. The number of
 * roles is a search budget.
 */

/** Where a role's ChangeSet writes: a relation it holds whole, or its query entry `Mine`. */
type ChangeTarget =
	| { readonly kind: "whole"; readonly relation: Stored }
	| { readonly kind: "entry" }

/** One ChangeSet of a role's workload: an insert or a delete into its target, the facts the call's. */
interface ChangeShape {
	readonly target: ChangeTarget
	readonly op: "insert" | "delete"
}

/** A field of a relation of the schema. */
interface FieldAt {
	readonly relation: Stored
	readonly field: ProgramField
}

/**
 * A role's query entry `Mine` over `target`: the target's facts whose field `key` is the context's `key` claim, the
 * context holding beside it the claim `held`, typed as the field `held` names.
 */
interface EntryShape {
	readonly target: Stored
	readonly key: ProgramField
	readonly held: FieldAt
}

/** One of the case's queries a role's workload reads, by its place among the case's reads. */
interface ReadShape {
	readonly place: number
	readonly query: Root
}

/** A role of a drawn login (see the header). */
export interface RoleShape {
	readonly writes: ReadonlyArray<Stored>
	readonly entry: Option.Option<EntryShape>
	readonly changes: ReadonlyArray<ChangeShape>
	readonly reads: ReadonlyArray<ReadShape>
}

/** The name of the query entry a role writes through, and of the login every case draws. */
const entryName = "Mine"
const loginName = "app"

/** A role's name in the login, by its place. */
export const roleName = (place: number): string => `role${place}`

/** Whether a stored field's descriptor may type a context's claim (ir/desc.ts contextFieldAdmits). */
const claimable = (built: BuiltSchema, at: FieldAt): boolean =>
	contextFieldAdmits(fieldDescOf(descriptorOf(built, at), `${at.relation.name}.${at.field.name}`))

/** The descriptor a relation of the built schema declares a field with. */
const descriptorOf = (built: BuiltSchema, at: FieldAt): unknown =>
	defined(
		built.relation(at.relation).fields[at.field.name],
		`relation ${at.relation.name} declares field ${at.field.name}`
	)

/** Every field of the schema's relations, each with its relation. */
const fieldsOf = (c: ProgramCase): ReadonlyArray<FieldAt> =>
	Arr.flatMap(c.schema.relations, (relation) =>
		Arr.map(relation.fields, (field) => ({ relation, field }))
	)

/** A query entry over a relation of the schema with a field a claim may carry, or none where no relation has one. */
const entryGen =
	(c: ProgramCase, built: BuiltSchema): Gen<Option.Option<EntryShape>> =>
	(source) => {
		const claims = Arr.filter(fieldsOf(c), (at) => claimable(built, at))
		const [first, ...rest] = claims
		if (first === undefined || !source.draw(boolean)) {
			return Option.none()
		}
		const key = source.draw(element([first, ...rest]))
		const held = source.draw(element([first, ...rest]))
		return Option.some({ target: key.relation, key: key.field, held })
	}

const roleGen =
	(c: ProgramCase, built: BuiltSchema): Gen<RoleShape> =>
	(source) => {
		const writes = source.draw(subarray(c.schema.relations))
		const entry = source.draw(entryGen(c, built))
		const targets: ReadonlyArray<ChangeTarget> = [
			...Arr.map(writes, (relation): ChangeTarget => ({ kind: "whole", relation })),
			...(Option.isSome(entry) ? [{ kind: "entry" } as const] : [])
		]
		const changes = Arr.map(source.draw(subarray(targets)), (target): ChangeShape => ({
			target,
			op: source.draw(element(["insert", "delete"] as const))
		}))
		const queries = Arr.flatMap(c.reads, (read, place): ReadonlyArray<ReadShape> =>
			read.kind === "query" ? [{ place, query: read.query }] : []
		)
		return { writes, entry, changes, reads: source.draw(subarray(queries)) }
	}

/** The roles of a login over the case's schema, one or more (see the header). */
export const loginGen =
	(c: ProgramCase, built: BuiltSchema): Gen<Arr.NonEmptyReadonlyArray<RoleShape>> =>
	(source) => [
		source.draw(roleGen(c, built)),
		...source.draw(array(roleGen(c, built), { min: 0, max: 1 }))
	]

/** A value context(...) built, as the library recognizes one. */
const isContext = (value: unknown): value is AnyContext => contextDescOf(value) !== undefined

/** The context a role's query entry reads (EntryShape), built as a JavaScript caller builds one. */
const contextOf = (built: BuiltSchema, entry: EntryShape, place: number): AnyContext => {
	const value: unknown = Reflect.apply(context, undefined, [
		`Claims${place}`,
		{
			key: descriptorOf(built, { relation: entry.target, field: entry.key }),
			held: descriptorOf(built, entry.held)
		}
	])
	if (!isContext(value)) {
		throw new Error(`the context of role ${roleName(place)} is no context`)
	}
	return value
}

/** The query entry `Mine` (EntryShape): the target's facts whose key field is the context's `key` claim. */
const entryOf = (built: BuiltSchema, entry: EntryShape, claims: AnyContext): EntryValue => {
	const target = built.relation(entry.target)
	return queryOver(built.schema).rule((r: RuleValue) => {
		const fact = varsOver(target, "fact")
		const claim = varsOver(claims, "claims")
		return r
			.match(target, fact)
			.match(claims, { key: fact[entry.key.name], held: claim["held"] })
			.find(fact)
	})
}

/** A drawn role's value and its workload's programs, by name. */
const roleOf = (built: BuiltSchema, shape: RoleShape, place: number) => {
	const value: AnySchema = built.schema
	const entries: Record<string, EntryValue> = { ...wholeEntriesOf(built.schema) }
	const writes = Arr.map(shape.writes, (r) => r.name)
	if (Option.isSome(shape.entry)) {
		entries[entryName] = entryOf(
			built,
			shape.entry.value,
			contextOf(built, shape.entry.value, place)
		)
	}
	const written = Option.isSome(shape.entry) ? [...writes, entryName] : writes
	const made =
		written.length === 0
			? role(value, roleName(place), entries)
			: role(value, roleName(place), entries, { write: written })
	const changes = Arr.map(shape.changes, (change, i) => {
		const target =
			change.target.kind === "whole"
				? built.relation(change.target.relation)
				: defined(made.relations[entryName], `role ${roleName(place)}'s entry ${entryName}`)
		const empty = changeSetOver.empty(made)
		return [
			`change${i}`,
			change.op === "insert" ? empty.insert(target, []) : empty.delete(target, [])
		] as const
	})
	const reads = Arr.map(
		shape.reads,
		(read) => [`read${read.place}`, buildRoot(built, built.schema, read.query)] as const
	)
	return { value: made, programs: Rec.fromEntries([...changes, ...reads]) }
}

/** The login of a case's drawn roles: each role's workload holding its programs, a role of none holding no workload. */
export const drawnLogin = (built: BuiltSchema, shapes: Arr.NonEmptyReadonlyArray<RoleShape>) => {
	const roles = mapNonEmpty(shapes, (shape, place) => roleOf(built, shape, place))
	const base: AnySchema = built.schema
	return login(
		base,
		loginName,
		mapNonEmpty(roles, (r) => r.value),
		{
			workload: Arr.flatMap(roles, (r) =>
				Rec.isEmptyRecord(r.programs) ? [] : [workload(r.value, r.programs)]
			)
		}
	)
}

/**
 * A login's compile as `grizzle generate` writes it (adapter/served/compile.ts snapshotCompiled, then servedEntryOf):
 * its roles, each with its artifacts and its compiled workload, the served file and its text, and the file read back
 * from the JSON value its text parses to, as a layer reads it (served/json.ts servedFile).
 */
interface CompiledLogin {
	readonly compiled: CompiledServed
	readonly entry: ServedEntry
	readonly json: unknown
	readonly back: ServedFile
}

/** A login compiled over the snapshot.json generate writes for its base (CompiledLogin), or the compile's refusal. */
export const compiledLogin = (login: unknown): Effect.Effect<CompiledLogin, ServedRefusal> =>
	Effect.gen(function* () {
		const built = defined(builtLogin(login), "a login built by login(...)")
		const base = succeeded(ownBuilt(built.base), "the login's base")
		const owned = succeeded(ownLoginOver(built, base), "the login over its base")
		const compiled = yield* snapshotCompiled({ login: built, owned }, compiledSnapshot(base))
		const entry = yield* servedEntryOf(compiled)
		const json = trustedJson<unknown>(entry.text)
		return { compiled, entry, json, back: servedFile(json) }
	})

/** Each served role of a compiled login beside its compiled role, by the role's name. */
export const rolesOf = (
	compiled: CompiledLogin
): ReadonlyArray<{ readonly served: ServedRoleForm; readonly compiled: LayerRole }> =>
	Arr.map(compiled.back.roles, (served) => ({
		served,
		compiled: defined(
			Arr.findFirst(compiled.compiled.roles, (r) => r.role.name === served.name).pipe(
				Option.getOrUndefined
			),
			`the compiled role ${served.name}`
		)
	}))

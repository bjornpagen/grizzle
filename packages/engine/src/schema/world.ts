import { sameContent } from "#compiler/core/canonical.ts"
import type { LoginRule, RoleRule } from "#compiler/core/causes.ts"
import { CompileError, ruleRefused } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import {
	admitLoginRoles,
	type ContextDesc,
	contextFieldAdmits,
	contextOver,
	decodeRoleOver,
	type FieldDesc,
	heldRelation,
	type LoginDesc,
	type QueryDesc,
	type RelationDesc,
	type RoleDesc,
	type RoleEntryDesc,
	type RoleWriting,
	type SchemaDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import { writableEntry } from "#compiler/schema/entry.ts"
import {
	isLevelOf,
	levelRelations,
	type SchemaContent,
	sameLevel
} from "#compiler/schema/levels.ts"
import {
	builderLoc,
	describedField,
	frozenCopy,
	frozenTuple,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownedKind,
	ownValue,
	queryDescOf,
	querySchemaOf,
	requireName
} from "#compiler/schema/protocol.ts"
import { record, roleRelations, wholeEntries } from "#compiler/schema/record.ts"
import { derivedDraftOf, relationDescOf, writingOf } from "#compiler/schema/relation.ts"
import { expansionDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import { loginStem, roleStem } from "#compiler/schema/stem.ts"
import { approximates, attachesHeading, queryUses } from "#compiler/schema/walk.ts"
import type { InsertableNameOf } from "#compiler/types/changeset/changeset.ts"
import type { AnyWorkload } from "#compiler/types/db/workload.ts"
import type { AnyDerived, DefinitionQuery } from "#compiler/types/derived/derived.ts"
import type { AnyRelation, AnyRoster } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type {
	AnyLogin,
	AnyLoginRole,
	AnyRole,
	Context,
	ContextField,
	ContextFieldBases,
	ContextOptions,
	EntryValue,
	KeptStatements,
	Login,
	LoginOptions,
	Role,
	RoleOptionRecord,
	RoleOptions,
	RoleRelations,
	WholeEntriesOf,
	World,
	WritableNameOf
} from "#compiler/types/schema/world.ts"

export const contextDescOf = (value: unknown): ContextDesc | undefined =>
	ownedDesc(value, "context")
export const roleDescOf = (value: unknown): RoleDesc | undefined => ownedDesc(value, "role")

/**
 * A role as a level (write/changeset/levels.ts), read once, when role(...) builds the role: its Description; its base's
 * content (levels.ts SchemaContent), which beside the Description is its identity (levels.ts sameRoleLevel); the
 * highest level of its base it holds whole, every relation of that level and below it under its own name but the closed
 * and live derived relations, which no role holds and every role reads (desc.ts heldRelation); every relation of every
 * level of its base by name (levelRelations); and its entries by name.
 */
export interface RoleLevel {
	readonly desc: RoleDesc
	readonly base: SchemaContent
	/**
	 * The highest level of its base the role holds whole, every relation of that level and of every level below it under
	 * its own name but the closed and live derived relations: programs over that level and every level below it run on
	 * the role. Its base itself for a full role; none for a role that holds not every relation of its base's root whole.
	 */
	readonly whole: SchemaContent | undefined
	readonly relations: ReadonlyMap<string, RelationDesc>
	readonly entries: ReadonlyMap<string, RoleEntryDesc>
}

export const loginDescOf = (value: unknown): LoginDesc | undefined => ownedDesc(value, "login")

/**
 * The highest level of `content`, a base's levels, every relation of which and of every level below it a role holding
 * `whole` holds whole under its own name, but the relations no role holds (desc.ts heldRelation); none when the root
 * is not held so. `relations` is every relation of every level of the base, by name.
 */
const wholeLevel = (
	content: SchemaContent,
	relations: ReadonlyMap<string, RelationDesc>,
	whole: ReadonlySet<string>
): SchemaContent | undefined => {
	const held = (level: SchemaContent | undefined): boolean => {
		for (let at = level; at !== undefined; at = at.below) {
			for (const name of at.relations.keys()) {
				const r = relations.get(name)
				if (r !== undefined && heldRelation(r) && !whole.has(name)) {
					return false
				}
			}
		}
		return true
	}
	for (let at: SchemaContent | undefined = content; at !== undefined; at = at.below) {
		if (held(at)) {
			return at
		}
	}
	return undefined
}

/** What a world relation value records: its name and definition, as its role's query entry. */
export interface WorldDraft {
	readonly name: string
	readonly query: QueryDesc
	readonly loc: SourceLoc
}
export const worldDraftOf = (value: unknown): WorldDraft | undefined => ownedDesc(value, "world")

/** The admission core of context(...): a JavaScript caller's arguments checked and described. */
export const admitContext = (
	name: unknown,
	fields: unknown,
	options: unknown,
	extra: ReadonlyArray<unknown>
): ContextDesc => {
	const label = `context ${typeof name === "string" ? name : "?"}`
	const contextName = requireName(name, label, "a context name")
	if (extra.length > 0) {
		throw malformed(label, "context(name, fields, options?): at most three arguments")
	}
	if (!isPlainRecord(fields)) {
		throw malformed(label, "a record of field descriptors")
	}
	const descs: Record<string, FieldDesc> = {}
	for (const [field, descriptor] of Object.entries(fields)) {
		const desc = describedField(descriptor, `${label} field ${field}`).desc
		if (!contextFieldAdmits(desc) || writingOf(descriptor).kind !== "caller") {
			throw CompileError.make({
				_tag: "ContextRefused",
				at: builderLoc(`${label} field ${field}`, []),
				context: contextName,
				rule: { kind: "claimType", field }
			})
		}
		descs[field] = desc
	}
	if (options === undefined) {
		return orThrow(contextOver(contextName, descs, undefined))
	}
	if (!isPlainRecord(options) || Object.keys(options).some((k) => k !== "claim")) {
		throw malformed(label, "options { claim }: the nested claim object the fields are read from")
	}
	const claim = requireName(options["claim"], label, "a claim object name")
	return orThrow(contextOver(contextName, descs, claim))
}

/**
 * context(name, fields, options?). The value holds a frozen copy of the fields, its heading, and `fact`, the decoder of
 * its one fact. A JavaScript caller's arguments past the options are refused.
 */
export const context = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields & ContextFieldBases<Fields>,
	...rest: ContextOptions | readonly [unknown, ...ReadonlyArray<unknown>]
): Context<Name, Fields> => {
	const [options, ...extra] = rest
	const desc = admitContext(name, fields, options, extra)
	const copied = frozenCopy(fields)
	return ownValue(
		{
			...builtMark,
			kind: "context",
			name,
			fields: copied,
			claim: desc.claim,
			heading: copied,
			fact: record<[Fields]>(copied)
		},
		"context",
		desc,
		undefined
	)
}

/**
 * What admission read of a role's relation record: each entry's Description, and for a query entry its definition
 * value.
 */
interface AdmittedRole {
	readonly desc: RoleDesc
	/** The names of the whole entries, which the kept statements name only. */
	readonly whole: ReadonlySet<string>
	readonly level: RoleLevel
}

/** The names a statement's Descriptions name. */
const statementNames = (desc: StatementDesc): ReadonlyArray<string> => {
	switch (desc.kind) {
		case "key":
			return [desc.side.relation]
		case "mutable":
		case "race":
		case "check":
			return [desc.relation]
		case "contained":
			return [desc.left.relation, desc.right.relation]
		case "family":
		case "tree":
			return [desc.member.relation, desc.slots.owner]
		case "fold":
			return [desc.step.relation, desc.end.relation]
		case "alternatives":
			return [desc.parent.relation, desc.roster, ...desc.arms.map((a) => a.arm.relation)]
		case "retirable":
			return [desc.header.relation, ...desc.bodies.map((b) => b.relation)]
	}
}

/** The relation names a statement value names: a mirrors' whole expansion, or its own. */
const namesOf = (value: unknown): ReadonlyArray<string> => {
	const expansion = expansionDescOf(value)
	if (expansion !== undefined) {
		return expansion.statements.flatMap(statementNames)
	}
	const desc = statementDescOf(value)
	return desc === undefined ? [] : statementNames(desc)
}

const nameList = (value: unknown, label: string, what: string): ReadonlyArray<string> => {
	if (value === undefined) {
		return []
	}
	if (!isList(value)) {
		throw malformed(label, `${what}: a list of role relation names`)
	}
	return value.map((item) => requireName(item, label, what))
}

/** An insert list as a role holds it: at least one role relation, an empty one stating no write at all. */
const insertList = (names: ReadonlyArray<string>, label: string): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = names
	if (first === undefined) {
		throw malformed(`${label} insert`, "an insert list of at least one role relation")
	}
	return [first, ...rest]
}

/**
 * What a whole entry, or the base's relation it names, is: its Description, which it carries from its build, a derived
 * relation's its definition's, whose name and content identify it.
 */
const wholeOf = (value: unknown, label: string): { readonly name: string } => {
	const derived = ownedEntry(value, "derived")
	return derived === undefined ? relationDescOf(value, label) : derived.desc
}

/**
 * The admission core of role(...): a JavaScript caller's arguments checked and described, the one path a role's
 * Description is built by.
 */
export const admitRole = (
	base: unknown,
	name: unknown,
	relations: unknown,
	options: unknown,
	extra: ReadonlyArray<unknown>
): AdmittedRole => {
	const baseEntry = ownedEntry(base, "schema")
	if (baseEntry === undefined) {
		throw malformed("role", "a base schema built by schema(...) or schema.extend(...)")
	}
	const baseDesc = baseEntry.desc
	const label = `role ${baseDesc.name}.${typeof name === "string" ? name : "?"}`
	const roleName = requireName(name, label, "a role name")
	if (extra.length > 0) {
		throw malformed(label, "role(base, name, relations, options?): at most four arguments")
	}
	if (!isPlainRecord(relations)) {
		throw malformed(label, "a record of relations of the base and queries over it")
	}
	/** The role's refusal at `at` for breaking `rule`. */
	const roleRefused = (at: string, rule: RoleRule): CompileError =>
		CompileError.make({ _tag: "RoleRefused", at: builderLoc(at, []), role: roleName, rule })
	const below = levelRelations(baseDesc)
	const entries: Array<RoleEntryDesc> = []
	const kinds = new Map<string, RelationDesc["kind"] | "world">()
	for (const [key, value] of Object.entries(relations)) {
		const at = `${label} relation ${key}`
		const loc = builderLoc(at, [baseDesc.name, roleName, key])
		const draft = derivedDraftOf(value)
		const kind = ownedKind(value)
		if (draft?.storage === "live") {
			throw ruleRefused(
				builderLoc(at, []),
				"a whole entry is a relation PostgreSQL stores: a role reads a live derived relation through the relations its definition reads"
			)
		}
		if (draft !== undefined || kind === "relation" || kind === "closed") {
			const own = wholeOf(value, at)
			const declared = below.get(key)
			const held = Object.hasOwn(baseEntry.value.relations, key)
				? baseEntry.value.relations[key]
				: undefined
			if (
				own.name !== key ||
				declared === undefined ||
				held === undefined ||
				!sameContent(wholeOf(held, at), own)
			) {
				throw ruleRefused(
					builderLoc(at, []),
					"a whole entry is a relation of the base under its own name"
				)
			}
			entries.push({ kind: "whole", name: key, loc })
			kinds.set(key, declared.kind)
			continue
		}
		const query = queryDescOf(value, at)
		/**
		 * A query built over a schema or a fragment is over the base or one of its levels: a query over another schema or
		 * fragment, or over a role, would be read over the base's relations of the same names, which are not what it was
		 * built over.
		 */
		const carried = querySchemaOf(value)
		if (carried !== undefined) {
			const content =
				ownedEntry(carried, "schema")?.content ?? ownedEntry(carried, "fragment")?.content.level
			if (content === undefined || !isLevelOf(content, baseEntry.content)) {
				throw ruleRefused(builderLoc(at, []), "a query entry is a query over the role's base")
			}
		}
		if (query.stage.kind === "order") {
			throw roleRefused(at, { kind: "entryOrdered", entry: key })
		}
		const uses = queryUses(query)
		if (uses.inputs.size > 0) {
			throw roleRefused(at, {
				kind: "entryParameters",
				entry: key,
				parameters: [...uses.inputs].toSorted(compareStrings)
			})
		}
		for (const read of uses.relations) {
			if (!below.has(read)) {
				throw roleRefused(at, { kind: "entryOutsideBase", entry: key, relation: read })
			}
		}
		if (attachesHeading(query)) {
			throw roleRefused(at, { kind: "entryAttaches", entry: key })
		}
		if (approximates(query)) {
			throw roleRefused(at, { kind: "entryApproximate", entry: key })
		}
		entries.push({ kind: "world", name: key, query, loc })
		kinds.set(key, "world")
	}
	if (!isPlainRecord(options) && options !== undefined) {
		throw malformed(label, "options { write?, insert?, refresh? }: lists of role relation names")
	}
	const opts = options ?? {}
	for (const k of Object.keys(opts)) {
		if (k !== "write" && k !== "insert" && k !== "refresh") {
			throw malformed(label, `options without ${k}`)
		}
	}
	if (opts["write"] !== undefined && opts["insert"] !== undefined) {
		throw roleRefused(label, { kind: "writeAndInsert" })
	}
	const listed: "write" | "insert" = opts["insert"] === undefined ? "write" : "insert"
	const write = nameList(
		opts[listed],
		`${label} ${listed}`,
		listed === "write" ? "a write list" : "an insert list"
	)
	const refresh = nameList(opts["refresh"], `${label} refresh`, "a refresh list")
	const targets = new Map<string, string>()
	const target = (relation: string, entry: string): void => {
		const prior = targets.get(relation)
		if (prior !== undefined) {
			throw roleRefused(`${label} ${listed}`, {
				kind: "writeTwice",
				relation,
				entries: [prior, entry]
			})
		}
		targets.set(relation, entry)
	}
	for (const w of write) {
		const kind = kinds.get(w)
		if (kind === undefined) {
			throw roleRefused(`${label} ${listed}`, { kind: "writeOutside", name: w })
		}
		if (kind === "relation") {
			target(w, w)
			continue
		}
		if (kind !== "world") {
			throw roleRefused(`${label} ${listed}`, {
				kind: "writeKind",
				name: w,
				entryKind: kind === "closedRelation" ? "closed" : kind
			})
		}
		const entry = entries.find((e) => e.name === w)
		if (entry?.kind !== "world") {
			throw malformed(`${label} ${listed}`, `the query entry ${w}`)
		}
		const analyzed = writableEntry(baseDesc, entry)
		if (!analyzed.ok) {
			throw roleRefused(`${label} ${listed} ${w}`, {
				kind: "writeUnwritable",
				entry: w,
				why: analyzed.error.reason
			})
		}
		target(analyzed.value.target, w)
	}
	for (const f of refresh) {
		const kind = kinds.get(f)
		if (kind !== "derived") {
			throw roleRefused(
				`${label} refresh`,
				kind === undefined
					? { kind: "refreshOutside", name: f }
					: {
							kind: "refreshKind",
							name: f,
							entryKind: kind === "world" ? "query" : kind === "closedRelation" ? "closed" : kind
						}
			)
		}
	}
	const writing: RoleWriting = listed === "write" ? { write } : { insert: insertList(write, label) }
	const desc = orThrow(
		decodeRoleOver(baseDesc, {
			name: roleName,
			relations: entries,
			...writing,
			refresh,
			loc: builderLoc(label, [baseDesc.name, roleName])
		})
	)
	const whole = new Set(entries.flatMap((e) => (e.kind === "whole" ? [e.name] : [])))
	const level: RoleLevel = Object.freeze({
		desc,
		base: baseEntry.content,
		whole: wholeLevel(baseEntry.content, below, whole),
		relations: below,
		entries: new Map(desc.relations.map((e) => [e.name, e]))
	})
	return { desc, whole, level }
}

/**
 * The world relation of a query entry: its definition under the entry's name, its heading the definition's, which v
 * mints variables over, and its `fact` the decoder of that heading.
 */
const world = <const K extends string, Q extends DefinitionQuery>(
	key: K,
	definition: Q,
	draft: WorldDraft
): World<K, Q> => {
	const heading: Q["heading"] = definition.heading
	return ownValue(
		{ ...builtMark, kind: "world", name: key, definition, heading, fact: record(heading) },
		"world",
		draft,
		undefined
	)
}

/** Whether an entry value is a relation of the base, whole: a value the relation builders made. */
const isWhole = (value: EntryValue): value is AnyRelation | AnyRoster | AnyDerived => {
	const kind = ownedKind(value)
	return kind === "relation" || kind === "closed" || kind === "derived"
}

const noNames: readonly [] = Object.freeze([] as const)

/**
 * context, role and login: the world builders.
 *
 * - `context(name, fields, options?)`: the session's relation parameters, a source of at most one fact that a rule of
 *   a query over any schema matches, though a program on a Db of a role matches only the contexts the role's relations
 *   read, whose facts the Db's claims hold. Its fields are claims of scalar types (ir/desc.ts contextFieldAdmits);
 *   `claim` names the nested claim object they are read from.
 * - `role(base, name, relations, options?)`: a schema whose relations are defined over `base`. A whole entry is a
 *   relation of the base, itself, under its own name; a query entry is a query over the base, admitted as a definition:
 *   a Query built over the base or one of its levels, reading no parameter, attaching nothing, approximating nothing,
 *   and naming only the base's relations. The
 *   value holds each query entry as its world relation (World), which v mints variables over and a rule matches by its
 *   name. `write` names role relations: a whole ordinary relation, or a query entry the writable-entry analysis
 *   (entry.ts) admits, at most one per base relation. `insert`, in place of `write`, names them as `write` does, and
 *   the role holds INSERT and SELECT on what they write, no DELETE or UPDATE, so a program of the role that deletes
 *   or updates there is refused (RoleAccess insert); a role stating both is refused (writeAndInsert). `refresh` names
 *   derived whole entries. The role keeps the
 *   base's statements whose every relation is a whole entry.
 * - `login(base, name, roles, { workload? })`: one credential and one pool for roles over `base`, and the workloads it
 *   owns. Every role is in exactly one login, which the builder records (loginOfRole); role and login names are distinct
 *   within the login. Each role is reached through the login by its name, `Web.roles.member`, which Db.open takes.
 *
 * Each builder is the one implementation of its value: its admission core first, then the value, owned with its
 * Description (protocol.ts ownValue). Semantic checks that need the base's checked schema (a query entry's one heading,
 * its types, its operations all total) are the checker's (check/index.ts checkDefinition), which every
 * compilation of the role runs.
 *
 * role(base, name, relations, options?). The value holds the base, the role relations (each query entry as its world
 * relation), the base's statements whose every relation is a whole entry, and frozen copies of the write (or insert)
 * and refresh lists, the insert list as `write`.
 */
export const role = <
	Base extends AnySchema,
	const Name extends string,
	const Rs extends Readonly<Record<string, EntryValue>>,
	const W extends ReadonlyArray<string> = readonly [],
	const F extends ReadonlyArray<string> = readonly []
>(
	base: Base,
	name: Name,
	relations: Rs,
	...rest: RoleOptions<W, F> | readonly [RoleOptionRecord<W, F>, unknown, ...ReadonlyArray<unknown>]
): Role<Base, Name, RoleRelations<Rs>, W[number], F[number], never> => {
	const [options, ...extra] = rest
	const admitted = admitRole(base, name, relations, options, extra)
	const drafts = new Map(
		admitted.desc.relations.flatMap((e) =>
			e.kind === "world"
				? [[e.name, Object.freeze({ name: e.name, query: e.query, loc: e.loc })] as const]
				: []
		)
	)
	const relationsValue = roleRelations(relations, (key, value) => {
		if (isWhole(value)) {
			return value
		}
		const draft = drafts.get(key)
		if (draft === undefined) {
			throw malformed(`role ${name}`, `the query entry ${key}`)
		}
		return world(key, value, draft)
	})
	const kept = (
		s: Base["statements"][number] | Base["listed"][number]
	): s is KeptStatements<Base, RoleRelations<Rs>> => namesOf(s).every((n) => admitted.whole.has(n))
	const value = ownValue(
		{
			...builtMark,
			kind: "role",
			name,
			stem: roleStem(admitted.desc),
			base,
			relations: relationsValue,
			statements: Object.freeze([...base.statements, ...base.listed].filter(kept)),
			write:
				options?.insert !== undefined
					? frozenTuple(options.insert)
					: options?.write === undefined
						? noNames
						: frozenTuple(options.write),
			refresh: options?.refresh === undefined ? noNames : frozenTuple(options.refresh)
		},
		"role",
		admitted.desc,
		admitted.level
	)
	return value
}

/**
 * A schema's Description, as a caller hands the schema in: a value that is no schema is refused, as role refuses it.
 */
const schemaDesc = (base: AnySchema, label: string): SchemaDesc => {
	const entry = ownedEntry(base, "schema")
	if (entry === undefined) {
		throw malformed(label, "a base schema built by schema(...) or schema.extend(...)")
	}
	return entry.desc
}

/** A schema's record of relations, as a caller hands the schema in, refused as schemaDesc refuses it. */
const schemaRelations = <Base extends AnySchema>(base: Base, label: string): Base["relations"] => {
	schemaDesc(base, label)
	return base.relations
}

/** The names of the ordinary relations of a schema's record, in its order (writableNamesOf). */
const ordinaryNames = <Base extends AnySchema>(
	relations: Base["relations"]
): ReadonlyArray<WritableNameOf<Base>> => {
	const ordinary = (
		entry: [string, AnySchema["relations"][string]]
	): entry is [WritableNameOf<Base>, AnyRelation] => entry[1].kind === "relation"
	return Object.entries(relations)
		.filter(ordinary)
		.map(([name]) => name)
}

/**
 * wholeEntriesOf(base): the entries of a full role over `base`, every relation of every level of it under its own name,
 * whole, but the closed relations, which are no entry (every role reads their rows). `role(base, name,
 * wholeEntriesOf(base))` holds every relation of its base whole, so the base is among its levels and every program
 * over the base runs on it; spread beside query entries, they make a full role with entries of its own.
 */
export const wholeEntriesOf = <Base extends AnySchema>(base: Base): WholeEntriesOf<Base> =>
	wholeEntries(schemaRelations(base, "wholeEntriesOf"))

/**
 * writableNamesOf(base): the names of the base's ordinary relations, every level's, in its record's order, which are
 * the whole entries a role writes: `{ write: writableNamesOf(base) }` writes every relation of a full role that a role
 * writes whole. A roster, a closed relation and a derived relation are never among them.
 */
export const writableNamesOf = <Base extends AnySchema>(
	base: Base
): ReadonlyArray<WritableNameOf<Base>> =>
	Object.freeze(ordinaryNames<Base>(schemaRelations(base, "writableNamesOf")))

/**
 * The member relations of a schema's ordered families, every level's: each is written nested in order under its owner,
 * never inserted alone (write/frontend/compile.ts sequenceOf). A counted family's member and a tree's relation are
 * inserted as rows of their own.
 */
const orderedMembersOf = (schema: SchemaDesc): ReadonlySet<string> => {
	const members = new Set<string>()
	for (let level: SchemaDesc | undefined = schema; level !== undefined; level = level.extends) {
		for (const statement of level.statements) {
			if (statement.kind === "family" && statement.order === "ordered") {
				members.add(statement.member.relation)
			}
		}
	}
	return members
}

/**
 * insertableNamesOf(base): the names of the relations a ChangeSet over the base inserts at its top level, in its
 * record's order: every one writableNamesOf names but an ordered family's member, which is written nested in order
 * under its owner. `ChangeSet.empty(base).insertAll(rows)` takes every one of them under its own name, its rows typed
 * by InsertAllRowsOf.
 */
export const insertableNamesOf = <Base extends AnySchema>(
	base: Base
): ReadonlyArray<InsertableNameOf<Base>> => {
	const nested = orderedMembersOf(schemaDesc(base, "insertableNamesOf"))
	const topLevel = (name: WritableNameOf<Base>): name is InsertableNameOf<Base> => !nested.has(name)
	return Object.freeze(ordinaryNames<Base>(base.relations).filter(topLevel))
}

/**
 * The login each role is in: the one login(...) that took it. A WeakMap holds nothing alive and is never enumerated.
 */
const logins = new WeakMap<object, AnyLogin>()

/** The login a role value is in, undefined for a value no login took. */
const loginOfRole = (value: unknown): AnyLogin | undefined =>
	hasProperties(value) ? logins.get(value) : undefined

/**
 * The role handles login(...) made, by identity: `Web.roles.member` is recognised without reading a property of the
 * value, so a caller's arbitrary object, a proxy among them, is told apart from a handle without running its code.
 */
const loginRoles = new WeakMap<object, AnyLoginRole>()

/** The login role a value is, when login(...) made it; undefined for any other value, which is never inspected. */
export const loginRoleOf = (value: unknown): AnyLoginRole | undefined =>
	typeof value === "object" && value !== null ? loginRoles.get(value) : undefined

/** The admission core of login(...): a JavaScript caller's base, name and roles checked and described. */
const admitLogin = (base: unknown, name: unknown, roles: unknown): LoginDesc => {
	const baseEntry = ownedEntry(base, "schema")
	if (baseEntry === undefined) {
		throw malformed("login", "a base schema built by schema(...) or schema.extend(...)")
	}
	const baseDesc = baseEntry.desc
	const label = `login ${baseDesc.name}.${typeof name === "string" ? name : "?"}`
	const loginName = requireName(name, label, "a login name")
	if (!isList(roles) || !isNonEmpty(roles)) {
		throw malformed(label, "a nonempty list of roles built by role(...)")
	}
	const descs = mapNonEmpty(roles, (r, i) => {
		const entry = ownedEntry(r, "role")
		if (entry === undefined) {
			throw malformed(`${label} role ${i}`, "a role built by role(...)")
		}
		const desc = entry.desc
		const loginRefused = (rule: LoginRule): CompileError =>
			CompileError.make({
				_tag: "LoginRefused",
				at: builderLoc(`${label} role ${desc.name}`, []),
				login: loginName,
				rule
			})
		if (desc.base.name !== baseDesc.name || !sameLevel(entry.content.base, baseEntry.content)) {
			throw loginRefused({ kind: "roleBase", role: desc.name, base: baseDesc.name })
		}
		if (desc.name === loginName) {
			throw loginRefused({ kind: "roleName", role: desc.name })
		}
		const prior = loginOfRole(r)
		if (prior !== undefined) {
			throw loginRefused({ kind: "roleTwice", role: desc.name, login: prior.name })
		}
		return desc
	})
	return orThrow(
		admitLoginRoles(baseDesc, {
			name: loginName,
			roles: descs,
			loc: builderLoc(label, [baseDesc.name, loginName])
		})
	)
}

/** The workloads of a login built without options. */
const noWorkloads: ReadonlyArray<AnyWorkload> = Object.freeze([])

/** Whether two lists hold the same items in the same order. */
const sameItems = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
	a.length === b.length && a.every((item, i) => item === b[i])

/**
 * Whether `value` is the login of `roles` and `workload` the builder below made: a login whose `roles` holds, under each
 * role's name, that role reached through the login, and nothing else, and whose `workload` holds the options'. Its
 * phantoms have no runtime value, so this is the whole of what its type states.
 */
const isLoginOf = <
	Base,
	Name extends string,
	Roles extends ReadonlyArray<AnyRole>,
	Ws extends ReadonlyArray<AnyWorkload>
>(
	value: AnyLogin,
	roles: Roles,
	options: LoginOptions<Ws>
): value is AnyLogin & Login<Base, Name, Roles, Ws> =>
	sameItems(value.workload, options[0]?.workload ?? noWorkloads) &&
	Object.keys(value.roles).length === roles.length &&
	roles.every((r) => {
		const reached = Object.hasOwn(value.roles, r.name) ? value.roles[r.name] : undefined
		return reached?.role === r && reached.login === value
	})

/**
 * login(base, name, roles, options): the core of the public login (program/workload/login.ts), which admits the
 * options' workloads first. The value holds the base, each role by its name reached through the login
 * (`Web.roles.member`, what Db.open takes), and the workloads; each role is recorded as this login's.
 */
export const login = <
	Base extends AnySchema,
	const Name extends string,
	const Roles extends readonly [AnyRole, ...ReadonlyArray<AnyRole>],
	const Ws extends ReadonlyArray<AnyWorkload>
>(
	base: Base,
	name: Name,
	roles: Roles,
	options: LoginOptions<Ws>
): Login<Base, Name, readonly [...Roles], Ws> => {
	const desc = admitLogin(base, name, roles)
	const [given] = options
	const workload: ReadonlyArray<AnyWorkload> =
		given === undefined ? noWorkloads : frozenTuple(given.workload)
	/** Role names are identifiers whose first character is no underscore, so none is an accessor of the prototype. */
	const reached: Record<string, AnyLoginRole> = {}
	const value = ownValue(
		{ ...builtMark, kind: "login", name, stem: loginStem(desc), base, roles: reached, workload },
		"login",
		desc,
		undefined
	)
	for (const r of roles) {
		const loginRole: AnyLoginRole = Object.freeze({
			...builtMark,
			kind: "loginRole",
			role: r,
			login: value
		})
		reached[r.name] = loginRole
		loginRoles.set(loginRole, loginRole)
		logins.set(r, value)
	}
	Object.freeze(reached)
	const ordered: readonly [...Roles] = roles
	if (!isLoginOf<Base, Name, readonly [...Roles], Ws>(value, ordered, options)) {
		throw defect(`login ${desc.name}: each of its roles reached through it`)
	}
	return value
}

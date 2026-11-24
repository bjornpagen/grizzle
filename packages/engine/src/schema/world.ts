import { sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { sameContent } from "#compiler/core/canonical.ts"
import type { LoginRule, RoleRule, ScopeRule } from "#compiler/core/causes.ts"
import { CompileError, ruleRefused } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import { recordStem } from "#compiler/core/stems.ts"
import {
	admitLoginRoles,
	type ContextDesc,
	contextFieldAdmits,
	contextOver,
	type ContextFactSourceKind,
	decodeRoleOver,
	type FieldDesc,
	heldRelation,
	type LoginDesc,
	levelChain,
	type QueryDesc,
	type RelationDesc,
	type RoleDesc,
	type RoleEntryDesc,
	type RoleWriting,
	type SchemaDesc,
	type StatementDesc,
	type WriteMode,
	writtenNames
} from "#compiler/ir/desc.ts"
import { writableEntry } from "#compiler/schema/entry.ts"
import {
	isLevelOf,
	levelRelations,
	type SchemaContent,
	sameLevel
} from "#compiler/schema/levels.ts"
import { entryContextBreak } from "#compiler/schema/own.ts"
import {
	builderLoc,
	frozenCopy,
	frozenTuple,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownedEntryOf,
	ownedKind,
	ownValue,
	queryDescOf,
	querySchemaOf,
	requireName
} from "#compiler/schema/protocol.ts"
import { record, roleRelations, scopedEntries, wholeEntries } from "#compiler/schema/record.ts"
import { derivedDraftOf, relationDescOf, valueTypeOf } from "#compiler/schema/relation.ts"
import {
	deriveScopes,
	determines,
	entryScope,
	ownerOf,
	type Scope,
	scopableFields
} from "#compiler/schema/scope.ts"
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
	AnyScoped,
	Context,
	ContextField,
	ContextOptions,
	EntryValue,
	KeptStatements,
	Login,
	LoginOptions,
	Role,
	RoleOptionRecord,
	RoleOptions,
	RoleRelations,
	ScopedEntriesOf,
	ScopeOptions,
	SourceOf,
	WholeEntriesOf,
	WholeWritesOf,
	World,
	WritableNameOf
} from "#compiler/types/schema/world.ts"

export const contextDescOf = (value: unknown): ContextDesc | undefined =>
	ownedDesc(value, "context")
export const roleDescOf = (value: unknown): RoleDesc | undefined => ownedDesc(value, "role")

/**
 * A role as a level (write/changeset/levels.ts), read once, when role(...) builds the role: its Description; its base's
 * content (levels.ts SchemaContent), which beside the Description is its identity (levels.ts sameRoleLevel); the
 * highest level of its base it holds, every relation of that level and below it whole or scoped under its own name but
 * the closed and derived relations, which no role holds and every role reads (desc.ts heldRelation); every relation
 * of every level of its base by name (levelRelations); its entries by name; and the scope of each scoped entry.
 */
export interface RoleLevel {
	readonly desc: RoleDesc
	readonly base: SchemaContent
	/**
	 * The highest level of its base the role holds, every relation of that level and of every level below it whole or
	 * scoped under its own name but the closed and derived relations: programs over that level and every level below
	 * it run on the role, each over its scoped relations' owner's rows (program/slice.ts). Its base itself for a full
	 * role; none for a role that holds not every relation of its base's root so.
	 */
	readonly whole: SchemaContent | undefined
	readonly relations: ReadonlyMap<string, RelationDesc>
	readonly entries: ReadonlyMap<string, RoleEntryDesc>
	/**
	 * Each scoped entry's scope (scope.ts Scope), by its relation's name: a query entry of the role under that name, its
	 * definition the scope's, which scopedEntriesOf made. No other query entry is scoped, whatever its shape.
	 */
	readonly scoped: ReadonlyMap<string, Scope>
}

export const loginDescOf = (value: unknown): LoginDesc | undefined => ownedDesc(value, "login")

/**
 * The highest level of `content`, a base's levels, every relation of which and of every level below it a role holding
 * `holds`, its whole and scoped entries, holds under its own name, but the relations no role holds (desc.ts
 * heldRelation); none when the root is not held so. `relations` is every relation of every level of the base, by name.
 */
const wholeLevel = (
	content: SchemaContent,
	relations: ReadonlyMap<string, RelationDesc>,
	holds: ReadonlySet<string>
): SchemaContent | undefined => {
	const held = (level: SchemaContent | undefined): boolean => {
		for (let at = level; at !== undefined; at = at.below) {
			for (const name of at.relations.keys()) {
				const r = relations.get(name)
				if (r !== undefined && heldRelation(r) && !holds.has(name)) {
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

/**
 * A context's name and its fields' Descriptions, as context(...) and attested(...) read them alike: a declared name and
 * a record of field descriptors, each of a type a context admits (contextFieldAdmits), every other field ContextRefused
 * `claimType`.
 */
const contextFields = (
	builder: "context" | "attested",
	name: unknown,
	fields: unknown
): {
	readonly label: string
	readonly name: string
	readonly descs: Readonly<Record<string, FieldDesc>>
} => {
	const label = `${builder} ${typeof name === "string" ? name : "?"}`
	const contextName = requireName(name, label, "a context name")
	if (!isPlainRecord(fields)) {
		throw malformed(label, "a record of field descriptors")
	}
	/** A field no claim is: one a field builder made, which no value type is (valueTypeOf), or one of a type no claim's
	 * is. */
	const noClaim = (field: string) =>
		CompileError.make({
			_tag: "ContextRefused",
			at: builderLoc(`${label} field ${field}`, []),
			context: contextName,
			rule: { kind: "claimType", field }
		})
	const descs: Record<string, FieldDesc> = {}
	for (const [field, descriptor] of Object.entries(fields)) {
		const desc = valueTypeOf(descriptor, `${label} field ${field}`, () => noClaim(field)).desc
		if (!contextFieldAdmits(desc)) {
			throw noClaim(field)
		}
		descs[field] = desc
	}
	return { label, name: contextName, descs }
}

/** The admission core of context(...): a JavaScript caller's arguments checked and described, a token's context. */
export const admitContext = (
	name: unknown,
	fields: unknown,
	options: unknown,
	extra: ReadonlyArray<unknown>
): ContextDesc & { readonly source: SourceOf<"token"> } => {
	const read = contextFields("context", name, fields)
	if (extra.length > 0) {
		throw malformed(read.label, "context(name, fields, options?): at most three arguments")
	}
	if (options === undefined) {
		const top: SourceOf<"token"> = Object.freeze({ kind: "token", claim: undefined })
		return orThrow(contextOver(read.name, read.descs, top))
	}
	if (!isPlainRecord(options) || Object.keys(options).some((k) => k !== "claim")) {
		throw malformed(
			read.label,
			"options { claim }: the nested claim object the fields are read from"
		)
	}
	const nested: SourceOf<"token"> = Object.freeze({
		kind: "token",
		claim: requireName(options["claim"], read.label, "a claim object name")
	})
	return orThrow(contextOver(read.name, read.descs, nested))
}

/**
 * The admission core of attested(...): a JavaScript caller's arguments checked and described, a context whose fact
 * its server attests where it opens a Db (ir/desc.ts ContextFactSource `attested`).
 */
const admitAttested = (
	name: unknown,
	fields: unknown,
	extra: ReadonlyArray<unknown>
): ContextDesc & { readonly source: SourceOf<"attested"> } => {
	const read = contextFields("attested", name, fields)
	if (extra.length > 0) {
		throw malformed(read.label, "attested(name, fields): two arguments")
	}
	const source: SourceOf<"attested"> = Object.freeze({ kind: "attested" })
	return orThrow(contextOver(read.name, read.descs, source))
}

/**
 * context(name, fields, options?). The value holds a frozen copy of the fields, its heading, and `fact`, the decoder of
 * its one fact. A JavaScript caller's arguments past the options are refused.
 */
export const contextBuilder = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields,
	...rest: ContextOptions | readonly [unknown, ...ReadonlyArray<unknown>]
): Context<Name, Fields> => {
	const [options, ...extra] = rest
	return contextValue<Name, Fields, "token">(
		name,
		fields,
		admitContext(name, fields, options, extra)
	)
}

/**
 * attested(name, fields): a context whose one fact its server attests where it opens a Db, never a token's claim. The
 * value is a context's, as context(...) makes one. A JavaScript caller's arguments past the fields are refused.
 */
export const attestedBuilder = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>
>(
	name: Name,
	fields: Fields,
	...extra: ReadonlyArray<never>
): Context<Name, Fields, "attested"> =>
	contextValue<Name, Fields, "attested">(name, fields, admitAttested(name, fields, extra))

/** A context's value over its admitted Description: a frozen copy of its fields, its heading, its source and `fact`. */
const contextValue = <
	const Name extends string,
	const Fields extends Readonly<Record<string, ContextField>>,
	Source extends ContextFactSourceKind
>(
	name: Name,
	fields: Fields,
	desc: ContextDesc & { readonly source: SourceOf<Source> }
): Context<Name, Fields, Source> => {
	const copied = frozenCopy(fields)
	return ownValue({
		kind: "context",
		value: {
			...builtMark,
			kind: "context",
			name,
			fields: copied,
			source: desc.source,
			heading: copied,
			fact: record<[Fields]>(copied)
		},
		desc: desc,
		content: undefined
	})
}

/**
 * What admission read of a role's relation record: each entry's Description, and for a query entry its definition
 * value.
 */
interface AdmittedRole {
	readonly desc: RoleDesc
	/** The names of the whole and scoped entries, the relations it holds, which the kept statements name only. */
	readonly held: ReadonlySet<string>
	readonly level: RoleLevel
}

/** The names a statement's Descriptions name. */
const statementNames = (desc: StatementDesc): ReadonlyArray<string> => {
	switch (desc.kind) {
		case "key":
			return [desc.side.relation]
		case "mutable":
		case "race":
		case "series":
		case "check":
			return [desc.relation]
		case "unit":
			return []
		case "contained":
			return [desc.left.relation, desc.right.relation]
		case "family":
		case "tree":
			return [desc.member.relation, desc.slots.owner]
		case "fold":
			return [desc.step.relation, desc.end.relation]
		case "alternatives":
			return [desc.parent.relation, desc.roster, ...desc.arms.map((a) => a.arm.relation)]
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

/**
 * The contexts a role declares, as its caller lists them: each a context context(...) built, in the list's order, a
 * context listed twice one declaration, two of one name that differ DuplicateIdentity; none when the list is left out.
 */
const declaredContexts = (value: unknown, label: string): ReadonlyArray<ContextDesc> => {
	if (value === undefined) {
		return []
	}
	if (!isList(value)) {
		throw malformed(label, "a list of contexts built by context(...)")
	}
	const declared = new Map<string, ContextDesc>()
	for (const [i, item] of value.entries()) {
		const desc = contextDescOf(item)
		if (desc === undefined) {
			throw malformed(`${label} ${i}`, "a context built by context(...)")
		}
		const prior = declared.get(desc.name)
		if (prior === undefined) {
			declared.set(desc.name, desc)
		} else if (!sameContent(prior, desc)) {
			throw CompileError.make({
				_tag: "DuplicateIdentity",
				at: builderLoc(`${label} ${i}`, []),
				duplicate: { kind: "context", name: desc.name, earlier: builderLoc(label, []) }
			})
		}
	}
	return [...declared.values()]
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
	const scoped = new Map<string, Scope>()
	for (const [key, value] of Object.entries(relations)) {
		const at = `${label} relation ${key}`
		const loc = builderLoc(at, [baseDesc.name, roleName, key])
		const scope = ownedEntry(value, "scope")
		if (scope !== undefined) {
			const held = Object.hasOwn(baseEntry.value.relations, key)
				? baseEntry.value.relations[key]
				: undefined
			if (
				scope.desc.name !== key ||
				!below.has(key) ||
				held === undefined ||
				!sameContent(wholeOf(held, at), wholeOf(scope.value.relation, at))
			) {
				throw ruleRefused(
					builderLoc(at, []),
					"a scoped entry is a relation of the base under its own name"
				)
			}
			const parsed = entryScope(baseDesc, key, scope.desc.query)
			if (parsed === undefined) {
				throw defect(`${label}: ${key}, a scoped entry scopedEntriesOf made, states no scope`)
			}
			entries.push({ kind: "scoped", name: key, query: scope.desc.query, loc })
			kinds.set(key, "world")
			scoped.set(key, parsed)
			continue
		}
		const draft = derivedDraftOf(value)
		const kind = ownedKind(value)
		if (draft !== undefined) {
			throw ruleRefused(
				builderLoc(at, []),
				"a role holds no derived relation: it reads one through the relations its definition reads"
			)
		}
		if (kind === "relation" || kind === "closed") {
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
			const owner = ownedEntryOf(carried)
			const content =
				owner?.kind === "schema"
					? owner.content
					: owner?.kind === "fragment"
						? owner.content.level
						: undefined
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
		throw malformed(
			label,
			"options { insert?, write?, contexts? }: lists of role relation names, and of the contexts the role declares"
		)
	}
	const opts = options ?? {}
	for (const k of Object.keys(opts)) {
		if (k !== "write" && k !== "insert" && k !== "contexts") {
			throw malformed(label, `options without ${k}`)
		}
	}
	const contexts = declaredContexts(opts["contexts"], `${label} contexts`)
	for (const e of entries) {
		if (e.kind === "whole") {
			continue
		}
		const contextBreak = entryContextBreak(contexts, queryUses(e.query).contexts)
		if (contextBreak?.kind === "undeclared") {
			throw roleRefused(`${label} relation ${e.name}`, {
				kind: "entryContext",
				entry: e.name,
				context: contextBreak.context
			})
		}
		if (contextBreak?.kind === "another") {
			throw CompileError.make({
				_tag: "DuplicateIdentity",
				at: e.loc,
				duplicate: {
					kind: "context",
					name: contextBreak.context,
					earlier: builderLoc(`${label} contexts`, [])
				}
			})
		}
	}
	const writing: RoleWriting = {
		insert: nameList(opts["insert"], `${label} insert`, "an insert list"),
		write: nameList(opts["write"], `${label} write`, "a write list")
	}
	const targets = new Map<string, string>()
	/** The base relation `relation` written by `entry` under `mode`, once across both lists. */
	const target = (relation: string, entry: string, mode: WriteMode): void => {
		const prior = targets.get(relation)
		if (prior !== undefined) {
			throw roleRefused(`${label} ${mode}`, {
				kind: "writeTwice",
				relation,
				entries: [prior, entry]
			})
		}
		targets.set(relation, entry)
	}
	for (const { name: w, mode } of writtenNames(writing)) {
		const kind = kinds.get(w)
		if (kind === undefined) {
			throw roleRefused(`${label} ${mode}`, { kind: "writeOutside", name: w })
		}
		if (kind === "relation") {
			target(w, w, mode)
			continue
		}
		if (kind !== "world") {
			throw roleRefused(`${label} ${mode}`, {
				kind: "writeKind",
				name: w,
				entryKind: kind === "closedRelation" ? "closed" : kind
			})
		}
		const entry = entries.find((e) => e.name === w)
		if (entry === undefined || entry.kind === "whole") {
			throw malformed(`${label} ${mode}`, `the query entry ${w}`)
		}
		const holds = scoped.get(w)
		const analyzed = writableEntry(
			baseDesc,
			entry,
			holds === undefined
				? { kind: "probed" }
				: { kind: "scoped", determines: (fields) => determines(holds, fields) }
		)
		if (!analyzed.ok) {
			throw roleRefused(`${label} ${mode} ${w}`, {
				kind: "writeUnwritable",
				entry: w,
				why: analyzed.error.reason
			})
		}
		target(analyzed.value.target, w, mode)
	}

	const desc = orThrow(
		decodeRoleOver(baseDesc, {
			name: roleName,
			relations: entries,
			...writing,
			contexts,
			loc: builderLoc(label, [baseDesc.name, roleName])
		})
	)
	const held = new Set([
		...entries.flatMap((e) => (e.kind === "whole" ? [e.name] : [])),
		...scoped.keys()
	])
	const level: RoleLevel = Object.freeze({
		desc,
		base: baseEntry.content,
		whole: wholeLevel(baseEntry.content, below, held),
		relations: below,
		entries: new Map(desc.relations.map((e) => [e.name, e])),
		scoped
	})
	return { desc, held, level }
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
	return ownValue({
		kind: "world",
		value: { ...builtMark, kind: "world", name: key, definition, heading, fact: record(heading) },
		desc: draft,
		content: undefined
	})
}

/** Whether an entry value is a relation of the base, whole: a value the relation builders made. */
const isWhole = (value: EntryValue): value is AnyRelation | AnyRoster | AnyDerived => {
	const kind = ownedKind(value)
	return kind === "relation" || kind === "closed" || kind === "derived"
}

/** Whether an entry value is a scoped entry: a value scopedEntriesOf made. */
const isScoped = (value: EntryValue): value is AnyScoped => ownedKind(value) === "scope"

const noNames: readonly [] = Object.freeze([] as const)

/**
 * context, role and login: the world builders.
 *
 * - `context(name, fields, options?)`: the session's relation parameters, a source of at most one fact that a rule of
 *   a query over any schema matches, though a program on a Db of a role matches only the contexts the role declares,
 *   whose facts the Db's claims hold. Its fields are claims of scalar types (ir/desc.ts contextFieldAdmits);
 *   `claim` names the nested claim object they are read from.
 * - `role(base, name, relations, options?)`: a schema whose relations are defined over `base`. A whole entry is a
 *   relation of the base, itself, under its own name; a scoped entry, which scopedEntriesOf makes, holds a relation of
 *   the base under its own name by its owner's rows (scope.ts), the role relation the base relation itself; a query entry
 *   is a query over the base, admitted as a definition: a Query built over the base or one of its levels, reading no
 *   parameter, attaching nothing, approximating nothing, and naming only the base's relations. The
 *   value holds each query entry as its world relation (World), which v mints variables over and a rule matches by its
 *   name. `insert` and `write` name the role relations it writes, each a whole ordinary relation, a scoped one, or a
 *   query entry the writable-entry analysis (entry.ts) admits, at most one per base relation across the two lists
 *   (writeTwice), each written under its list's mode (ir/desc.ts WriteMode): by `insert` the role only adds facts,
 *   holding INSERT and SELECT on what the entry writes and no DELETE or UPDATE, so a program of the role that deletes
 *   or updates there is refused (RoleAccess insert); by `write` it changes an open relation, one declared mutable
 *   inside a unit, holding DELETE and UPDATE there as well. A closed relation under `write` is ownership's to refuse
 *   (schema/own.ts ownRole, writeClosed), by the one closedness the owned base states (OwnedRelation `mutable`); the
 *   types refuse a whole or scoped entry of one (types/schema/world.ts WritesOpen). `contexts` names the contexts
 *   the role declares, the facts its Db's claims hold: each query entry matches only those (entryContext), and so does
 *   each program on the role (check/checker.ts, OutsideRole context). The role keeps the base's statements whose every
 *   relation is a whole entry.
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
 * relation), the base's statements whose every relation is a whole entry, and frozen copies of the insert and write
 * lists, each empty where it is left out.
 */
export const roleBuilder = <
	Base extends AnySchema,
	const Name extends string,
	const Rs extends Readonly<Record<string, EntryValue>>,
	const I extends ReadonlyArray<string> = readonly [],
	const W extends ReadonlyArray<string> = readonly []
>(
	base: Base,
	name: Name,
	relations: Rs,
	...rest: RoleOptions<I, W> | readonly [RoleOptionRecord<I, W>, unknown, ...ReadonlyArray<unknown>]
): Role<Base, Name, RoleRelations<Rs>, I[number], W[number], never> => {
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
		if (isScoped(value)) {
			return value.relation
		}
		const draft = drafts.get(key)
		if (draft === undefined) {
			throw malformed(`role ${name}`, `the query entry ${key}`)
		}
		return world(key, value, draft)
	})
	const kept = (
		s: Base["statements"][number] | Base["listed"][number]
	): s is KeptStatements<Base, RoleRelations<Rs>> => namesOf(s).every((n) => admitted.held.has(n))
	const value = ownValue({
		kind: "role",
		value: {
			...builtMark,
			kind: "role",
			name,
			base,
			relations: relationsValue,
			statements: Object.freeze([...base.statements, ...base.listed].filter(kept)),
			insert: options?.insert === undefined ? noNames : frozenTuple(options.insert),
			write: options?.write === undefined ? noNames : frozenTuple(options.write)
		},
		desc: admitted.desc,
		content: admitted.level
	})
	recordStem(value, roleStem(admitted.desc))
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
 * scopedEntriesOf(base, { owner, roots }): the entries of a role over `base` that holds every relation of every level of
 * it under its own name, as wholeEntriesOf's do, each relation of its owner scoped (schema/scope.ts): a query entry
 * under the relation's own name with its whole heading, holding its rows of the owner. `owner` is a query over a level
 * of the base of one field that reads the role's contexts and the rows they determine by a key (ownerOf), refused
 * otherwise (ScopeRefused owner). `roots` states each root, an ordinary or stored derived relation by one of its
 * fields: its rows whose field the owner holds. Every other such relation that a declared containment chain reaches a
 * scoped relation's key from is scoped through it, in its shortest form; one reaching scoped keys in two forms is
 * refused (ambiguous). Every other relation is whole. A role holding the entries holds every relation of its base, so
 * the base's programs run on it, each over its owner's rows (program/slice.ts); spread beside entries of its own, an
 * entry under a relation's name holds that relation as the caller states it.
 */
export const scopedEntriesOf = <Base extends AnySchema>(
	base: Base,
	options: ScopeOptions<Base>
): ScopedEntriesOf<Base> => {
	const entry = ownedEntry(base, "schema")
	if (entry === undefined) {
		throw malformed("scopedEntriesOf", "a base schema built by schema(...) or schema.extend(...)")
	}
	const desc = entry.desc
	const label = `scopedEntriesOf ${desc.name}`
	if (!isPlainRecord(options) || Object.keys(options).some((k) => k !== "owner" && k !== "roots")) {
		throw malformed(
			label,
			"options { owner, roots }: the owner query and the roots by their fields"
		)
	}
	const refused = (rule: ScopeRule): CompileError =>
		CompileError.make({ _tag: "ScopeRefused", at: builderLoc(label, []), schema: desc.name, rule })
	const ownerDesc = queryDescOf(options.owner, `${label} owner`)
	const carried = querySchemaOf(options.owner)
	const carriedOwner = carried === undefined ? undefined : ownedEntryOf(carried)
	const level =
		carriedOwner?.kind === "schema"
			? carriedOwner.content
			: carriedOwner?.kind === "fragment"
				? carriedOwner.content.level
				: undefined
	if (level === undefined || !isLevelOf(level, entry.content)) {
		throw malformed(`${label} owner`, "an owner query over a level of the base")
	}
	const owner = ownerOf(desc, ownerDesc)
	if (!owner.ok) {
		throw refused(owner.error)
	}
	const given: unknown = options.roots
	if (!isPlainRecord(given)) {
		throw malformed(`${label} roots`, "roots: a record of relations, each by one of its fields")
	}
	const roots = new Map<string, string>()
	for (const [relation, field] of Object.entries(given)) {
		if (typeof field !== "string") {
			throw malformed(`${label} roots ${relation}`, "a field of the relation, by its name")
		}
		const fields = scopableFields(desc, relation)
		if (fields === undefined) {
			throw refused({ kind: "rootRelation", relation })
		}
		if (!fields.includes(field)) {
			throw refused({ kind: "rootField", relation, field })
		}
		roots.set(relation, field)
	}
	const scopes = deriveScopes(desc, owner.value, roots, builderLoc(label, [desc.name]))
	if (!scopes.ok) {
		throw refused(scopes.error)
	}
	const relations: Base["relations"] = base.relations
	return scopedEntries<Base["relations"]>(relations, (key, relation) => {
		const scope = scopes.value.get(key)
		return scope === undefined ? relation : scopedValue(key, relation, scope)
	})
}

/** The scoped entry of `relation` under `key`, holding its rows by `scope`: its definition the scope's, which role(...)
 * parses back into the scope (scope.ts scopeOf). */
const scopedValue = (
	key: string,
	relation: AnySchema["relations"][string],
	scope: Scope
): AnyScoped => {
	if (relation.kind !== "relation") {
		throw defect(`scopedEntriesOf: ${key}, no ordinary relation, scoped`)
	}
	return ownValue({
		kind: "scope",
		value: { ...builtMark, kind: "scope", name: key, relation },
		desc: { name: key, query: scope.definition, loc: builderLoc(`scoped entry ${key}`, [key]) },
		content: undefined
	})
}

/**
 * writableNamesOf(base): the names of the base's ordinary relations, every level's, in its record's order, which are
 * the whole entries a role writes, by its insert list or, an open one, by its write list (wholeWritesOf). A roster, a
 * closed relation and a derived relation are never among them.
 */
export const writableNamesOf = <Base extends AnySchema>(
	base: Base
): ReadonlyArray<WritableNameOf<Base>> =>
	Object.freeze(ordinaryNames<Base>(schemaRelations(base, "writableNamesOf")))

/**
 * wholeWritesOf(base): the options of a role that writes every whole entry it may as the base declares its relation,
 * writableNamesOf(base) split, each list in its order: `insert` names each closed relation, whose facts are inserted and
 * never changed or deleted, and `write` each open one, declared mutable inside a unit. `role(base, name,
 * wholeEntriesOf(base), wholeWritesOf(base))` writes every relation of its base, holding DELETE and UPDATE on the open
 * ones alone.
 */
export const wholeWritesOf = <Base extends AnySchema>(base: Base): WholeWritesOf<Base> => {
	/** The relations the base's mutable statements name, every level's, its listed fragments' among them, as
	 * MutableNameOf<Base> reads them off its statements' type: its open relations. */
	const open = new Set(
		levelChain(schemaDesc(base, "wholeWritesOf")).flatMap((level) =>
			level.statements.flatMap((s) => (s.kind === "mutable" ? [s.relation] : []))
		)
	)
	type Written = WholeWritesOf<Base>
	/** The one site of the fact "a name the base's mutable statements name is one MutableNameOf<Base> holds": the
	 * statements the value holds are the ones Base's type states, read at run time, a correlation no TypeScript type
	 * ties. */
	const isOpen = (name: WritableNameOf<Base>): name is Written["write"][number] => open.has(name)
	const isClosed = (name: WritableNameOf<Base>): name is Written["insert"][number] =>
		!open.has(name)
	const names = ordinaryNames<Base>(base.relations)
	return Object.freeze({
		insert: Object.freeze(names.filter(isClosed)),
		write: Object.freeze(names.filter(isOpen))
	})
}

/**
 * The member relations of a schema's ordered families, every level's: each is written nested in order under its owner,
 * never inserted alone (write/frontend/compile.ts sequenceOf). A counted family's member and a tree's relation are
 * inserted as rows of their own.
 */
const orderedMembersOf = (schema: SchemaDesc): ReadonlySet<string> => {
	const members = new Set<string>()
	for (const level of levelChain(schema)) {
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
	sameOrder(value.workload, options[0]?.workload ?? noWorkloads) &&
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
export const loginBuilder = <
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
	const value = ownValue({
		kind: "login",
		value: { ...builtMark, kind: "login", name, base, roles: reached, workload },
		desc: desc,
		content: undefined
	})
	recordStem(value, loginStem(desc))
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

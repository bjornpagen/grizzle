import type { LoginRule, RoleRule } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	type ContextDesc,
	contextFieldAdmits,
	decodeDesc,
	descText,
	type FieldDesc,
	type LoginDesc,
	type QueryDesc,
	type RelationDesc,
	type RoleDesc,
	type RoleEntryDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import { writableEntry } from "#compiler/schema/entry.ts"
import { isLevelOf, levelRelations } from "#compiler/schema/levels.ts"
import {
	builderLoc,
	describedField,
	frozenCopy,
	frozenTuple,
	isPlainRecord,
	malformed,
	orThrow,
	ownedDesc,
	ownedKind,
	ownValue,
	queryDescOf,
	querySchemaOf,
	requireName
} from "#compiler/schema/protocol.ts"
import { record, roleRelations } from "#compiler/schema/record.ts"
import { derivedDraftOf, relationDescOf, writingOf } from "#compiler/schema/relation.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { expansionDescOf, statementDescOf } from "#compiler/schema/statements.ts"
import { approximates, attachesHeading, queryUses } from "#compiler/schema/walk.ts"
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
	ContextOptions,
	EntryValue,
	KeptStatements,
	Login,
	LoginOptions,
	Role,
	RoleOptionRecord,
	RoleOptions,
	RoleRelations,
	World
} from "#compiler/types/schema/world.ts"

export const contextDescOf = (value: unknown): ContextDesc | undefined =>
	ownedDesc(value, "context")
export const roleDescOf = (value: unknown): RoleDesc | undefined => ownedDesc(value, "role")

/**
 * A role as a level (write/changeset/levels.ts): its Description; its identity, the canonical text of that Description
 * with source locations left out, so two roles are one level exactly when their identities are equal; whether it is
 * full, holding every relation of every level of its base whole under its own name; every relation of every level of
 * its base by name (levelRelations); and its entries by name. Each is read once, when role(...) builds the role.
 */
export interface RoleLevel {
	readonly desc: RoleDesc
	readonly identity: Result.Result<string, CompileError>
	readonly full: boolean
	readonly relations: ReadonlyMap<string, RelationDesc>
	readonly entries: ReadonlyMap<string, RoleEntryDesc>
}

/** The level of each role role(...) built. A WeakMap holds nothing alive and is never enumerated. */
const roleLevels = new WeakMap<object, RoleLevel>()

/** The level of a role value role(...) built, none for any other value. */
export const roleLevelOf = (value: unknown): RoleLevel | undefined =>
	hasProperties(value) ? roleLevels.get(value) : undefined
export const loginDescOf = (value: unknown): LoginDesc | undefined => ownedDesc(value, "login")

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
		return orThrow(decodeDesc("context", { name: contextName, fields: descs, claim: undefined }))
	}
	if (!isPlainRecord(options) || Object.keys(options).some((k) => k !== "claim")) {
		throw malformed(label, "options { claim }: the nested claim object the fields are read from")
	}
	const claim = requireName(options["claim"], label, "a claim object name")
	return orThrow(decodeDesc("context", { name: contextName, fields: descs, claim }))
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
	fields: Fields,
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
		desc
	)
}

const sameDesc = (a: unknown, b: unknown): boolean => orThrow(descText(a)) === orThrow(descText(b))

/**
 * What admission read of a role's relation record: each entry's Description, and for a query entry its definition
 * value.
 */
interface AdmittedRole {
	readonly desc: RoleDesc
	/** The names of the whole entries, which the kept statements name only. */
	readonly whole: ReadonlySet<string>
}

/** The names a statement's Descriptions name. */
const statementNames = (desc: StatementDesc): ReadonlyArray<string> => {
	switch (desc.kind) {
		case "key":
			return [desc.side.relation]
		case "mutable":
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
	const baseDesc = schemaDescOf(base)
	if (baseDesc === undefined) {
		throw malformed("role", "a base schema built by schema(...) or schema.extend(...)")
	}
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
		if (draft !== undefined || kind === "relation" || kind === "closed") {
			const own = draft === undefined ? relationDescOf(value, at) : undefined
			const declared = below.get(key)
			const ownName = draft === undefined ? own?.name : draft.name
			if (ownName !== key) {
				throw roleRefused(at, { kind: "wholeEntryName", entry: key, relation: String(ownName) })
			}
			const same =
				declared !== undefined &&
				(draft === undefined
					? sameDesc(declared, own)
					: declared.kind === "derived" && sameDesc(declared.query, draft.query))
			if (declared === undefined || !same) {
				throw roleRefused(at, { kind: "wholeEntryUndeclared", entry: key, base: baseDesc.name })
			}
			entries.push({ kind: "whole", name: key, loc })
			kinds.set(key, declared.kind)
			continue
		}
		const query = queryDescOf(value, at)
		/**
		 * A query built over a schema is over the base or one of its levels: a query over another schema, or over a
		 * role, would be read over the base's relations of the same names, which are not what it was built over.
		 */
		const carried = querySchemaOf(value)
		if (carried !== undefined) {
			const carriedDesc = schemaDescOf(carried)
			if (carriedDesc === undefined || !orThrow(isLevelOf(carriedDesc, baseDesc))) {
				throw roleRefused(at, {
					kind: "entryOverAnother",
					entry: key,
					base: baseDesc.name,
					over:
						carriedDesc === undefined
							? { kind: "role" }
							: { kind: "schema", schema: carriedDesc.name }
				})
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
		throw malformed(label, "options { write?, refresh? }: lists of role relation names")
	}
	const opts = options ?? {}
	for (const k of Object.keys(opts)) {
		if (k !== "write" && k !== "refresh") {
			throw malformed(label, `options without ${k}`)
		}
	}
	const write = nameList(opts["write"], `${label} write`, "a write list")
	const refresh = nameList(opts["refresh"], `${label} refresh`, "a refresh list")
	const targets = new Map<string, string>()
	const target = (relation: string, entry: string): void => {
		const prior = targets.get(relation)
		if (prior !== undefined) {
			throw roleRefused(`${label} write`, { kind: "writeTwice", relation, entries: [entry, prior] })
		}
		targets.set(relation, entry)
	}
	for (const w of write) {
		const kind = kinds.get(w)
		if (kind === undefined) {
			throw roleRefused(`${label} write`, { kind: "writeOutside", name: w })
		}
		if (kind === "relation") {
			target(w, w)
			continue
		}
		if (kind !== "world") {
			throw roleRefused(`${label} write`, {
				kind: "writeKind",
				name: w,
				entryKind: kind === "closedRelation" ? "closed" : kind
			})
		}
		const entry = entries.find((e) => e.name === w)
		if (entry?.kind !== "world") {
			throw malformed(`${label} write`, `the query entry ${w}`)
		}
		const analyzed = writableEntry(baseDesc, entry)
		if (!analyzed.ok) {
			throw roleRefused(`${label} write ${w}`, {
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
	const desc = orThrow(
		decodeDesc("role", {
			name: roleName,
			base: baseDesc,
			relations: entries,
			write,
			refresh,
			loc: builderLoc(label, [baseDesc.name, roleName])
		})
	)
	return {
		desc,
		whole: new Set(entries.flatMap((e) => (e.kind === "whole" ? [e.name] : [])))
	}
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
		draft
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
 *   (entry.ts) admits, at most one per base relation. `refresh` names derived whole entries. The role keeps the
 *   base's statements whose every relation is a whole entry.
 * - `login(base, name, roles, { workload? })`: one credential and one pool for roles over `base`, and the workloads it
 *   owns. Every role is in exactly one login, which the builder records (loginOfRole); role and login names are distinct
 *   within the login. Each role is reached through the login by its name, `Web.roles.member`, which Db.open takes.
 *
 * Each builder is the one implementation of its value: its admission core first, then the value, owned with its
 * Description (protocol.ts ownValue). Semantic checks that need the base's checked schema (a query entry's one heading,
 * its types, its operations all total) are the checker's (check/index.ts checkWorldDefinition), which every
 * compilation of the role runs.
 *
 * role(base, name, relations, options?). The value holds the base, the role relations (each query entry as its world
 * relation), the base's statements whose every relation is a whole entry, and frozen copies of the write and refresh
 * lists.
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
	const kept = (s: Base["statements"][number]): s is KeptStatements<Base, RoleRelations<Rs>> =>
		namesOf(s).every((n) => admitted.whole.has(n))
	const value = ownValue(
		{
			...builtMark,
			kind: "role",
			name,
			base,
			relations: relationsValue,
			statements: Object.freeze(base.statements.filter(kept)),
			write: options?.write === undefined ? noNames : frozenTuple(options.write),
			refresh: options?.refresh === undefined ? noNames : frozenTuple(options.refresh)
		},
		"role",
		admitted.desc
	)
	const levels = levelRelations(admitted.desc.base)
	roleLevels.set(
		value,
		Object.freeze({
			desc: admitted.desc,
			identity: descText(admitted.desc),
			full: [...levels.keys()].every((n) => admitted.whole.has(n)),
			relations: levels,
			entries: new Map(admitted.desc.relations.map((e) => [e.name, e]))
		})
	)
	return value
}

/**
 * The login each role is in: the one login(...) that took it. A WeakMap holds nothing alive and is never enumerated.
 */
const logins = new WeakMap<object, AnyLogin>()

/** The login a role value is in, undefined for a value no login took. */
export const loginOfRole = (value: unknown): AnyLogin | undefined =>
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
	const baseDesc = schemaDescOf(base)
	if (baseDesc === undefined) {
		throw malformed("login", "a base schema built by schema(...) or schema.extend(...)")
	}
	const label = `login ${baseDesc.name}.${typeof name === "string" ? name : "?"}`
	const loginName = requireName(name, label, "a login name")
	if (!isList(roles) || roles.length === 0) {
		throw malformed(label, "a nonempty list of roles built by role(...)")
	}
	const descs = roles.map((r, i) => {
		const desc = roleDescOf(r)
		if (desc === undefined) {
			throw malformed(`${label} role ${i}`, "a role built by role(...)")
		}
		const refused = (rule: LoginRule): CompileError =>
			CompileError.make({
				_tag: "LoginRefused",
				at: builderLoc(`${label} role ${desc.name}`, []),
				login: loginName,
				rule
			})
		if (!sameDesc(desc.base, baseDesc)) {
			throw refused({ kind: "roleBase", role: desc.name, base: baseDesc.name })
		}
		if (desc.name === loginName) {
			throw refused({ kind: "roleName", role: desc.name })
		}
		const prior = loginOfRole(r)
		if (prior !== undefined) {
			throw refused({ kind: "roleTwice", role: desc.name, login: prior.name })
		}
		return desc
	})
	return orThrow(
		decodeDesc("login", {
			name: loginName,
			base: baseDesc,
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
		{ ...builtMark, kind: "login", name, base, roles: reached, workload },
		"login",
		desc
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

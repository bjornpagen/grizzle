import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { foreignKeysOf, writableSupplier } from "#test/support/worlds/model/host.ts"
import { domainLawKey, lawDomainsOf } from "#test/support/worlds/model/session/domains.ts"
import {
	loginHolding,
	loginOf,
	relationSpecOf,
	roleOf,
	samePlain
} from "#test/support/worlds/model/session/state.ts"

import { derivedKeys } from "#test/support/worlds/model/session/keys.ts"
import {
	filterReadsStored,
	keysOf,
	probeOf,
	updatableFields,
	type Written,
	writtenAt,
	writtenNamed,
	writtenOf
} from "#test/support/worlds/model/session/writes.ts"

import type {
	BaseSpec,
	CatalogPerturbation,
	EntrySpec,
	FieldDomain,
	InstallSpec,
	RelationSpec,
	RoleSpec,
	Rule,
	TablePrivilege,
	Term,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/** What admission makes of a catalog for one role: admitted, or refused at the first stage that fails. */
export type Admission = "admitted" | "settings" | "privileges"

/**
 * What one perturbation does: whether `grizzle drift` finds it, and what `Db.open` of each role answers. README
 * "Deploying": Db.open checks the login's settings, the role's privileges, the login's and the role's
 * attributes and memberships, and row security on every table the role's entry narrows (`narrows`); it does not compare
 * view definitions, policy predicates or the rest of the catalog, which `grizzle migrate` and `grizzle drift` do. A
 * change that confers nothing (a membership with SET FALSE that passes on no privilege, a database setting of the
 * owner's) is admitted by both checks; a change that leaves the catalog as it was (a grant already held, a revoke of one
 * never held) is no change at all. A role's extra member is tolerated only WITH INHERIT FALSE, SET FALSE and no ADMIN
 * (packages/grizzle/src/adapter/admission/roles.ts memberDifferences): the member a perturbation grants inherits, its role being created
 * INHERIT, so it acts through the role whatever its SET, and both checks refuse it.
 */
type PerturbationEffect =
	| { readonly kind: "no-change" }
	| { readonly kind: "catalog-only" }
	| {
			readonly kind: "refusing"
			readonly stage: Exclude<Admission, "admitted">
			readonly whom: Whom
	  }

/**
 * The Dbs a perturbation's refusal reaches: every one, those of a login, of a role, of the login or the role a grant
 * names (a name is either), of a login or a role of a membership, or of the roles whose entries narrow a relation.
 */
type Whom =
	| { readonly kind: "everyone" }
	| { readonly kind: "login"; readonly login: string }
	| { readonly kind: "role"; readonly role: string }
	| { readonly kind: "grantee"; readonly name: string }
	| { readonly kind: "membership"; readonly login: string; readonly role: string }
	| { readonly kind: "narrowers"; readonly relation: string }

const noChange: PerturbationEffect = { kind: "no-change" }
const catalogOnly: PerturbationEffect = { kind: "catalog-only" }
const refusing = (stage: Exclude<Admission, "admitted">, whom: Whom): PerturbationEffect => ({
	kind: "refusing",
	stage,
	whom
})

/** Whether a perturbation's refusal reaches a Db of a role of a login. */
const reaches = (install: InstallSpec, whom: Whom, role: RoleSpec, login: string): boolean => {
	switch (whom.kind) {
		case "everyone":
			return true
		case "login":
			return login === whom.login
		case "role":
			return role.name === whom.role
		case "grantee":
			return role.name === whom.name || login === whom.name
		case "membership":
			return login === whom.login || role.name === whom.role
		case "narrowers":
			return narrowsAt(install, role, whom.relation)
	}
}

/** What Db.open of a role of a login makes of one perturbation. */
const openUnder = (
	install: InstallSpec,
	effect: PerturbationEffect,
	role: RoleSpec,
	login: string
): Admission =>
	effect.kind === "refusing" && reaches(install, effect.whom, role, login)
		? effect.stage
		: "admitted"

/**
 * Whether a written entry narrows its target (packages/engine/src/schema/entry.ts EntryFilter): a query entry whose rule
 * reads a field of its target (membershipOf), or holds a match, a negation or a comparison beside its target's
 * occurrence. A whole entry, and a query entry that filters nothing, holds every row of its target, which its grants
 * alone decide.
 */
const narrows = (base: BaseSpec, w: Written): boolean => {
	if (w.kind === "whole") {
		return false
	}
	const target = relationSpecOf(base, w.target)
	const supplied = writableSupplier(base, w.rules)
	if (target === undefined || supplied === undefined) {
		return false
	}
	const { rule } = supplied
	return (
		(membershipOf(base, w.rules, target) ?? []).length > 0 ||
		rule.matches.length > 1 ||
		rule.negations.length > 0 ||
		rule.comparisons.length > 0
	)
}

/** Whether a role's entry narrows a relation, the tables whose row security admission checks for the role. */
const narrowsAt = (install: InstallSpec, role: RoleSpec, relation: string): boolean => {
	const w = writtenAt(install.base, role, relation)
	return w !== undefined && narrows(install.base, w)
}

/**
 * The table-level privileges a role holds on a base relation: through a whole entry SELECT, INSERT and DELETE, and
 * UPDATE when the relation is mutable; through a query entry DELETE, its SELECT, INSERT and UPDATE being column grants;
 * nothing on a relation it does not write. TRUNCATE is granted to no one, and a login holds nothing on any table.
 */
export const holdsTable = (
	install: InstallSpec,
	role: string,
	relation: string,
	privilege: TablePrivilege
): boolean => {
	const spec = roleOf(install, role)
	const w = spec === undefined ? undefined : writtenAt(install.base, spec, relation)
	if (w === undefined) {
		return false
	}
	switch (privilege) {
		case "SELECT":
		case "INSERT":
			return w.kind === "whole"
		case "DELETE":
			return true
		case "UPDATE":
			return w.kind === "whole" && updatableFields(install.base, w).length > 0
		case "TRUNCATE":
			return false
	}
}

/**
 * The column grants a role holds: through a query entry SELECT and INSERT on every field of its target, and UPDATE on
 * the fields it may update in place; none through a whole entry, whose grants are the table's.
 */
export const holdsColumn = (
	install: InstallSpec,
	role: string,
	relation: string,
	field: string,
	privilege: "SELECT" | "INSERT" | "UPDATE"
): boolean => {
	const spec = roleOf(install, role)
	const w = spec === undefined ? undefined : writtenAt(install.base, spec, relation)
	if (w === undefined || w.kind === "whole") {
		return false
	}
	return privilege === "UPDATE" ? updatableFields(install.base, w).includes(field) : true
}

/**
 * Whether a role already holds a column privilege, as both admission checks judge a column grant: on the column itself,
 * or through its table's privilege, which confers it, since the checks judge a column beside its table only where the
 * table's privilege does not hold (adapter admission/roles.ts).
 */
const holdsColumnGrant = (
	install: InstallSpec,
	role: string,
	relation: string,
	field: string,
	privilege: "SELECT" | "INSERT" | "UPDATE"
): boolean =>
	holdsColumn(install, role, relation, field, privilege) ||
	holdsTable(install, role, relation, privilege)

/** A field's base type, as a world function's parameter is typed (baseTypeRef): a contract's and a refined text's base. */
const baseTypeOf = (domain: FieldDomain): string => {
	switch (domain.kind) {
		case "uuid":
		case "text":
		case "boolean":
			return domain.kind
		case "integer":
		case "contract":
		case "serial":
			return `int${domain.bits}`
		case "handle":
			return `enum ${domain.closed}`
		case "span":
			return `range${domain.bits}`
	}
}

/** The variables a term names. */
const varsOf = (t: Term): ReadonlyArray<string> => (t.kind === "var" ? [t.name] : [])

/**
 * The fields of a written query entry's target its membership reads, in the target's canonical order: a filter
 * function's parameters (writes.ts filterReadsStored says when there is one).
 */
export const membershipOf = (
	base: BaseSpec,
	rules: Arr.NonEmptyReadonlyArray<Rule>,
	target: RelationSpec
): ReadonlyArray<string> | undefined => {
	const supplied = writableSupplier(base, rules)
	if (supplied === undefined) {
		return undefined
	}
	const { rule, supplier } = supplied
	const occurrence = rule.matches[supplier]
	if (occurrence === undefined) {
		return undefined
	}
	const others = [...Arr.remove(rule.matches, supplier), ...rule.negations.flat()]
	const read = new Set([
		...Arr.flatMap(others, (o) => Arr.flatMap(Rec.values(o.fields), varsOf)),
		...Arr.flatMap(rule.comparisons, (c) => [...varsOf(c.left), ...varsOf(c.right)])
	])
	return Arr.filter(
		Arr.sort(
			Arr.map(target.fields, (f) => f.name),
			Order.String
		),
		(f) => {
			const t = occurrence.fields[f]
			return t !== undefined && (t.kind !== "var" || read.has(t.name))
		}
	)
}

/** A role's world object: what kind it is, and the definition its statement is drafted from. */
interface WorldObject {
	readonly kind: "view" | "policy" | "function"
	readonly definition: unknown
}

/**
 * What a world object's statement reads of a relation, which it waits for, so a change to it drops and creates the
 * object again (packages/engine/src/deploy/diff/diff.ts worldChangesOf): an ordinary relation's table, its fields, primary key
 * and the laws its CREATE TABLE declares inline (keys, span keys, row checks, a closed tag's conditional facts), and
 * each foreign key it takes part in, referencing or referenced, by its law, deferred or not (host.ts foreignKeysOf); a
 * derived relation's definition and its keys, its materialized view's unique indexes (keys.ts derivedKeys); a roster's
 * members. A world object depends on every compile input of what it reads, the keys its compilation proves uniqueness
 * by and the containments it proves existence by, whether or not its statement's text changes with them.
 */
const readOf = (base: BaseSpec, name: string): unknown => {
	const relation = relationSpecOf(base, name)
	if (relation !== undefined) {
		const inline = Arr.filter(base.laws, (law) => {
			switch (law.kind) {
				case "key":
				case "spanKey":
				case "check":
				case "alternatives":
					return law.relation === name
				case "contained":
				case "covered":
					return false
			}
		})
		const foreignKeys = Arr.flatMap(base.laws, (law) => {
			const taking = Arr.filter(
				foreignKeysOf(base, law),
				(fk) => fk.from === name || fk.to === name
			)
			return taking.length === 0 ? [] : [{ law, foreignKeys: taking }]
		})
		return { fields: relation.fields, key: relation.key, inline, foreignKeys }
	}
	const derived = Option.getOrUndefined(Arr.findFirst(base.derived, (d) => d.name === name))
	if (derived !== undefined) {
		return { rules: derived.rules, keys: derivedKeys(base, derived) }
	}
	return Option.getOrUndefined(Arr.findFirst(base.closed, (c) => c.name === name))?.members
}

/** The relations an entry's statements read: a whole entry's own; every relation a query entry's rules match or negate. */
const entryReads = (entry: EntrySpec): ReadonlyArray<string> =>
	entry.kind === "whole"
		? [entry.relation]
		: Arr.flatMap(entry.rules, (r) =>
				Arr.flatMap([...r.matches, ...r.negations.flat()], (o) =>
					o.source.kind === "context" ? [] : [o.source.name]
				)
			)

/**
 * A world object's definition: the entry its statement is drafted from, and what it reads of each relation the entry
 * reads and of its written target, by name.
 */
const definedBy = (
	base: BaseSpec,
	entry: EntrySpec | undefined,
	target: ReadonlyArray<string>
): unknown => {
	const reads = Arr.sort(
		new Set([...(entry === undefined ? [] : entryReads(entry)), ...target]),
		Order.String
	)
	return { entry, reads: Arr.map(reads, (name) => [name, readOf(base, name)]) }
}

/**
 * The world objects of a role (packages/engine/src/physical/ddl/roles.ts, names.ts), each by an identity that differs exactly
 * when the object or its grant does, with the definition its statement is drafted from (definedBy): its view of each
 * role relation, named by a whole entry's table and a query entry's name (a closed roster held whole has none), defined
 * by the entry; its policy on each table it writes that has row security (rowSecured), named as the role, defined by the
 * entry it writes through; the key probe of a written query entry for each key of its target, named by the entry and
 * the key's fields and typed by their base types; and the filter function of a written query entry
 * whose membership reads a stored relation besides its target's row, typed by the target fields the membership reads;
 * each function defined by its entry. A role the installation lacks has none. A migration's Structure file drops the ones it changes or removes and creates the changed ones again
 * with their grants, for each role the installation already holds, and creates every new world function (a new role's
 * views and policies wait for its schema and role, in Publish).
 */
const worldObjects = (install: InstallSpec, role: string): ReadonlyMap<string, WorldObject> => {
	const spec = roleOf(install, role)
	if (spec === undefined) {
		return new Map()
	}
	const base = install.base
	const views = Arr.flatMap(
		Rec.toEntries(spec.entries),
		([name, entry]): ReadonlyArray<readonly [string, WorldObject]> =>
			entry.kind === "query"
				? [[`view ${name}`, { kind: "view", definition: definedBy(base, entry, []) }]]
				: Arr.some(base.closed, (c) => c.name === entry.relation)
					? []
					: [[`view ${entry.relation}`, { kind: "view", definition: definedBy(base, entry, []) }]]
	)
	const written = writtenOf(base, spec)
	const policies = Arr.map(
		Arr.filter(written, (w) => rowSecured(install, w.target)),
		(w): readonly [string, WorldObject] => [
			`policy ${w.target}`,
			{ kind: "policy", definition: [w.entry, definedBy(base, spec.entries[w.entry], [w.target])] }
		]
	)
	const functions = Arr.flatMap(written, (w): ReadonlyArray<readonly [string, WorldObject]> => {
		const target = relationSpecOf(base, w.target)
		if (w.kind !== "query" || target === undefined) {
			return []
		}
		const typed = (fields: ReadonlyArray<string>): string =>
			Arr.join(
				Arr.map(fields, (f) => {
					const field = Option.getOrUndefined(Arr.findFirst(target.fields, (x) => x.name === f))
					return field === undefined ? "?" : baseTypeOf(field.domain)
				}),
				","
			)
		const fn: WorldObject = {
			kind: "function",
			definition: definedBy(base, spec.entries[w.entry], [w.target])
		}
		const probes = Arr.map(keysOf(base, w.target), (key): readonly [string, WorldObject] => [
			`probe ${w.entry} ${Arr.join(key, ",")} (${typed(key)})`,
			fn
		])
		const membership = membershipOf(base, w.rules, target)
		return [
			...probes,
			...(membership !== undefined && filterReadsStored(w.rules)
				? [[`filter ${w.entry} (${typed(membership)})`, fn] as const]
				: [])
		]
	})
	return new Map([...views, ...policies, ...functions])
}

/**
 * Whether a folder drafted from one installation to another holds a world statement in Structure: a role the
 * installation holds whose world objects the folder drops, defines anew or creates (a dropped role's all go), or a world
 * function a role the folder creates calls (worldObjects).
 */
export const changesWorlds = (from: InstallSpec, to: InstallSpec): boolean =>
	Arr.some(
		[...new Set([...Arr.map(from.roles, (r) => r.name), ...Arr.map(to.roles, (r) => r.name)])],
		(role) => {
			const before = worldObjects(from, role)
			const after = worldObjects(to, role)
			const held = roleOf(from, role) !== undefined
			return (
				Arr.some([...before], ([identity, o]) => {
					const now = after.get(identity)
					return now === undefined || !samePlain(o.definition, now.definition)
				}) ||
				Arr.some(
					[...after],
					([identity, o]) => !before.has(identity) && (held || o.kind === "function")
				)
			)
		}
	)

/** Whether a migration drops a role's world object, or creates it again under a definition of its new installation. */
const rewritten = (from: InstallSpec, to: InstallSpec, role: string, identity: string): boolean => {
	const before = worldObjects(from, role).get(identity)
	const after = worldObjects(to, role).get(identity)
	return (
		before !== undefined && (after === undefined || !samePlain(before.definition, after.definition))
	)
}

/**
 * The world object of a function a perturbation changed: a role's filter or key probe; an advance function is none.
 */
const functionObject = (
	install: InstallSpec,
	fn: WorldFunction
): { readonly role: string; readonly identity: string } | undefined => {
	const base = install.base
	switch (fn.kind) {
		case "filter":
		case "key-probe": {
			const spec = roleOf(install, fn.role)
			const prefixOf = (role: RoleSpec): string | undefined => {
				switch (fn.kind) {
					case "filter":
						return `filter ${fn.entry} (`
					case "key-probe": {
						const key = probeOf(base, role, fn)?.key
						return key === undefined ? undefined : `probe ${fn.entry} ${Arr.join(key, ",")} (`
					}
				}
			}
			const prefix = spec === undefined ? undefined : prefixOf(spec)
			const identity =
				prefix === undefined
					? undefined
					: Option.getOrUndefined(
							Arr.findFirst([...worldObjects(install, fn.role).keys()], (i) =>
								Str.startsWith(prefix)(i)
							)
						)
			return identity === undefined ? undefined : { role: fn.role, identity }
		}
		case "advance":
			return undefined
	}
}

/** The identity of the world object of an installation a perturbation changed (worldObjects), if it changed one. */
const perturbedObject = (
	install: InstallSpec,
	p: CatalogPerturbation
): { readonly role: string; readonly identity: string } | undefined => {
	const base = install.base
	switch (p.kind) {
		case "policy-dropped":
		case "policy-edited": {
			const spec = roleOf(install, p.role)
			const w = spec === undefined ? undefined : writtenNamed(base, spec, p.entry)
			return w === undefined || !rowSecured(install, w.target)
				? undefined
				: { role: p.role, identity: `policy ${w.target}` }
		}
		case "view-redefined": {
			const entry = roleOf(install, p.role)?.entries[p.entry]
			return entry === undefined
				? undefined
				: {
						role: p.role,
						identity: entry.kind === "query" ? `view ${p.entry}` : `view ${entry.relation}`
					}
		}
		case "function-redefined":
		case "search-path-altered":
			return functionObject(install, p.fn)
		case "membership-admin":
		case "membership-inherit":
		case "membership-revoked":
		case "membership-extra":
		case "member-extra":
		case "role-attribute":
		case "role-setting":
		case "database-setting":
		case "row-security":
		case "extra-grant":
		case "grant-revoked":
		case "extra-column-grant":
		case "inherited-grant":
		case "public-grant":
		case "default-privileges":
		case "column-default":
		case "not-null-dropped":
		case "extra-index":
		case "extra-table":
		case "rewrite-rule":
		case "trigger-disabled":
			return undefined
	}
}

/** Whether two lists hold the same names, in any order. */
export const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (x) => b.includes(x))

/** Whether a role installs the same grants and memberships in two installations: its entries, write and refresh lists. */
export const sameRole = (a: RoleSpec | undefined, b: RoleSpec | undefined): boolean =>
	a === undefined || b === undefined
		? a === b
		: samePlain(a.entries, b.entries) &&
			sameNames(a.write, b.write) &&
			sameNames(a.refresh, b.refresh)

/**
 * Whether a migration replaces a role's grants (packages/engine/src/deploy/diff/diff.ts grants): the role stands in both
 * installations, and its privileges change (its entries, write or refresh list) or name a view or world function the
 * folder drops or creates again. Publish then revokes every previous grant of the role, a column grant as its table's
 * grant of that privilege, and grants every grant of the new installation.
 */
const grantsReplaced = (from: InstallSpec, to: InstallSpec, role: string): boolean => {
	const before = roleOf(from, role)
	const after = roleOf(to, role)
	return (
		before !== undefined &&
		after !== undefined &&
		(!sameRole(before, after) ||
			Arr.some(
				[...worldObjects(from, role)],
				([identity, o]) => o.kind !== "policy" && rewritten(from, to, role, identity)
			))
	)
}

/**
 * Whether a REVOKE of a privilege on a relation's table takes a grant from a role: a table grant of it, or a column grant
 * of it on a field of the relation, since PostgreSQL's REVOKE on a table revokes the privilege on each of its columns as
 * well. Publish's revoke of a role's previous grants and a tamper's revoke of one privilege both take exactly these.
 */
const revokedWith = (
	install: InstallSpec,
	role: string,
	relation: string,
	privilege: TablePrivilege
): boolean =>
	holdsTable(install, role, relation, privilege) ||
	((privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE") &&
		Arr.some(relationSpecOf(install.base, relation)?.fields ?? [], (f) =>
			holdsColumn(install, role, relation, f.name, privilege)
		))

/**
 * What an installation revokes from PUBLIC (packages/engine/src/physical/ddl/roles.ts publicRevokes), as far as it varies: its
 * schemas (one per role), tables and views, identity sequences, enums and domains. A migration whose revokes differ
 * issues every one of them again in Publish.
 */
const publicRevoked = (install: InstallSpec): unknown => {
	const base = install.base
	return {
		roles: Arr.sort(
			Arr.map(install.roles, (r) => r.name),
			Order.String
		),
		views: Arr.sort(
			Arr.flatMap(install.roles, (r) =>
				Arr.flatMap([...worldObjects(install, r.name)], ([identity, o]) =>
					o.kind === "view" ? [`${r.name} ${identity}`] : []
				)
			),
			Order.String
		),
		relations: Arr.sort(
			Arr.map(base.relations, (r) => r.name),
			Order.String
		),
		serials: Arr.sort(
			Arr.flatMap(base.relations, (r) =>
				Arr.flatMap(r.fields, (f) => (f.domain.kind === "serial" ? [`${r.name}.${f.name}`] : []))
			),
			Order.String
		),
		closed: Arr.sort(
			Arr.map(base.closed, (c) => c.name),
			Order.String
		),
		domains: Arr.sort(Arr.map(lawDomainsOf(base), domainLawKey), Order.String)
	}
}

/**
 * Whether some role of an installation narrows a relation: its table has row security enabled, and a policy for each
 * role that writes it, TRUE for one whose entry holds every row. A table no entry narrows has neither.
 */
export const rowSecured = (install: InstallSpec, relation: string): boolean =>
	Arr.some(install.roles, (r) => narrowsAt(install, r, relation))

/**
 * Whether a migration from one installation to another rewrites what a perturbation changed, so the catalog holds the
 * new contract there again (packages/engine/src/deploy/diff/diff.ts): its folder drops a role's world object the perturbation
 * changed, or creates it again under a new definition (a policy, a view, a filter function or key probe); enables row
 * security on a table the new installation is the first to narrow, which a disabled or enabled
 * state then no longer departs from (ENABLE leaves FORCE as it was); replaces the role's grants (grantsReplaced),
 * which revokes an extra grant its previous grants covered (revokedWith) and grants a revoked one again; moves a role
 * to another login, which revokes it from its old login, options and all; or changes what PUBLIC is revoked from
 * (publicRevoked), which revokes everything from PUBLIC again. Every other perturbation outlives the migration: grizzle
 * creates a role's attributes and a login's settings once and stores a default only when its value changes, grants a
 * membership only with its role or its move, never touches a membership or member of the executor's roles, and
 * drops its own objects only (a dropped role's memberships go with it, which the new installation then never asks
 * about).
 */
export const healedBy = (from: InstallSpec, to: InstallSpec, p: CatalogPerturbation): boolean => {
	switch (p.kind) {
		case "row-security":
			return p.state !== "forced" && !rowSecured(from, p.relation) && rowSecured(to, p.relation)
		case "extra-grant":
		case "extra-column-grant":
			return grantsReplaced(from, to, p.role) && revokedWith(from, p.role, p.relation, p.privilege)
		case "grant-revoked":
			return grantsReplaced(from, to, p.role)
		case "membership-admin":
		case "membership-inherit": {
			const moved = loginHolding(to, p.role)
			return roleOf(from, p.role) !== undefined && moved !== undefined && moved.name !== p.login
		}
		case "public-grant":
			return !samePlain(publicRevoked(from), publicRevoked(to))
		case "membership-revoked":
		case "membership-extra":
		case "member-extra":
		case "role-attribute":
		case "role-setting":
		case "database-setting":
		case "inherited-grant":
		case "policy-dropped":
		case "policy-edited":
		case "view-redefined":
		case "function-redefined":
		case "search-path-altered":
		case "default-privileges":
		case "column-default":
		case "not-null-dropped":
		case "extra-index":
		case "extra-table":
		case "rewrite-rule":
		case "trigger-disabled": {
			const object = perturbedObject(from, p)
			return object !== undefined && rewritten(from, to, object.role, object.identity)
		}
	}
}

/** Whether a name is an installed login's. */
const isLogin = (install: InstallSpec, name: string): boolean =>
	loginOf(install, name) !== undefined

/** A login's or a role's setting changed: admission compares the login's defaults and the role's none. */
const settingEffect = (
	install: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "role-setting" }>
): PerturbationEffect => {
	switch (p.who.kind) {
		case "login": {
			const who = p.who.login
			return isLogin(install, who) ? refusing("settings", { kind: "login", login: who }) : noChange
		}
		case "role": {
			const who = p.who.role
			return roleOf(install, who) === undefined || p.change === "default-reset"
				? noChange
				: refusing("settings", { kind: "role", role: who })
		}
	}
}

/** A table's row security changed: admission requires it enabled, not forced, where a role's entry narrows it. */
const rowSecurityEffect = (
	install: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "row-security" }>
): PerturbationEffect => {
	const secured = rowSecured(install, p.relation)
	switch (p.state) {
		case "enabled":
			return secured ? noChange : catalogOnly
		case "disabled":
			return secured
				? refusing("privileges", { kind: "narrowers", relation: p.relation })
				: noChange
		case "forced":
			return refusing("privileges", { kind: "narrowers", relation: p.relation })
	}
}

const effectOf = (install: InstallSpec, p: CatalogPerturbation): PerturbationEffect => {
	switch (p.kind) {
		case "membership-admin":
		case "membership-inherit":
			return isLogin(install, p.login) && roleOf(install, p.role) !== undefined
				? refusing("privileges", { kind: "membership", login: p.login, role: p.role })
				: noChange
		case "membership-revoked":
			return loginOf(install, p.login)?.roles.includes(p.role) === true
				? refusing("privileges", { kind: "login", login: p.login })
				: noChange
		case "membership-extra":
			if (!isLogin(install, p.login)) {
				return noChange
			}
			return p.set || (p.inherit && p.holds === "a-privilege")
				? refusing("privileges", { kind: "login", login: p.login })
				: noChange
		case "member-extra":
			return roleOf(install, p.role) === undefined
				? noChange
				: refusing("privileges", { kind: "role", role: p.role })
		case "role-attribute":
			if (isLogin(install, p.role)) {
				return p.attribute === "LOGIN"
					? noChange
					: refusing("privileges", { kind: "login", login: p.role })
			}
			if (roleOf(install, p.role) === undefined || p.attribute === "INHERIT") {
				return noChange
			}
			return refusing("privileges", { kind: "role", role: p.role })
		case "role-setting":
			return settingEffect(install, p)
		case "database-setting":
			return p.change === "owner-setting" ? noChange : refusing("settings", { kind: "everyone" })
		case "row-security":
			return rowSecurityEffect(install, p)
		case "extra-grant":
			if (isLogin(install, p.role)) {
				return refusing("privileges", { kind: "grantee", name: p.role })
			}
			if (
				roleOf(install, p.role) === undefined ||
				holdsTable(install, p.role, p.relation, p.privilege)
			) {
				return noChange
			}
			return refusing("privileges", { kind: "grantee", name: p.role })
		case "grant-revoked":
			return revokedWith(install, p.role, p.relation, p.privilege)
				? refusing("privileges", { kind: "grantee", name: p.role })
				: noChange
		case "extra-column-grant":
			if (isLogin(install, p.role)) {
				return refusing("privileges", { kind: "grantee", name: p.role })
			}
			if (
				roleOf(install, p.role) === undefined ||
				holdsColumnGrant(install, p.role, p.relation, p.field, p.privilege)
			) {
				return noChange
			}
			return refusing("privileges", { kind: "grantee", name: p.role })
		case "inherited-grant":
			return isLogin(install, p.role) || roleOf(install, p.role) !== undefined
				? refusing("privileges", { kind: "grantee", name: p.role })
				: noChange
		case "public-grant":
			return refusing("privileges", { kind: "everyone" })
		case "policy-dropped": {
			const spec = roleOf(install, p.role)
			const w = spec === undefined ? undefined : writtenNamed(install.base, spec, p.entry)
			return w !== undefined && rowSecured(install, w.target)
				? refusing("privileges", { kind: "role", role: p.role })
				: noChange
		}
		case "policy-edited":
		case "view-redefined":
		case "function-redefined":
		case "search-path-altered":
		case "default-privileges":
		case "column-default":
		case "not-null-dropped":
		case "extra-index":
		case "extra-table":
		case "rewrite-rule":
		case "trigger-disabled":
			return catalogOnly
	}
}

/** What Db.open's admission makes of the tampered catalog for a role of a login. */
export const admissionOf = (
	install: InstallSpec,
	tampered: ReadonlyArray<CatalogPerturbation>,
	role: RoleSpec,
	login: string
): Admission => {
	const verdicts = Arr.map(tampered, (p) => openUnder(install, effectOf(install, p), role, login))
	if (verdicts.includes("settings")) {
		return "settings"
	}
	return verdicts.includes("privileges") ? "privileges" : "admitted"
}

/** A perturbation's label: its kind and the world object it changed, as the drift observation lists it. */
const labelOf = (p: CatalogPerturbation): string => {
	switch (p.kind) {
		case "membership-admin":
		case "membership-inherit":
		case "membership-revoked":
			return `${p.kind} ${p.login} ${p.role}`
		case "membership-extra":
			return `${p.kind} ${p.login}`
		case "member-extra":
		case "role-attribute":
			return `${p.kind} ${p.role}`
		case "role-setting":
			return `${p.kind} ${p.who.kind === "login" ? p.who.login : p.who.role}`
		case "database-setting":
			return `${p.kind} ${p.change}`
		case "row-security":
		case "public-grant":
		case "rewrite-rule":
			return `${p.kind} ${p.relation}`
		case "extra-grant":
		case "grant-revoked":
		case "inherited-grant":
			return `${p.kind} ${p.role} ${p.relation} ${p.privilege}`
		case "extra-column-grant":
			return `${p.kind} ${p.role} ${p.relation} ${p.field} ${p.privilege}`
		case "policy-dropped":
		case "policy-edited":
		case "view-redefined":
			return `${p.kind} ${p.role} ${p.entry}`
		case "function-redefined":
		case "search-path-altered":
			return `${p.kind} ${p.fn.kind}`
		case "default-privileges":
			return `${p.kind} ${p.privilege}`
		case "column-default":
		case "not-null-dropped":
		case "extra-index":
			return `${p.kind} ${p.relation} ${p.field}`
		case "extra-table":
			return p.kind
		case "trigger-disabled":
			return `${p.kind} ${p.trigger.relation}`
	}
}

/** The world objects `grizzle drift` finds changed: one label per perturbation that changed the catalog. */
export const driftOf = (
	install: InstallSpec,
	tampered: ReadonlyArray<CatalogPerturbation>
): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(tampered, (p) => effectOf(install, p).kind !== "no-change"),
		labelOf
	)

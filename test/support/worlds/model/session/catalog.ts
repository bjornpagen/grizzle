import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { writableSupplier } from "#test/support/worlds/model/host.ts"
import { heldStatement, type WorldLocus } from "#test/support/worlds/model/session/compiled.ts"
import { domainLawKey, lawDomainsOf } from "#test/support/worlds/model/session/domains.ts"
import {
	loginHolding,
	loginOf,
	relationSpecOf,
	roleOf,
	isClosedRoster,
	samePlain,
	wholesStand
} from "#test/support/worlds/model/session/state.ts"

import {
	deletable,
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
	ActionOutcome,
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

/**
 * Whether one perturbation changes the catalog, so that `grizzle drift` finds it (README "Deploying"), or leaves it as
 * it was or as the contract allows. A change that confers nothing (a membership with SET FALSE that passes on no
 * privilege, a database setting of the owner's) is no drift; a change that leaves the catalog as it was (a grant
 * already held, a revoke of one never held) is no change at all. A role's extra member is tolerated only WITH INHERIT
 * FALSE, SET FALSE and no ADMIN (packages/grizzle/src/adapter/admission/roles.ts memberDifferences): the member a
 * perturbation grants inherits, its role being created INHERIT, so it acts through the role whatever its SET, and the
 * drift check refuses it. Db.open judges none of it: it contacts nothing.
 */
type PerturbationEffect = "no-change" | "changed"

const noChange: PerturbationEffect = "no-change"
const changed: PerturbationEffect = "changed"

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

/** Whether a role's entry narrows a relation, the tables whose row security the drift check requires for the role. */
const narrowsAt = (install: InstallSpec, role: RoleSpec, relation: string): boolean => {
	const w = writtenAt(install.base, role, relation)
	return w !== undefined && narrows(install.base, w)
}

/**
 * The table-level privileges a role holds on a base relation: through a whole entry SELECT and INSERT, and UPDATE and
 * DELETE when the relation is open, mutable inside its unit; through a query entry DELETE of an open relation, its
 * SELECT, INSERT and UPDATE being column grants; nothing on a relation it does not write. TRUNCATE is granted to no one,
 * and a login holds nothing on any table.
 */
const holdsTable = (
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
			return deletable(install.base, w)
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
const holdsColumn = (
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
 * Whether a role already holds a column privilege, as the drift check judges a column grant: on the column itself, or
 * through its table's privilege, which confers it, since the check judges a column beside its table only where the
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

/**
 * A world object: what kind it is (a query entry's view, a relation's whole view, a policy or a world function), the role
 * whose names name it (its own, or, for a whole view, the first role holding its relation whole, whose names name the one
 * whole view every holder reads), where it stands among the installation's statements, and the relations its statement
 * reads, of which it waits for each.
 */
interface WorldObject {
	readonly kind: "view" | "whole" | "policy" | "function"
	readonly role: string
	readonly locus: WorldLocus
	readonly reads: ReadonlyArray<string>
}

/**
 * What a world object waits for of a relation its statement reads, so a change to it drops and creates the object
 * again (packages/engine/src/deploy/diff/diff.ts worldChangesOf): an ordinary relation's columns, its fields, each by
 * its name and the type and collation its domain gives it (diff.ts sameRead); a roster's members, whose constant a
 * change replaces. No constraint of a table is in it, its primary key and the laws its CREATE TABLE declares inline,
 * which PostgreSQL keeps every view, function and policy over (CLOSEDID2's 5bdae3758); and no foreign key. What the
 * object's compile relies on of them is in its own statement (compiled.ts heldStatement).
 */
const readOf = (base: BaseSpec, name: string): unknown => {
	const relation = relationSpecOf(base, name)
	if (relation !== undefined) {
		return { fields: relation.fields }
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

/** The relations a world object's statement reads: the entry's (entryReads), and its written target, by name. */
const readsOf = (
	entry: EntrySpec | undefined,
	target: ReadonlyArray<string>
): ReadonlyArray<string> =>
	Arr.sort(new Set([...(entry === undefined ? [] : entryReads(entry)), ...target]), Order.String)

/**
 * A world object as an installation installs it, which a migration creates again exactly where it changes: the
 * statement PostgreSQL holds of it (compiled.ts heldStatement), which says whatever its compile proves, and what it
 * waits for of each relation it reads (readOf), by name.
 */
const definitionOf = (install: InstallSpec, o: WorldObject): unknown => ({
	statement: heldStatement(install, o.role, o.locus),
	reads: Arr.map(o.reads, (name) => [name, readOf(install.base, name)])
})

/** Whether a world object an installation and its next both hold is installed alike in each (definitionOf). */
const sameObject = (
	from: InstallSpec,
	to: InstallSpec,
	before: WorldObject,
	after: WorldObject
): boolean => samePlain(definitionOf(from, before), definitionOf(to, after))

/** Whether a role holds a query entry: the installation creates its schema exactly then, of its query entries' views. */
const holdsQuery = (install: InstallSpec, role: string): boolean =>
	Arr.some(Rec.values(roleOf(install, role)?.entries ?? {}), (e) => e.kind === "query")

/**
 * The world objects of an installation (packages/engine/src/physical/ddl/roles.ts, names.ts), each by an identity that
 * differs exactly when the object or its grant does, what it is, where it stands and what it reads (WorldObject):
 * the whole view of each relation some role holds whole (a closed roster held whole has none), once, `whole <relation>`,
 * reading the relation; and for each role, under its name: its view of each query entry, named by the entry, reading
 * what the entry reads; its policy on each table it writes that has row security (rowSecured), named by the table,
 * reading what the entry it writes through reads and the table; the key probe of a written query entry for each key of
 * its target, named by the entry and the key's fields and typed by their base types; and the filter function of a
 * written query entry whose membership reads a stored relation besides its target's row, typed by the target fields the
 * membership reads; each function reading what its entry reads and its target. A migration's Structure file drops the
 * ones it changes or removes and creates the changed ones again with their grants, each where its schema or role stood
 * before (standsWithin), and creates every new world function (the others wait for their schema or role, in Publish).
 */
const worldObjects = (install: InstallSpec): ReadonlyMap<string, WorldObject> => {
	const base = install.base
	const wholes = new Map<string, WorldObject>()
	for (const r of install.roles) {
		for (const entry of Rec.values(r.entries)) {
			if (
				entry.kind === "whole" &&
				!isClosedRoster(install.base, entry.relation) &&
				!wholes.has(`whole ${entry.relation}`)
			) {
				wholes.set(`whole ${entry.relation}`, {
					kind: "whole",
					role: r.name,
					locus: { kind: "view", relation: entry.relation },
					reads: readsOf(entry, [])
				})
			}
		}
	}
	const roles = Arr.flatMap(
		install.roles,
		(spec): ReadonlyArray<readonly [string, WorldObject]> => {
			const role = spec.name
			const views = Arr.flatMap(
				Rec.toEntries(spec.entries),
				([name, entry]): ReadonlyArray<readonly [string, WorldObject]> =>
					entry.kind === "query"
						? [
								[
									`${role} view ${name}`,
									{
										kind: "view",
										role,
										locus: { kind: "view", relation: name },
										reads: readsOf(entry, [])
									}
								]
							]
						: []
			)
			const written = writtenOf(base, spec)
			const policies = Arr.map(
				Arr.filter(written, (w) => rowSecured(install, w.target)),
				(w): readonly [string, WorldObject] => [
					`${role} policy ${w.target}`,
					{
						kind: "policy",
						role,
						locus: { kind: "policy", target: w.target },
						reads: readsOf(spec.entries[w.entry], [w.target])
					}
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
				const reads = readsOf(spec.entries[w.entry], [w.target])
				const probes = Arr.map(keysOf(base, w.target), (key): readonly [string, WorldObject] => [
					`${role} probe ${w.entry} ${Arr.join(key, ",")} (${typed(key)})`,
					{ kind: "function", role, locus: { kind: "key-probe", entry: w.entry, key }, reads }
				])
				const membership = membershipOf(base, w.rules, target)
				return [
					...probes,
					...(membership !== undefined && filterReadsStored(w.rules)
						? [
								[
									`${role} filter ${w.entry} (${typed(membership)})`,
									{ kind: "function", role, locus: { kind: "filter", entry: w.entry }, reads }
								] as const
							]
						: [])
				]
			})
			return [...views, ...policies, ...functions]
		}
	)
	return new Map([...wholes, ...roles])
}

/**
 * Whether a migration from `from` creates a world object anew in Structure (packages/engine/src/deploy/diff/diff.ts
 * worldWithin): a view where its schema stood before it, its role's schema for a query entry's, its level's schema of
 * whole views for a whole one; a policy where its role stood; and every world function, which names no role.
 */
const standsWithin = (from: InstallSpec, o: WorldObject): boolean => {
	switch (o.kind) {
		case "view":
			return holdsQuery(from, o.role)
		case "whole":
			return o.locus.kind === "view" && wholesStand(from)
		case "policy":
			return roleOf(from, o.role) !== undefined
		case "function":
			return true
	}
}

/**
 * Whether a folder drafted from one installation to another holds a world statement in Structure: a world object the
 * folder drops, defines anew or creates again, or one it creates anew where its schema or role stood (standsWithin).
 */
export const changesWorlds = (from: InstallSpec, to: InstallSpec): boolean => {
	const before = worldObjects(from)
	const after = worldObjects(to)
	return (
		Arr.some([...before], ([identity, o]) => {
			const now = after.get(identity)
			return now === undefined || !sameObject(from, to, o, now)
		}) || Arr.some([...after], ([identity, o]) => !before.has(identity) && standsWithin(from, o))
	)
}

/**
 * Whether a folder creates a world function, a role's filter or key probe, anew or again under a new definition: a
 * function is named by a digest (core/identity.ts), whose COMMENT the diff writes in Publish, where a view, of a readable
 * name, is written whole in Structure (worldObjects).
 */
export const createsWorldFunction = (from: InstallSpec, to: InstallSpec): boolean => {
	const before = worldObjects(from)
	return Arr.some([...worldObjects(to)], ([identity, o]) => {
		const was = before.get(identity)
		return o.kind === "function" && (was === undefined || !sameObject(from, to, was, o))
	})
}

/** Whether a migration drops a world object, or creates it again under a definition of its new installation. */
const rewritten = (from: InstallSpec, to: InstallSpec, identity: string): boolean => {
	const before = worldObjects(from).get(identity)
	const after = worldObjects(to).get(identity)
	return before !== undefined && (after === undefined || !sameObject(from, to, before, after))
}

/** The identity of the world object of a function a perturbation changed: a role's filter or key probe. */
const functionObject = (install: InstallSpec, fn: WorldFunction): string | undefined => {
	const base = install.base
	switch (fn.kind) {
		case "filter":
		case "key-probe": {
			const spec = roleOf(install, fn.role)
			const prefixOf = (role: RoleSpec): string | undefined => {
				switch (fn.kind) {
					case "filter":
						return `${fn.role} filter ${fn.entry} (`
					case "key-probe": {
						const key = probeOf(base, role, fn)?.key
						return key === undefined
							? undefined
							: `${fn.role} probe ${fn.entry} ${Arr.join(key, ",")} (`
					}
				}
			}
			const prefix = spec === undefined ? undefined : prefixOf(spec)
			return prefix === undefined
				? undefined
				: Option.getOrUndefined(
						Arr.findFirst([...worldObjects(install).keys()], (i) => Str.startsWith(prefix)(i))
					)
		}
	}
}

/** The identity of the world object of an installation a perturbation changed (worldObjects), if it changed one: a
 * redefined whole entry's view is its relation's whole view, which every holder reads. */
const perturbedObject = (install: InstallSpec, p: CatalogPerturbation): string | undefined => {
	const base = install.base
	switch (p.kind) {
		case "policy-dropped":
		case "policy-edited": {
			const spec = roleOf(install, p.role)
			const w = spec === undefined ? undefined : writtenNamed(base, spec, p.entry)
			return w === undefined || !rowSecured(install, w.target)
				? undefined
				: `${p.role} policy ${w.target}`
		}
		case "view-redefined": {
			const entry = roleOf(install, p.role)?.entries[p.entry]
			return entry === undefined
				? undefined
				: entry.kind === "query"
					? `${p.role} view ${p.entry}`
					: `whole ${entry.relation}`
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

/**
 * Whether a migration's grants and revokes take a grant made by hand from a role (packages/engine/src/deploy/diff/
 * privileges.ts: one privilege of one grantee on one object at a time): a REVOKE of the table's privilege, which runs
 * where the previous installation holds it and the new one does not and takes each column grant of it as well, or, for a
 * column grant, a REVOKE of that column's grant, which runs where the previous installation holds it and the new one does
 * not; or the table dropped, which takes its privileges with it. A privilege both installations hold is neither revoked
 * nor granted, so a grant made by hand beside one outlives the migration.
 */
const handGrantTaken = (
	from: InstallSpec,
	to: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "extra-grant" | "extra-column-grant" }>
): boolean =>
	(holdsTable(from, p.role, p.relation, p.privilege) &&
		!holdsTable(to, p.role, p.relation, p.privilege)) ||
	(p.kind === "extra-column-grant" &&
		holdsColumn(from, p.role, p.relation, p.field, p.privilege) &&
		!holdsColumn(to, p.role, p.relation, p.field, p.privilege)) ||
	relationSpecOf(to.base, p.relation) === undefined

/**
 * Whether a role's DROP ROLE finds no grant made by hand left: the migration revokes each privilege the role held in the
 * previous installation first (privileges.ts), so a table grant made beside the table's privilege, or a column grant
 * beside the table's privilege or that column's, goes with it, and any other outlives the revokes.
 */
const handGrantRevokedForDrop = (
	from: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "extra-grant" | "extra-column-grant" }>
): boolean =>
	holdsTable(from, p.role, p.relation, p.privilege) ||
	(p.kind === "extra-column-grant" && holdsColumn(from, p.role, p.relation, p.field, p.privilege))

/**
 * Whether a migration grants back every privilege a REVOKE made by hand took that the new installation holds: it grants
 * only what the previous installation did not hold (privileges.ts), so a privilege the revoke took from the previous
 * installation's grants stays revoked, and only one the new installation holds anew is granted after it.
 */
const handRevokeGrantedBack = (
	from: InstallSpec,
	to: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "grant-revoked" }>
): boolean => {
	const privilege = p.privilege
	const tableKept =
		holdsTable(from, p.role, p.relation, privilege) && holdsTable(to, p.role, p.relation, privilege)
	const columnKept =
		(privilege === "SELECT" || privilege === "INSERT" || privilege === "UPDATE") &&
		Arr.some(
			relationSpecOf(to.base, p.relation)?.fields ?? [],
			(f) =>
				holdsColumn(from, p.role, p.relation, f.name, privilege) &&
				holdsColumn(to, p.role, p.relation, f.name, privilege)
		)
	return !tableKept && !columnKept
}

/**
 * Whether a REVOKE of a privilege on a relation's table takes a grant from a role: a table grant of it, or a column grant
 * of it on a field of the relation, since PostgreSQL's REVOKE on a table revokes the privilege on each of its columns as
 * well. A tamper's revoke of one privilege takes exactly these.
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
 * What an installation revokes from PUBLIC (packages/engine/src/physical/ddl/roles.ts publicRevokes), as far as it
 * varies, each object by its kind and name: its schemas of views (the base's of whole views, where it stands, and one
 * per role holding a query entry), tables and views, enums and domains.
 */
const publicRevoked = (install: InstallSpec): ReadonlyArray<string> => {
	const base = install.base
	return Arr.sort(
		[
			...(wholesStand(install) ? ["schema of whole views"] : []),
			...Arr.flatMap(install.roles, (r) =>
				holdsQuery(install, r.name) ? [`schema ${r.name}`] : []
			),
			...Arr.flatMap([...worldObjects(install)], ([identity, o]) =>
				o.kind === "view" || o.kind === "whole" ? [`view ${identity}`] : []
			),
			...Arr.map(base.relations, (r) => `table ${r.name}`),
			...Arr.map(base.closed, (c) => `closed ${c.name}`),
			...Arr.map(lawDomainsOf(base), (d) => `domain ${domainLawKey(d)}`)
		],
		Order.String
	)
}

/**
 * Whether a migration revokes from PUBLIC in Publish: on an object of the new installation whose revoke the previous
 * installation never ran (deploy/diff/diff.ts, the PUBLIC revokes no previous revoke took), a new role's schema, a new
 * view or table, roster or domain; an object the previous installation revoked on, kept or created again under its
 * name, it revokes on no more.
 */
export const revokesAnew = (from: InstallSpec, to: InstallSpec): boolean => {
	const before = new Set(publicRevoked(from))
	return Arr.some(publicRevoked(to), (o) => !before.has(o))
}

/**
 * Whether some role of an installation narrows a relation: its table has row security enabled, and a policy for each
 * role that writes it, TRUE for one whose entry holds every row. A table no entry narrows has neither.
 */
export const rowSecured = (install: InstallSpec, relation: string): boolean =>
	Arr.some(install.roles, (r) => narrowsAt(install, r, relation))

/**
 * Whether PostgreSQL shows a role the values of a key over a relation's fields in a constraint's DETAIL
 * (ri_ReportViolation, BuildIndexValueDescription): never where row security is on, whatever the role's policy, and
 * otherwise where the role holds SELECT on the table or on every field of the key.
 */
export const keyShown = (
	install: InstallSpec,
	role: string,
	relation: string,
	fields: ReadonlyArray<string>
): boolean =>
	!rowSecured(install, relation) &&
	(holdsTable(install, role, relation, "SELECT") ||
		Arr.every(fields, (field) => holdsColumn(install, role, relation, field, "SELECT")))

/**
 * Whether a migration from one installation to another rewrites what a perturbation changed, so the catalog holds the
 * new contract there again (packages/engine/src/deploy/diff/diff.ts): its folder drops a role's world object the perturbation
 * changed, or creates it again under a new definition (a view, a filter function or key probe, an edited policy), never
 * one the perturbation removed, a dropped policy, whose DROP stops the run (departedAt); enables row
 * security on a table the new installation is the first to narrow, or disables it on a table the old installation
 * narrowed and the new one does not, so the table's row security is the new installation's again where FORCE was not
 * set by hand (rowSecurityHealed: ENABLE and DISABLE leave FORCE as it was); revokes a privilege a grant made by hand
 * stands beside, or drops its table (handGrantTaken), or grants anew every privilege a revoke made by hand took that the new
 * installation holds (handRevokeGrantedBack), one privilege at a time (deploy/diff/privileges.ts); or moves a
 * role to another login, which revokes it from its old login, options and all. Every other perturbation outlives the
 * migration, a PUBLIC grant on a stored relation's table among them, since a migration revokes from PUBLIC only on what
 * no previous revoke took (revokesAnew), so the drift check that ends the run refuses it: grizzle
 * creates a role's attributes and a login's settings once and stores a default only when its value changes, grants a
 * membership only with its role or its move, never touches a membership or member of the executor's roles, and
 * drops its own objects only (a dropped role's memberships go with it, which the new installation then never asks
 * about).
 */
export const healedBy = (from: InstallSpec, to: InstallSpec, p: CatalogPerturbation): boolean => {
	switch (p.kind) {
		case "row-security":
			return rowSecurityHealed(from, to, p)
		case "extra-grant":
		case "extra-column-grant":
			return handGrantTaken(from, to, p)
		case "grant-revoked":
			return handRevokeGrantedBack(from, to, p)
		case "membership-admin":
		case "membership-inherit": {
			const moved = loginHolding(to, p.role)
			return roleOf(from, p.role) !== undefined && moved !== undefined && moved.name !== p.login
		}
		case "public-grant":
			return false
		case "policy-dropped":
			return false
		case "membership-revoked":
		case "membership-extra":
		case "member-extra":
		case "role-attribute":
		case "role-setting":
		case "database-setting":
		case "inherited-grant":
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
			return object !== undefined && rewritten(from, to, object)
		}
	}
}

/** A file of a folder a statement over a departed catalog stops in (departedAt): Structure or Publish. */
export type DepartedFile = "structure" | "publish"

/** Where a folder's statement over a departed catalog stops its run (departedAt), and what the run reports there. */
export interface Departure {
	readonly file: DepartedFile
	readonly reported: ActionOutcome
}

/** A stop that adapter/migrate/errors.ts StatementFailed reports as the installation having drifted. */
const drifted = (file: DepartedFile): Departure => ({
	file,
	reported: { kind: "migration-drifted" }
})

/**
 * Whether a folder grants, revokes or drops the role or login `name`: a role it drops, or whose membership in a login
 * it grants or revokes (deploy/diff/diff.ts, a membership added, changed or gone, a dropped login's among them), or a
 * login it drops.
 */
const roleStatementOver = (from: InstallSpec, to: InstallSpec, name: string): boolean => {
	if (roleOf(from, name) === undefined) {
		return loginOf(from, name) !== undefined && loginOf(to, name) === undefined
	}
	const holders = (install: InstallSpec) =>
		Arr.map(
			Arr.filter(install.logins, (l) => l.roles.includes(name)),
			(l) => l.name
		)
	return roleOf(to, name) === undefined || !sameNames(holders(from), holders(to))
}

/**
 * The stop of a migration from one installation to another at a statement over what a perturbation removed or made,
 * which PostgreSQL refuses, so the run stops there, its file rolled back: Structure, where its folder drops a world
 * object a dropped policy was or creates it again under a new definition, each by its DROP (42704, the object gone),
 * reported drifted (adapter/migrate/errors.ts StatementFailed); Publish, where it drops a role a privilege was granted
 * to by hand that no revoke of the role's previous grants takes (handGrantRevokedForDrop), by its DROP ROLE (2BP01, the
 * privilege depending on the role), reported drifted; and Publish, where it grants, revokes or drops a role or login
 * given SUPERUSER by hand (roleStatementOver), refused 42501, since PostgreSQL lets only a superuser grant, revoke,
 * alter or drop a role that holds SUPERUSER and the migrator is none. None for every other perturbation, which leaves
 * what a folder names in place or changes what no statement of a folder refuses: a membership goes with its role.
 */
export const departedAt = (
	from: InstallSpec,
	to: InstallSpec,
	p: CatalogPerturbation
): Departure | undefined => {
	switch (p.kind) {
		case "policy-dropped": {
			const object = perturbedObject(from, p)
			return object !== undefined && rewritten(from, to, object) ? drifted("structure") : undefined
		}
		case "extra-grant":
		case "extra-column-grant":
			return roleOf(from, p.role) !== undefined &&
				roleOf(to, p.role) === undefined &&
				!handGrantRevokedForDrop(from, p)
				? drifted("publish")
				: undefined
		case "role-attribute":
			return p.attribute === "SUPERUSER" && roleStatementOver(from, to, p.role)
				? { file: "publish", reported: { kind: "refused", sqlstate: "42501" } }
				: undefined
		case "row-security":
		case "grant-revoked":
		case "membership-admin":
		case "membership-inherit":
		case "public-grant":
		case "membership-revoked":
		case "membership-extra":
		case "member-extra":
		case "role-setting":
		case "database-setting":
		case "inherited-grant":
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
			return undefined
	}
}

/** Whether a name is an installed login's. */
const isLogin = (install: InstallSpec, name: string): boolean =>
	loginOf(install, name) !== undefined

/** A login's or a role's setting changed: the drift check compares the login's defaults and the role's none. */
const settingEffect = (
	install: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "role-setting" }>
): PerturbationEffect => {
	switch (p.who.kind) {
		case "login": {
			const who = p.who.login
			return isLogin(install, who) ? changed : noChange
		}
		case "role": {
			const who = p.who.role
			return roleOf(install, who) === undefined || p.change === "default-reset" ? noChange : changed
		}
	}
}

/**
 * Whether a migration from `from` to `to` leaves a table's row security as `to` states it after a hand change `p`: the
 * table's flags as the change left them, relrowsecurity set by ENABLE and cleared by DISABLE, relforcerowsecurity set by
 * FORCE, over the old installation's (enabled exactly where a role's entry narrows it, never forced); then the
 * migration's ENABLE where the new installation is the first to narrow it, or DISABLE where the old one narrowed it and
 * the new one does not, each leaving FORCE as it was (physical/ddl/roles.ts addRowSecurity, deploy/diff/departed.ts);
 * the drift check then finds it as the new installation states it exactly when it is enabled where `to` narrows it and
 * never forced.
 */
const rowSecurityHealed = (
	from: InstallSpec,
	to: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "row-security" }>
): boolean => {
	const before = rowSecured(from, p.relation)
	const after = rowSecured(to, p.relation)
	const changedBy = p.state === "enabled" ? true : p.state === "disabled" ? false : before
	const enabled = before === after ? changedBy : after
	return p.state !== "forced" && enabled === after
}

/** A table's row security changed: the drift check requires it enabled, not forced, where a role's entry narrows it. */
const rowSecurityEffect = (
	install: InstallSpec,
	p: Extract<CatalogPerturbation, { readonly kind: "row-security" }>
): PerturbationEffect => {
	const secured = rowSecured(install, p.relation)
	switch (p.state) {
		case "enabled":
			return secured ? noChange : changed
		case "disabled":
			return secured ? changed : noChange
		case "forced":
			return changed
	}
}

const effectOf = (install: InstallSpec, p: CatalogPerturbation): PerturbationEffect => {
	switch (p.kind) {
		case "membership-admin":
		case "membership-inherit":
			return isLogin(install, p.login) && roleOf(install, p.role) !== undefined ? changed : noChange
		case "membership-revoked":
			return loginOf(install, p.login)?.roles.includes(p.role) === true ? changed : noChange
		case "membership-extra":
			if (!isLogin(install, p.login)) {
				return noChange
			}
			return p.set || (p.inherit && p.holds === "a-privilege") ? changed : noChange
		case "member-extra":
			return roleOf(install, p.role) === undefined ? noChange : changed
		case "role-attribute":
			if (isLogin(install, p.role)) {
				return p.attribute === "LOGIN" ? noChange : changed
			}
			if (roleOf(install, p.role) === undefined || p.attribute === "INHERIT") {
				return noChange
			}
			return changed
		case "role-setting":
			return settingEffect(install, p)
		case "database-setting":
			return noChange
		case "row-security":
			return rowSecurityEffect(install, p)
		case "extra-grant":
			if (isLogin(install, p.role)) {
				return changed
			}
			if (
				roleOf(install, p.role) === undefined ||
				holdsTable(install, p.role, p.relation, p.privilege)
			) {
				return noChange
			}
			return changed
		case "grant-revoked":
			return revokedWith(install, p.role, p.relation, p.privilege) ? changed : noChange
		case "extra-column-grant":
			if (isLogin(install, p.role)) {
				return changed
			}
			if (
				roleOf(install, p.role) === undefined ||
				holdsColumnGrant(install, p.role, p.relation, p.field, p.privilege)
			) {
				return noChange
			}
			return changed
		case "inherited-grant":
			return isLogin(install, p.role) || roleOf(install, p.role) !== undefined ? changed : noChange
		case "public-grant":
			return changed
		case "policy-dropped": {
			const spec = roleOf(install, p.role)
			const w = spec === undefined ? undefined : writtenNamed(install.base, spec, p.entry)
			return w !== undefined && rowSecured(install, w.target) ? changed : noChange
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
			return changed
	}
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
		Arr.filter(tampered, (p) => effectOf(install, p) === "changed"),
		labelOf
	)

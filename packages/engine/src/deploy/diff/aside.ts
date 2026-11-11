import { Refusal } from "#compiler/core/canonical.ts"
import { identity, type TemporaryCensus } from "#compiler/core/identity.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	inConstraints,
	inRelations,
	inStatistics,
	inTypes,
	type ManifestObject,
	nameKey,
	type Parts,
	type QualifiedRenames,
	partsAt,
	partsByTable,
	renameQualified
} from "#compiler/deploy/snapshot/objects.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { innerIdent, parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type { ObjectName, RenameObject, SqlStatement, TableConstraint } from "#compiler/sql/ast.ts"

/** The kinds of object that hold a name in the types' name space: a relation's row type, or a domain. */
type Holding = "table" | "materializedView" | "domain"

/** What a relation holder owns under a name of its own, read off its parts (objectParts), and the name it is renamed
 * to: a key, whose index takes the constraint's name and is renamed through it; a constraint with no index, a CHECK or
 * a foreign key, whose name lies in its relation's namespace alone; another index over it; an identity sequence of one
 * of its columns; an extended statistics object over it. Setting a relation aside takes the names it owns in its
 * schema's pg_class and statistics objects (ownedBy), never a constraint's with no index, which stays its own. */
export interface Owned {
	readonly kind: "key" | "constraint" | "index" | "sequence" | "statistics"
	readonly name: string
	readonly to: string
}

/** Why a holder is renamed: the target gives its name an object of another kind, the taker; or the migration declares
 * its rename (`--rename`), `to` the target's name. */
export type AsideCause =
	| { readonly kind: "taken"; readonly taker: { readonly kind: Holding; readonly ident: string } }
	| { readonly kind: "declared" }

/** A holder set aside: its kind and name, why, the name it is set aside to, and for a relation, what it owns that goes
 * aside with it. A type is only ever taken: a kept type's identity is its name. */
export type Aside =
	| {
			readonly kind: "table" | "materializedView"
			readonly name: ObjectName
			readonly cause: AsideCause
			readonly to: string
			readonly owned: ReadonlyArray<Owned>
	  }
	| {
			readonly kind: "domain"
			readonly name: ObjectName
			readonly cause: AsideCause
			readonly to: string
	  }

/** The name a holder holds in the types' name space, if it holds one. */
const heldName = (
	ident: string
): { readonly kind: Holding; readonly name: ObjectName } | undefined => {
	const parsed = parseIdent(ident)
	if (parsed.kind !== "table" && parsed.kind !== "materializedView" && parsed.kind !== "domain") {
		return undefined
	}
	return { kind: parsed.kind, name: { schema: parsed.schema, name: parsed.name } }
}

/** The name the naming door sets an object aside under (identity.aside), as the migration's census admits it. */
export const asideName = (temporaries: TemporaryCensus, name: string): string => {
	const named = temporaries.admit(identity.aside(name))
	if (!named.ok) {
		throw new Refusal(named.error)
	}
	return named.value
}

/** A key: a constraint with an index of its own, which takes the constraint's name: a primary key, a candidate key or
 * a span key's exclusion constraint. */
const isKey = (c: TableConstraint): boolean =>
	c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude"

/** What a holder owns under a name of its schema's pg_class or statistics objects, read off its parts, each name once:
 * its keys, its identity sequences, the indexes and the statistics objects over it. */
const ownedBy = (
	holder: ObjectName,
	parts: Parts,
	temporaries: TemporaryCensus
): ReadonlyArray<Owned> =>
	[
		...[...parts.constraint.values()].flatMap((c) =>
			isKey(c.constraint) ? [{ kind: "key" as const, name: c.name }] : []
		),
		...[...parts.sequence.values()].flatMap((q) =>
			q.sequence.schema === holder.schema ? [{ kind: "sequence" as const, name: q.name }] : []
		),
		...[...parts.index.keys()].map((name) => ({ kind: "index" as const, name })),
		...[...parts.statistics.values()].flatMap((x) =>
			x.create.name.schema === holder.schema ? [{ kind: "statistics" as const, name: x.name }] : []
		)
	].map((f) => ({ ...f, to: asideName(temporaries, f.name) }))

/** A relation of `previous` set aside whole, `to` its aside name: every name it owns in pg_class and among the
 * statistics objects goes aside with it, under its own aside name (ownedBy). */
export const relationAside = (
	previous: DeploySnapshot,
	kind: "table" | "materializedView",
	name: ObjectName,
	cause: AsideCause,
	temporaries: TemporaryCensus
): Aside => {
	const holders = previous.manifest.objects
	const byIdent = new Map(holders.map((o) => [o.ident, o]))
	return {
		kind,
		name,
		cause,
		to: asideName(temporaries, name.name),
		owned: ownedBy(name, partsAt(partsByTable(holders, byIdent), name), temporaries)
	}
}

/** The holders of the previous snapshot set aside, each with why, its aside name, and, for a relation, what it owns:
 * those whose name the target gives an object of another kind, and the kept stored relations whose identity moves.
 *
 * Names a migration frees before it takes them.
 *
 * PostgreSQL keeps one name space per schema for types, where each table's and materialized view's row type lives
 * beside the domains, and one for relations, tables and materialized views among them. The naming door gives tables,
 * derived relations, rosters' domains and contracts' domains their declared names, one name space for all four, so a
 * migration may give a name to an object of another kind than the one holding it before:
 * - a roster's domain taking a removed table's name;
 * - a table taking a removed contract's domain's;
 * - a derived relation taking a stored one's.
 * The holder stands until the end of the migration, so the taker could be neither created nor renamed into the name.
 * Two such takers may also swap names (a table A renamed to B while a domain B is renamed to A), a cycle that no order
 * of renames breaks. A declared rename moves an identity between names of one kind itself (declared.ts).
 *
 * Rule: every holder whose name the target gives an object of another kind is first renamed aside, in Setup, to the
 * name the naming door gives it set aside (identity.aside),
 * which the migration's census `temporaries` admits or refuses as DigestCollision (core/identity.ts TemporaryCensus).
 * A relation holder is renamed aside whole: every name it owns in pg_class and among the statistics objects goes aside
 * with it, under its own aside name: each key's index, through its constraint; each other index over it; the identity
 * sequence of each of its columns; and each extended statistics object over it. The renames are one group under a
 * marker the reviewer confirms, kept or removed whole. The diff then starts from the previous snapshot as it is after
 * those renames (setAside), so every statement that names a holder or what it owns names it where it stands: its
 * teardown and its drop at the end of the migration. Every taker is then created or renamed into a free name. */
export const asidesOf = (
	previous: DeploySnapshot,
	target: ReadonlyArray<ManifestObject>,
	temporaries: TemporaryCensus
): ReadonlyArray<Aside> => {
	const kept = new Set(target.map((o) => o.ident))
	const takers = new Map<string, { readonly kind: Holding; readonly ident: string }>()
	for (const o of target) {
		const held = heldName(o.ident)
		if (held !== undefined) {
			takers.set(nameKey(held.name), { kind: held.kind, ident: o.ident })
		}
	}
	const holders = previous.manifest.objects
	const parts = partsByTable(holders, new Map(holders.map((o) => [o.ident, o])))
	const owned = (holder: ObjectName): ReadonlyArray<Owned> =>
		ownedBy(holder, partsAt(parts, holder), temporaries)
	return holders.flatMap((o): ReadonlyArray<Aside> => {
		const held = heldName(o.ident)
		if (held === undefined || kept.has(o.ident)) {
			return []
		}
		const taker = takers.get(nameKey(held.name))
		if (taker === undefined) {
			return []
		}
		return [
			takenAside(held, { kind: "taken", taker }, asideName(temporaries, held.name.name), owned)
		]
	})
}

/** The aside of a removed holder whose name an object of another kind of the target takes. */
const takenAside = (
	held: { readonly kind: Holding; readonly name: ObjectName },
	cause: AsideCause & { readonly kind: "taken" },
	to: string,
	owned: (holder: ObjectName) => ReadonlyArray<Owned>
): Aside => {
	switch (held.kind) {
		case "table":
		case "materializedView":
			return { kind: held.kind, name: held.name, cause, to, owned: owned(held.name) }
		case "domain":
			return { kind: held.kind, name: held.name, cause, to }
	}
}

/** The RENAME of what a set-aside relation owns, under the relation's aside name `to`. */
const ownedRename = (at: (name: string) => ObjectName, to: string, o: Owned): SqlStatement => {
	switch (o.kind) {
		case "key":
		case "constraint":
			return { kind: "renameConstraint", table: at(to), from: o.name, to: o.to }
		case "index":
			return { kind: "rename", object: "INDEX", name: at(o.name), to: o.to }
		case "sequence":
			return { kind: "rename", object: "SEQUENCE", name: at(o.name), to: o.to }
		case "statistics":
			return { kind: "rename", object: "STATISTICS", name: at(o.name), to: o.to }
	}
}

/** The RENAME of a holder's kind. */
const asideObject = (kind: Holding): Exclude<RenameObject["object"], "ROLE" | "SCHEMA"> => {
	switch (kind) {
		case "table":
			return "TABLE"
		case "materializedView":
			return "MATERIALIZED VIEW"
		case "domain":
			return "DOMAIN"
	}
}

/** The statements that set a holder aside, one group the reviewer confirms: its rename, then, for a relation, each key
 * renamed on it under its new name, which renames the key's index, and each other index, identity sequence and
 * statistics object it owns renamed. */
export const asideStatements = (a: Aside): NonEmptyReadonlyArray<SqlStatement> => {
	const holder: SqlStatement = {
		kind: "rename",
		object: asideObject(a.kind),
		name: a.name,
		to: a.to
	}
	switch (a.kind) {
		case "domain":
			return [holder]
		case "table":
		case "materializedView": {
			const at = (name: string): ObjectName => ({ ...a.name, name })
			return [holder, ...a.owned.map((o) => ownedRename(at, a.to, o))]
		}
	}
}

/** The previous snapshot as it is once its holders are set aside: each holder, and for a relation its columns,
 * constraints, triggers and what it owns (Owned), under the aside names in its identities, its definitions, its
 * dependencies and every other statement that names them, the grants, PUBLIC revokes and role defaults among them
 * (withNames). Its fingerprint stays the committed one, the folder's source. */
export const setAside = (
	previous: DeploySnapshot,
	asides: ReadonlyArray<Aside>
): DeploySnapshot => {
	if (asides.length === 0) {
		return previous
	}
	const relationAsides = asides.flatMap((a) =>
		a.kind === "table" || a.kind === "materializedView" ? [a] : []
	)
	const owned = (kinds: ReadonlyArray<Owned["kind"]>) =>
		relationAsides.flatMap((a) =>
			a.owned.filter((o) => kinds.includes(o.kind)).map((o) => [o.name, o.to] as const)
		)
	return withNames(previous, {
		relations: new Map([
			...relationAsides.map((a) => [a.name.name, a.to] as const),
			...owned(["key", "index", "sequence"])
		]),
		types: new Map(
			asides.flatMap((a) => (a.kind === "domain" ? [[a.name.name, a.to] as const] : []))
		),
		statistics: new Map(owned(["statistics"])),
		keys: new Map(
			relationAsides.map(
				(a) =>
					[
						a.name.name,
						new Map(a.owned.filter((o) => o.kind === "key").map((o) => [o.name, o.to] as const))
					] as const
			)
		)
	})
}

/** Renames of the names a snapshot's schema holds, each namespace's by the name it renames: its relations' in pg_class
 * (tables, materialized views, indexes, a key's index and identity sequences), its types', its statistics objects', and
 * each relation's own constraints', by the relation's name before the renames. */
export interface Renamed {
	readonly relations: ReadonlyMap<string, string>
	readonly types: ReadonlyMap<string, string>
	readonly statistics: ReadonlyMap<string, string>
	readonly keys: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/** A snapshot with every name `names` renames renamed, in its identities, its definitions, its dependencies and every
 * other statement that names them, the grants, PUBLIC revokes and role defaults among them: a key's name in its
 * relation's own namespace (inConstraints) first, under its relation's old name, then the relations, their indexes and
 * sequences in the relations' namespace, the types in the types' and the statistics objects in theirs. Its fingerprint
 * stays the committed one. */
export const withNames = (previous: DeploySnapshot, names: Renamed): DeploySnapshot => {
	const schema = previous.schema
	const { relations, types, statistics, keys } = names
	const maps: ReadonlyArray<QualifiedRenames> = [
		inConstraints(keys),
		inRelations(relations),
		inTypes(types),
		inStatistics(statistics)
	]
	const ident = (id: string): string => {
		const parsed = parseIdent(id)
		switch (parsed.kind) {
			case "table":
			case "materializedView":
			case "index":
			case "rowSecurity":
			case "replicaIdentity": {
				const to = parsed.schema === schema ? relations.get(parsed.name) : undefined
				return to === undefined ? id : qualifiedIdent(parsed.kind, parsed.schema, to)
			}
			case "domain": {
				const to = parsed.schema === schema ? types.get(parsed.name) : undefined
				return to === undefined ? id : qualifiedIdent(parsed.kind, parsed.schema, to)
			}
			case "statistics": {
				const to = parsed.schema === schema ? statistics.get(parsed.name) : undefined
				return to === undefined ? id : qualifiedIdent(parsed.kind, parsed.schema, to)
			}
			case "column":
			case "constraint":
			case "trigger":
			case "policy": {
				if (parsed.schema !== schema) {
					return id
				}
				const to = relations.get(parsed.relation)
				const key =
					parsed.kind === "constraint" ? keys.get(parsed.relation)?.get(parsed.name) : undefined
				return to === undefined && key === undefined
					? id
					: innerIdent(parsed.kind, parsed.schema, to ?? parsed.relation, key ?? parsed.name)
			}
			case "function":
			case "view":
			case "membership":
			case "schema":
			case "extension":
			case "role":
			case "privileges":
			case "publication":
			case "other":
				return id
		}
	}
	const statements = (list: ReadonlyArray<SqlStatement>): ReadonlyArray<SqlStatement> =>
		maps.reduce<ReadonlyArray<SqlStatement>>((acc, m) => renameQualified(acc, schema, m), list)
	const object = (o: ManifestObject): ManifestObject => ({
		...o,
		ident: ident(o.ident),
		ddl: statements(o.ddl)
	})
	return {
		...previous,
		manifest: {
			...previous.manifest,
			objects: previous.manifest.objects.map((o) => object(o)),
			edges: previous.manifest.edges.map((e) => ({ from: ident(e.from), to: ident(e.to) })),
			roleDefaults: statements(previous.manifest.roleDefaults),
			publicRevokes: statements(previous.manifest.publicRevokes)
		}
	}
}

/** The RENAME of each part `owned` of the relation `table` (Owned), on the relation under its name. */
export const partRenames = (
	table: ObjectName,
	owned: ReadonlyArray<Owned>
): ReadonlyArray<SqlStatement> => {
	const at = (name: string): ObjectName => ({ ...table, name })
	return owned.map((o) => ownedRename(at, table.name, o))
}

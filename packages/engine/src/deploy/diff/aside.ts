import { identifierOf, identity } from "#compiler/core/identity.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	inConstraints,
	inRelations,
	inStatistics,
	installed,
	inTypes,
	type ManifestObject,
	nameKey,
	type Parts,
	type QualifiedRenames,
	relationParts,
	renameQualified,
	sameHeading
} from "#compiler/deploy/snapshot/objects.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { innerIdent, parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	CreateTable,
	ObjectName,
	RenameObject,
	SqlStatement,
	TableConstraint
} from "#compiler/sql/ast.ts"

/** The kinds of object that hold a name in the types' name space: a relation's row type, or a type. */
type Holding = "table" | "materializedView" | "enum" | "domain"

/** What a relation holder owns under a name of its schema's pg_class or statistics objects, read off its parts
 * (objectParts), and the name it is set aside to: a key, whose index takes the constraint's name and is renamed through
 * it; another index over it; an identity sequence of one of its columns; an extended statistics object over it. */
interface Owned {
	readonly kind: "key" | "index" | "sequence" | "statistics"
	readonly name: string
	readonly to: string
}

/** Why a holder is set aside: the target gives its name an object of another kind, the taker; or it is a kept stored
 * relation whose identity moves, the target's relations of the heading it holds being where it may go. */
export type AsideCause =
	| { readonly kind: "taken"; readonly taker: { readonly kind: Holding; readonly ident: string } }
	| { readonly kind: "moved"; readonly toward: NonEmptyReadonlyArray<ObjectName> }

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
			readonly kind: "enum" | "domain"
			readonly name: ObjectName
			readonly cause: AsideCause & { readonly kind: "taken" }
			readonly to: string
	  }

/** The name a holder holds in the types' name space, if it holds one. */
const heldName = (
	ident: string
): { readonly kind: Holding; readonly name: ObjectName } | undefined => {
	const parsed = parseIdent(ident)
	if (
		parsed.kind !== "table" &&
		parsed.kind !== "materializedView" &&
		parsed.kind !== "enum" &&
		parsed.kind !== "domain"
	) {
		return undefined
	}
	return { kind: parsed.kind, name: { schema: parsed.schema, name: parsed.name } }
}

/** The name the naming door sets an object aside under (identity.aside). */
const asideName = (name: string): string => identifierOf(identity.aside(name))

/** A key: a constraint with an index of its own, which takes the constraint's name: a primary key, a candidate key or
 * a span key's exclusion constraint. */
const isKey = (c: TableConstraint): boolean =>
	c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude"

/** What a holder owns under a name of its schema's pg_class or statistics objects, read off its parts, each name once:
 * its keys, its identity sequences, the indexes and the statistics objects over it. */
const ownedBy = (holder: ObjectName, parts: Parts): ReadonlyArray<Owned> =>
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
	].map((f) => ({ ...f, to: asideName(f.name) }))

/** The stored relations of a manifest, each with its definition, by identity. */
const tablesOf = (objects: ReadonlyArray<ManifestObject>): ReadonlyMap<string, CreateTable> =>
	new Map(
		objects.flatMap((o): ReadonlyArray<readonly [string, CreateTable]> => {
			const v = installed(o)
			return v.kind === "table" ? [[o.ident, v.create]] : []
		})
	)

/** The kept stored relations whose identity moves, by identity, each with the target's relations of the heading it
 * holds: its target declaration has another heading, and another relation of the target, added or itself changed, has
 * exactly the heading it holds. */
const movedOf = (
	previous: ReadonlyArray<ManifestObject>,
	target: ReadonlyArray<ManifestObject>
): ReadonlyMap<string, NonEmptyReadonlyArray<ObjectName>> => {
	const before = tablesOf(previous)
	const after = tablesOf(target)
	/** A relation of the target as it was: kept, with the heading it held. */
	const asItWas = (ident: string, create: CreateTable): boolean => {
		const was = before.get(ident)
		return was !== undefined && sameHeading(was, create)
	}
	const open = [...after].filter(([ident, create]) => !asItWas(ident, create))
	const out = new Map<string, NonEmptyReadonlyArray<ObjectName>>()
	for (const [ident, was] of before) {
		const now = after.get(ident)
		if (now === undefined || sameHeading(was, now)) {
			continue
		}
		const toward = open.flatMap(([other, create]) =>
			other !== ident && sameHeading(was, create) ? [create.table] : []
		)
		if (isNonEmpty(toward)) {
			out.set(ident, toward)
		}
	}
	return out
}

/** The holders of the previous snapshot set aside, each with why, its aside name, and, for a relation, what it owns:
 * those whose name the target gives an object of another kind, and the kept stored relations whose identity moves.
 *
 * Names a migration frees before it takes them.
 *
 * PostgreSQL keeps one name space per schema for types, where each table's and materialized view's row type lives
 * beside the enums and domains, and one for relations, tables and materialized views among them. The naming door gives
 * tables, derived relations, closed relations' enums and contracts' domains their declared names, one name space for
 * all four, so a migration may give a name to an object of another kind than the one holding it before:
 * - a closed relation's enum taking a removed table's name;
 * - a table taking a removed contract's domain's;
 * - a derived relation taking a stored one's.
 * The holder stands until the end of the migration, or a candidate renames it, so the taker could be neither created
 * nor renamed into the name, whichever candidates the reviewer chooses. Two such takers may also swap names (a table A
 * renamed to B while a type B is renamed to A), a cycle that no order of renames breaks.
 *
 * A name may also stay with one kind while the identity holding it moves: two stored relations swapped (A and B
 * exchange names), or a chain (A renamed to B while B is renamed to C). The diff compares objects by name, so it would
 * change the table holding the kept name in place into the other relation, its rows staying under the old name. A kept
 * stored relation's identity moves when its target declaration has another heading than the one it holds, and another
 * relation of the target that is not itself as it was, added or changed, has exactly the heading it holds: that
 * relation may be it renamed. The heading is the one evidence a name carries beside itself; two relations of one
 * heading swapped stay indistinguishable, and are no change at all.
 *
 * Rule: every holder whose name the target gives an object of another kind, and every kept stored relation whose
 * identity moves, is first renamed aside, in Setup, to the name the naming door gives it set aside (identity.aside).
 * A relation holder is renamed aside whole: every name it owns in pg_class and among the statistics objects goes aside
 * with it, under its own aside name: each key's index, through its constraint; each other index over it; the identity
 * sequence of each of its columns; and each extended statistics object over it. The renames are one group under a
 * marker the reviewer confirms, kept or removed whole. The diff then starts from the previous snapshot as it is after
 * those renames (setAside), so every statement that names a holder or what it owns names it where it stands: its
 * teardown, a candidate rename of it, and its drop at the end of the migration, a loss the reviewer decides. Every taker
 * is then created or renamed into a free name, and a swap is two holders set aside and two takers moving in: each
 * set-aside relation is a removed one, offered as a candidate rename of each added relation it may be
 * (`renameCandidateTable`), its own target name among them, so the reviewer chooses where its rows go. */
export const asidesOf = (
	previous: DeploySnapshot,
	target: ReadonlyArray<ManifestObject>
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
	const byIdent = new Map(holders.map((o) => [o.ident, o]))
	const owned = (holder: ObjectName): ReadonlyArray<Owned> =>
		ownedBy(holder, relationParts(holder, holders, byIdent))
	const moved = movedOf(holders, target)
	return holders.flatMap((o): ReadonlyArray<Aside> => {
		const held = heldName(o.ident)
		if (held === undefined) {
			return []
		}
		const to = asideName(held.name.name)
		if (kept.has(o.ident)) {
			const toward = moved.get(o.ident)
			return toward === undefined || held.kind !== "table"
				? []
				: [
						{
							kind: "table",
							name: held.name,
							cause: { kind: "moved", toward },
							to,
							owned: owned(held.name)
						}
					]
		}
		const taker = takers.get(nameKey(held.name))
		if (taker === undefined) {
			return []
		}
		return [takenAside(held, { kind: "taken", taker }, to, owned)]
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
		case "enum":
		case "domain":
			return { kind: held.kind, name: held.name, cause, to }
	}
}

/** The RENAME of what a set-aside relation owns, under the relation's aside name `to`. */
const ownedRename = (at: (name: string) => ObjectName, to: string, o: Owned): SqlStatement => {
	switch (o.kind) {
		case "key":
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
		case "enum":
			return "TYPE"
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
		case "enum":
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
 * dependencies and every other statement that names them, the grants, PUBLIC revokes and role defaults among them: a
 * key's name in its relation's own namespace (inConstraints), renamed first, under its holder's old name, then the
 * holders, their indexes and sequences in the relations' namespace, the types in the types' and the statistics objects
 * in theirs. Its fingerprint stays the committed one, the folder's source. */
export const setAside = (
	previous: DeploySnapshot,
	asides: ReadonlyArray<Aside>
): DeploySnapshot => {
	if (asides.length === 0) {
		return previous
	}
	const schema = previous.schema
	const relationAsides = asides.flatMap((a) =>
		a.kind === "table" || a.kind === "materializedView" ? [a] : []
	)
	const owned = (kinds: ReadonlyArray<Owned["kind"]>) =>
		relationAsides.flatMap((a) =>
			a.owned.filter((o) => kinds.includes(o.kind)).map((o) => [o.name, o.to] as const)
		)
	/** The holders' tables and views, and in the same pg_class name space their keys' and other indexes and their
	 * sequences. */
	const relations = new Map([
		...relationAsides.map((a) => [a.name.name, a.to] as const),
		...owned(["key", "index", "sequence"])
	])
	const types = new Map(
		asides.flatMap((a) =>
			a.kind === "enum" || a.kind === "domain" ? [[a.name.name, a.to] as const] : []
		)
	)
	const statistics = new Map(owned(["statistics"]))
	/** Each relation holder's keys by its name, in its own namespace. */
	const keys = new Map(
		relationAsides.map(
			(a) =>
				[
					a.name.name,
					new Map(a.owned.filter((o) => o.kind === "key").map((o) => [o.name, o.to] as const))
				] as const
		)
	)
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
			case "rowSecurity": {
				const to = parsed.schema === schema ? relations.get(parsed.name) : undefined
				return to === undefined ? id : qualifiedIdent(parsed.kind, parsed.schema, to)
			}
			case "enum":
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
				const to = parsed.schema === schema ? relations.get(parsed.relation) : undefined
				if (to === undefined) {
					return id
				}
				const key =
					parsed.kind === "constraint" ? keys.get(parsed.relation)?.get(parsed.name) : undefined
				return innerIdent(parsed.kind, parsed.schema, to, key ?? parsed.name)
			}
			case "function":
			case "view":
			case "membership":
			case "schema":
			case "extension":
			case "role":
			case "privileges":
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

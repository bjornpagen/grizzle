import { Refusal } from "#compiler/core/canonical.ts"
import { type Dropped, undeclaredDrop, unsupported } from "#compiler/core/errors.ts"
import {
	conversionOf,
	type DeclaredName,
	declaredAlike,
	parseDeclaredName,
	type TemporaryCensus
} from "#compiler/core/identity.ts"
import type { ColumnIdent } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type Aside,
	asideName,
	asideStatements,
	type Owned,
	partRenames,
	relationAside,
	setAside,
	withNames
} from "#compiler/deploy/diff/aside.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import { fieldWriting } from "#compiler/deploy/snapshot/build.ts"
import {
	installed,
	type ManifestObject,
	nameKey,
	type PartOf,
	partsAt,
	partsByTable,
	same
} from "#compiler/deploy/snapshot/objects.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotLogin,
	SnapshotRelation,
	SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import { fillersOf } from "#compiler/laws/model/fillers.ts"
import {
	type PreviousNames,
	PreviousSpelling,
	restatedLawColumn
} from "#compiler/laws/model/restate.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { innerIdent, namedIdent, parseIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	AlterTableAction,
	ColumnDef,
	Expr,
	ForeignKeyColumn,
	Grantee,
	InlineConstraint,
	KeyColumn,
	ObjectName,
	SqlStatement,
	TableConstraint
} from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"

/**
 * A draft's declarations (`--rename`, `--drop`) applied to the previous snapshot: the statements that carry out its
 * renames, which run first, and the previous snapshot as it stands after them, which the diff compares with the target.
 * A renamed relation, field or login is then one identity under its target name, so the diff changes it in place and
 * never reads a drop and an addition as one.
 */
export interface Applied {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly previous: DeploySnapshot
}

/** A name as a refusal spells it. */
const spelled = (n: Named): string => {
	switch (n.kind) {
		case "relation":
			return n.relation
		case "field":
			return `${n.relation}.${n.field}`
		case "handle":
			return `${n.roster}#${n.handle}`
		case "login":
			return `@${n.login}`
	}
}

/** The key a name is told apart by: its kind and its spelling, a login's name by its conversion, which names its role
 * (core/identity.ts declaredAlike). */
const keyOf = (n: Named): string =>
	n.kind === "login" ? `login ${conversionOf(n.login)}` : `${n.kind} ${spelled(n)}`

const sameNamed = (a: Named, b: Named): boolean => keyOf(a) === keyOf(b)

/** A snapshot's record name as a declared name: grizzle wrote it, so one the rule refuses is a defect. */
const declared = (name: string): DeclaredName => {
	const parsed = parseDeclaredName(name)
	if (!parsed.ok) {
		throw defect(`the snapshot records ${JSON.stringify(name)} under a declared name`)
	}
	return parsed.value
}

/** A stored relation's record or a roster's, never a derived relation's, which holds no data to rename. */
type Held = Exclude<SnapshotRelation, { readonly kind: "derived" }>

const heldIn = (
	relations: Readonly<Record<string, SnapshotRelation>>,
	name: string
): Held | undefined => {
	const r = relations[name]
	return r === undefined || r.kind === "derived" ? undefined : r
}

/** Whether two names a snapshot records are alike (core/identity.ts declaredAlike): the naming door derives a relation's
 * table or roster domain, and a field's column, from its name's conversion, so two alike names are one installed
 * object, which a respelling keeps as it stands. */
const alike = (a: string, b: string): boolean => declaredAlike(declared(a), declared(b))

/** The stored relation's or roster's record of `relations` under a name alike `name`, its own first: one relation,
 * whatever spelling of its conversion a version declares it under. */
const heldAlike = (
	relations: Readonly<Record<string, SnapshotRelation>>,
	name: string
): Held | undefined => {
	const own = heldIn(relations, name)
	if (own !== undefined) {
		return own
	}
	const respelled = Object.keys(relations).find((n) => alike(n, name))
	return respelled === undefined ? undefined : heldIn(relations, respelled)
}

/** Whether grizzle draws a field's values again, so its drop loses nothing its caller wrote: a generated, drawn or
 * accumulated field. A caller's field holds the caller's values, and a serial one the identities its rows were given. */
const drawnAgain = (writing: SnapshotWriting): boolean =>
	writing !== "caller" && writing !== "serial"

/** A login a snapshot records, under its record's name. */
interface HeldLogin {
	readonly name: string
	readonly login: SnapshotLogin
}

/** The login of `logins` whose name is alike `name` (core/identity.ts declaredAlike): the naming door derives a login's
 * role from its name's conversion, so two alike names are one login. */
const loginIn = (
	logins: Readonly<Record<string, SnapshotLogin>>,
	name: DeclaredName
): HeldLogin | undefined => {
	for (const [held, login] of Object.entries(logins)) {
		if (declaredAlike(declared(held), name)) {
			return { name: held, login }
		}
	}
	return undefined
}

/**
 * The previous snapshot under the draft's declarations, and the statements that carry them out; or the refusal of a
 * declaration that names what the previous snapshot or the target does not hold as it says, of two renames of one name
 * or to one name, and of every drop no declaration names (UndeclaredDrop), each stored state the previous snapshot holds
 * and the target, under the declared renames, no longer does (plan.ts Declarations): each stored relation and roster;
 * each field of a relation both hold, but a field grizzle draws again (a generated, drawn or accumulated one); each
 * roster handle whose code the target's codes hold as a hole; and each login. Data a migration loses is lost only where
 * it says so.
 *
 * A name a rename takes ends its previous holder: a relation whose table name a renamed relation takes, a field whose
 * column a renamed field takes, and a login whose role a renamed login takes, each not renamed itself, is dropped, and
 * its drop is declared, even where the target declares a name of its own alike; the target's holds the renamed one.
 *
 * A renamed relation or roster is first renamed aside with every name it owns (aside.ts relationAside), as is each
 * relation dropped whose name a rename takes, so any order of renames is free of the names it moves into, a swap or a
 * chain included; then each renamed one is renamed from its aside name to the target's. A renamed field is renamed in
 * place, through its own aside name, on its relation under the target's name, and PostgreSQL carries the rename into
 * everything built over the column, so the previous snapshot names it under its new name there too (withColumns). A
 * law column, named by what it holds, its relations, fields, handles and laws among them, is renamed in place the same
 * way when a declaration only renames what it holds (lawColumnRenames). Then each key, index, statistics object and
 * identity sequence of a table a declaration touched is paired by definition with the target's, its columns read under
 * their new names, and renamed to the target's name for it (pairedParts); the diff builds again only what the target
 * declares otherwise. A drawn or accumulated field's record of what fills it reads as the target's when a declaration
 * only renames its filler (restatedWritings). Law columns and fillers are restated under the previous snapshot's names
 * (previousNames), so the migration keeps their values and draws nothing again. A renamed handle keeps its code: the
 * codes were drafted under the rename (ir/codes.ts draftCodebook), so nothing more is drafted for it. A renamed login's
 * role is renamed in place the same way, through its aside name (loginRenamed).
 */
export const applyDeclarations = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	installation: Installation,
	declarations: Declarations,
	temporaries: TemporaryCensus
): Applied => {
	const loc = SourceLoc(`grizzle generate of schema ${target.schemaName}`, [])
	const refuse = (n: Named, rule: string): never => {
		throw new Refusal(unsupported(SourceLoc(loc.label, [spelled(n)]), rule))
	}
	const before = previous.theory.relations
	const after = target.theory.relations
	/** The relation renames, previous name to target name, each checked to rename one stored relation or roster. */
	const renamed = new Map<string, string>()
	for (const r of declarations.renames) {
		if (r.from.kind !== "relation" || r.to.kind !== "relation") {
			continue
		}
		const was = heldIn(before, r.from.relation)
		const now = heldIn(after, r.to.relation)
		if (was === undefined || now === undefined || was.kind !== now.kind) {
			return refuse(
				r.from,
				`a rename of ${r.from.relation} to ${r.to.relation}, which the previous snapshot and the target declare as stored relations, or rosters, of one kind`
			)
		}
		renamed.set(r.from.relation, r.to.relation)
	}
	/** The target name of a previous relation: its declared rename's, or its own. */
	const targetName = (relation: string): string => renamed.get(relation) ?? relation
	/** The names the relation renames take, as the tables and domains they are installed under. */
	const takenIdents = new Set(
		[...renamed.values()].flatMap((to) => {
			const now = heldIn(after, to)
			return now === undefined ? [] : [now.ident]
		})
	)
	/** Whether a previous relation's name is taken by a rename of another. */
	const taken = (name: string, r: SnapshotRelation): boolean =>
		!renamed.has(name) && takenIdents.has(r.ident)
	/** The field renames, by the previous relation's name, previous field to target field. */
	const fields = new Map<string, Map<string, string>>()
	/** The columns the field renames take, by the previous relation's name. */
	const takenColumns = new Map<string, Set<string>>()
	for (const r of declarations.renames) {
		const from = r.from
		const to = r.to
		if (from.kind !== "field" || to.kind !== "field") {
			continue
		}
		const was = heldIn(before, from.relation)
		const now = heldIn(after, to.relation)
		const into = now?.kind === "relation" ? now.fields.find((f) => f.name === to.field) : undefined
		if (
			was?.kind !== "relation" ||
			into === undefined ||
			!alike(targetName(from.relation), to.relation) ||
			!was.fields.some((f) => f.name === from.field)
		) {
			return refuse(
				from,
				`a rename of ${spelled(from)} to ${spelled(to)}, a field the previous snapshot declares renamed to one the target declares on that relation`
			)
		}
		const of = fields.get(from.relation) ?? new Map<string, string>()
		of.set(from.field, to.field)
		fields.set(from.relation, of)
		const columns = takenColumns.get(from.relation) ?? new Set<string>()
		columns.add(into.column)
		takenColumns.set(from.relation, columns)
	}
	/** Whether a previous field's column is taken by a rename of another field of its relation. */
	const fieldTaken = (
		relation: string,
		field: { readonly name: string; readonly column: string }
	) =>
		fields.get(relation)?.has(field.name) !== true &&
		takenColumns.get(relation)?.has(field.column) === true
	/** The handle renames, by the target's roster, each target handle to its previous name. */
	const handles = new Map<string, Map<string, string>>()
	/** The handles the renames take away from each previous roster. */
	const handlesAway = new Map<string, Set<string>>()
	for (const r of declarations.renames) {
		const from = r.from
		const to = r.to
		if (from.kind !== "handle" || to.kind !== "handle") {
			continue
		}
		const was = heldIn(before, from.roster)
		const now = heldIn(after, to.roster)
		if (
			was?.kind !== "closed" ||
			now?.kind !== "closed" ||
			!alike(targetName(from.roster), to.roster) ||
			!was.codes.some((c) => c.kind === "live" && c.handle === from.handle) ||
			!now.codes.some((c) => c.kind === "live" && c.handle === to.handle)
		) {
			return refuse(
				from,
				`a rename of ${spelled(from)} to ${spelled(to)}, a handle the previous snapshot's roster holds renamed to one the target's holds`
			)
		}
		const into = handles.get(to.roster) ?? new Map<string, string>()
		into.set(to.handle, from.handle)
		handles.set(to.roster, into)
		const away = handlesAway.get(from.roster) ?? new Set<string>()
		away.add(from.handle)
		handlesAway.set(from.roster, away)
	}
	/** The login renames, by the previous login's record name, to the target's login. */
	const logins = new Map<string, HeldLogin>()
	for (const r of declarations.renames) {
		const from = r.from
		const to = r.to
		if (from.kind !== "login" || to.kind !== "login") {
			continue
		}
		const was = loginIn(previous.logins, from.login)
		const now = loginIn(target.logins, to.login)
		if (was === undefined || now === undefined) {
			return refuse(
				from,
				`a rename of ${spelled(from)} to ${spelled(to)}, a login the previous snapshot holds renamed to one the target declares`
			)
		}
		logins.set(was.name, now)
	}
	/** The roles the login renames take. */
	const takenRoles = new Set([...logins.values()].map((l) => l.login.role))
	/** Whether a previous login's role is taken by a rename of another. */
	const loginTaken = (held: HeldLogin): boolean =>
		!logins.has(held.name) && takenRoles.has(held.login.role)
	/** The first side of a rename that names what an earlier one's side of that kind names. */
	const repeated = (side: "from" | "to"): Named | undefined => {
		const seen = new Set<string>()
		for (const r of declarations.renames) {
			const key = keyOf(r[side])
			if (seen.has(key)) {
				return r[side]
			}
			seen.add(key)
		}
		return undefined
	}
	const twice = repeated("from")
	if (twice !== undefined) {
		return refuse(twice, `two renames of ${spelled(twice)}`)
	}
	const merged = repeated("to")
	if (merged !== undefined) {
		return refuse(merged, `two renames to ${spelled(merged)}`)
	}
	const dropped = (n: Named): boolean => declarations.drops.some((d) => sameNamed(d, n))
	const undeclared = (d: Dropped): never => {
		throw new Refusal(undeclaredDrop(SourceLoc(loc.label, [spelled(d)]), d))
	}
	for (const [name, was] of Object.entries(before)) {
		if (was.kind === "derived") {
			continue
		}
		const relation = declared(name)
		const now = heldAlike(after, targetName(name))
		if (now?.kind !== was.kind || taken(name, was)) {
			if (!dropped({ kind: "relation", relation })) {
				undeclared({ kind: "relation", relation })
			}
			continue
		}
		if (was.kind === "relation" && now.kind === "relation") {
			for (const f of was.fields) {
				const field = declared(f.name)
				const to = fields.get(name)?.get(f.name) ?? f.name
				if (
					!drawnAgain(f.writing) &&
					(!now.fields.some((x) => alike(x.name, to)) || fieldTaken(name, f)) &&
					!dropped({ kind: "field", relation, field })
				) {
					undeclared({ kind: "field", relation, field })
				}
			}
		}
		if (was.kind === "closed" && now.kind === "closed") {
			for (const [code, slot] of was.codes.entries()) {
				if (
					slot.kind === "live" &&
					now.codes[code]?.kind !== "live" &&
					!dropped({ kind: "handle", roster: relation, handle: slot.handle })
				) {
					undeclared({ kind: "handle", roster: relation, handle: slot.handle })
				}
			}
		}
	}
	for (const [name, login] of Object.entries(previous.logins)) {
		const held: HeldLogin = { name, login }
		const named: Named = { kind: "login", login: declared(name) }
		const kept =
			logins.has(name) || (loginIn(target.logins, named.login) !== undefined && !loginTaken(held))
		if (!kept && !dropped(named)) {
			undeclared(named)
		}
	}
	/** Whether a declared drop drops what it names: something the previous snapshot holds that the target, under the
	 * declared renames, no longer does, or whose name a rename of another takes. */
	const drops = (d: Named): boolean => {
		switch (d.kind) {
			case "relation": {
				const was = heldIn(before, d.relation)
				return (
					was !== undefined &&
					!renamed.has(d.relation) &&
					(heldAlike(after, d.relation)?.kind !== was.kind || taken(d.relation, was))
				)
			}
			case "field": {
				const was = heldIn(before, d.relation)
				const now = heldAlike(after, targetName(d.relation))
				const f = was?.kind === "relation" ? was.fields.find((x) => x.name === d.field) : undefined
				return (
					f !== undefined &&
					fields.get(d.relation)?.has(d.field) !== true &&
					(!(now?.kind === "relation" && now.fields.some((x) => alike(x.name, d.field))) ||
						fieldTaken(d.relation, f))
				)
			}
			case "handle": {
				const was = heldIn(before, d.roster)
				const now = heldAlike(after, targetName(d.roster))
				const code =
					was?.kind === "closed"
						? was.codes.findIndex((c) => c.kind === "live" && c.handle === d.handle)
						: -1
				return code >= 0 && (now?.kind !== "closed" || now.codes[code]?.kind !== "live")
			}
			case "login": {
				const was = loginIn(previous.logins, d.login)
				return (
					was !== undefined &&
					!logins.has(was.name) &&
					(loginIn(target.logins, d.login) === undefined || loginTaken(was))
				)
			}
		}
	}
	for (const d of declarations.drops) {
		if (!drops(d)) {
			return refuse(
				d,
				`a drop of ${spelled(d)}, which the previous snapshot holds and the target no longer declares`
			)
		}
	}
	const relations = renamedSnapshot(previous, target, renamed, fields, temporaries)
	const names = previousNames(before, after, renamed, fields, handles, handlesAway)
	const columns = lawColumnRenames(relations.previous, installation, names, temporaries)
	/** The tables a declaration touched: each renamed relation's, each one whose fields are renamed, and each whose law
	 * columns move. */
	const touched = new Map(
		[
			...[...renamed.values()].flatMap((to) => {
				const now = heldIn(after, to)
				return now?.kind === "relation" ? [now.ident] : []
			}),
			...[...fields.keys()].flatMap((r) => {
				const now = heldAlike(after, targetName(r))
				return now?.kind === "relation" ? [now.ident] : []
			}),
			...columns.tables
		].map((name) => {
			const table: ObjectName = { schema: previous.schema, name }
			return [nameKey(table), table] as const
		})
	)
	/** And each table holding a foreign key into one of those, whose definition reads its relation's new name. */
	const referring = columns.previous.manifest.objects.flatMap((o) => {
		const v = installed(o)
		return v.kind === "foreignKey" && touched.has(nameKey(v.constraint.references))
			? [[nameKey(v.table), v.table] as const]
			: []
	})
	const parts = pairedParts(
		columns.previous,
		target,
		[...new Map([...touched, ...referring]).values()],
		new Set(relations.asides),
		temporaries
	)
	const writings = restatedWritings(parts.previous, target, installation, names)
	const roles = loginRenamed(writings, target, logins, temporaries)
	return {
		statements: [
			...relations.statements,
			...columns.statements,
			...parts.statements,
			...roles.statements
		],
		previous: roles.previous
	}
}

/**
 * How the previous snapshot names each relation, field and handle of the target under the checked declarations
 * (laws/model/restate.ts PreviousNames): a relation or roster renamed by its old name; else by its own name, or
 * the alike spelling the previous snapshot holds it under, unless a rename took that name away; and a relation the
 * snapshots record no record of, a closed relation, which no declaration renames, by its own. A field the same way on
 * its relation's previous record; and a handle by its declared rename's old name, or its own where the previous roster
 * holds it live and no rename took it away. Anything else is new to the migration.
 */
const previousNames = (
	before: Readonly<Record<string, SnapshotRelation>>,
	after: Readonly<Record<string, SnapshotRelation>>,
	renamed: ReadonlyMap<string, string>,
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
	handles: ReadonlyMap<string, ReadonlyMap<string, string>>,
	handlesAway: ReadonlyMap<string, ReadonlySet<string>>
): PreviousNames => {
	const renamedFrom = new Map([...renamed].map(([from, to]) => [to, from] as const))
	const held = Object.keys(before)
	/** The first of `own` and the names alike it among `among` that `holds`. */
	const spelling = (
		own: string,
		among: ReadonlyArray<string>,
		holds: (name: string) => boolean
	): string | undefined => [own, ...among.filter((n) => n !== own && alike(n, own))].find(holds)
	const relation = (t: string): string | undefined =>
		renamedFrom.get(t) ??
		(after[t] === undefined
			? t
			: spelling(t, held, (p) => before[p] !== undefined && !renamed.has(p)))
	const field = (t: string, f: string): string | undefined => {
		const p = relation(t)
		const was = p === undefined ? undefined : before[p]
		if (p === undefined || was === undefined) {
			return after[t] === undefined ? f : undefined
		}
		if (was.kind !== "relation") {
			return f
		}
		const renames = fields.get(p)
		const from = [...(renames ?? [])].find(([, to]) => to === f)
		if (from !== undefined) {
			return from[0]
		}
		const names = was.fields.map((x) => x.name)
		return spelling(f, names, (x) => names.includes(x) && renames?.has(x) !== true)
	}
	const handle = (roster: string, h: string): string | undefined => {
		const from = handles.get(roster)?.get(h)
		if (from !== undefined) {
			return from
		}
		const p = relation(roster)
		const was = p === undefined ? undefined : before[p]
		return p !== undefined &&
			was?.kind === "closed" &&
			was.codes.some((c) => c.kind === "live" && c.handle === h) &&
			handlesAway.get(p)?.has(h) !== true
			? h
			: undefined
	}
	return { relation, field, handle, handleRenames: new Set(handles.keys()) }
}

/** Whether a field is grizzle's to write, drawn or accumulated, by its filler (snapshot/types.ts SnapshotWriting). */
const drawnBy = (w: SnapshotWriting): boolean =>
	typeof w === "object" && ("drawn" in w || "accumulated" in w)

/**
 * The previous snapshot with each drawn or accumulated field whose filler a declaration only renames recorded as the
 * target records it. A field's record digests what fills it (snapshot/types.ts SnapshotWriting), its laws among them,
 * and a renamed relation, field or handle renames them, so the target's record of a field whose filler is the
 * previous one's is another digest. Its filler restated under the previous snapshot's names (snapshot/build.ts
 * fieldWriting under laws/model/restate.ts PreviousSpelling) is exactly the previous record then, and the field
 * keeps its column and its values; any other record stands, and the diff draws the field again (diff.ts redrawn). A
 * field is matched by its table and its column, as the diff reads the records.
 */
const restatedWritings = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	installation: Installation,
	names: PreviousNames
): DeploySnapshot => {
	const fillers = fillersOf(installation.laws.theory)
	const targets = new Map(
		Object.entries(target.theory.relations).flatMap(([name, r]) =>
			r.kind === "relation" ? [[r.ident, { name, r }] as const] : []
		)
	)
	const relations = Object.fromEntries(
		Object.entries(previous.theory.relations).map(
			([name, r]): readonly [string, SnapshotRelation] => {
				const now = r.kind === "relation" ? targets.get(r.ident) : undefined
				const theory = now === undefined ? undefined : installation.laws.theory.relations[now.name]
				if (r.kind !== "relation" || now === undefined || theory === undefined) {
					return [name, r]
				}
				const fields = r.fields.map((f) => {
					const into = now.r.fields.find((x) => x.column === f.column)
					const field =
						into === undefined ? undefined : theory.fields.find((x) => x.name === into.name)
					if (into === undefined || field === undefined || !drawnBy(into.writing)) {
						return f
					}
					const spell = new PreviousSpelling(names, installation.laws.theory.relations)
					const restated = fieldWriting(installation, fillers, now.name, field, spell)
					return spell.complete && same(restated, f.writing) ? { ...f, writing: into.writing } : f
				})
				return [name, { ...r, fields }]
			}
		)
	)
	return { ...previous, theory: { ...previous.theory, relations } }
}

/** A law column of a target table, and its previous name (restatedLawColumn), none where it is new. */
interface TargetLawColumn {
	readonly column: string
	readonly was: string | undefined
}

/**
 * The law columns the previous snapshot holds carried to the target's under the declarations, and the previous snapshot
 * as it stands after.
 *
 * A law column is named by what it holds (core/identity.ts LawColumnStatement), its relations, fields, handles and
 * laws among them, so a declaration that renames any of them renames the column. The target's column whose statement,
 * restated under the previous snapshot's names (laws/model/restate.ts restatedLawColumn), names a column the previous
 * snapshot holds on its table holds exactly that column's values: the migration renames that column to the target's
 * name, with ALTER TABLE ... RENAME COLUMN, so it neither drops nor draws it again and rewrites no row. A previous
 * column that holds a target column's name but is not that column under the declarations (its name is reused for
 * something else) is first renamed aside, and the diff drops it there. Every column goes through its aside name
 * (identity.aside), so a swap or a chain of renames meets no name another holds. The previous snapshot then names each
 * column as the database holds it once the renames ran, in its object's identity and statements, wherever a definition
 * names it (withColumns), and in every edge.
 */
const lawColumnRenames = (
	previous: DeploySnapshot,
	installation: Installation,
	names: PreviousNames,
	temporaries: TemporaryCensus
): {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly previous: DeploySnapshot
	readonly tables: ReadonlyArray<string>
} => {
	const schema = previous.schema
	const laws = new Map(installation.laws.theory.laws.map((l) => [l.id, l] as const))
	const held = new Map<string, Set<string>>()
	for (const o of previous.manifest.objects) {
		const v = installed(o)
		if (v.kind === "lawColumn") {
			const key = nameKey(v.table)
			held.set(key, (held.get(key) ?? new Set<string>()).add(v.column))
		}
	}
	const targets = new Map<
		string,
		{ readonly table: ObjectName; readonly columns: Array<TargetLawColumn> }
	>()
	for (const n of installation.laws.natives) {
		if (n.namespace !== "column") {
			continue
		}
		const table: ObjectName = { schema, name: n.owner }
		const key = nameKey(table)
		const of = targets.get(key) ?? { table, columns: [] }
		of.columns.push({
			column: n.object.column,
			was: restatedLawColumn(n.plan, laws, names, installation.laws.theory.relations)
		})
		targets.set(key, of)
	}
	const statements: Array<SqlStatement> = []
	const tableColumns = new Map<string, ReadonlyMap<string, string>>()
	for (const [key, { table, columns }] of targets) {
		const holds = held.get(key) ?? new Set<string>()
		const moves = columns.flatMap((c) =>
			c.was !== undefined && c.was !== c.column && holds.has(c.was)
				? [{ from: c.was, to: c.column, aside: asideName(temporaries, c.was) }]
				: []
		)
		const standing = new Set([
			...columns.flatMap((c) => (c.was === c.column ? [c.column] : [])),
			...moves.map((m) => m.from)
		])
		const taken = new Set(columns.map((c) => c.column))
		const holders = [...holds].flatMap((h) =>
			taken.has(h) && !standing.has(h) ? [{ column: h, aside: asideName(temporaries, h) }] : []
		)
		if (moves.length === 0 && holders.length === 0) {
			continue
		}
		for (const h of holders) {
			statements.push({ kind: "renameColumn", table, from: h.column, to: h.aside })
		}
		for (const m of moves) {
			statements.push({ kind: "renameColumn", table, from: m.from, to: m.aside })
		}
		for (const m of moves) {
			statements.push({ kind: "renameColumn", table, from: m.aside, to: m.to })
		}
		tableColumns.set(
			key,
			new Map([
				...moves.map((m) => [m.from, m.to] as const),
				...holders.map((h) => [h.column, h.aside] as const)
			])
		)
	}
	const tables = [...tableColumns.keys()].flatMap((key) => {
		const table = targets.get(key)?.table
		return table === undefined ? [] : [table.name]
	})
	if (tableColumns.size === 0) {
		return { statements, previous, tables }
	}
	const renamedOn = (table: ObjectName): ReadonlyMap<string, string> | undefined =>
		tableColumns.get(nameKey(table))
	const ident = (id: string): string => {
		const parsed = parseIdent(id)
		if (parsed.kind !== "column" || parsed.schema !== schema) {
			return id
		}
		const to = tableColumns.get(nameKey({ schema, name: parsed.relation }))?.get(parsed.name)
		return to === undefined ? id : innerIdent("column", schema, parsed.relation, to)
	}
	return {
		statements,
		tables,
		previous: {
			...previous,
			manifest: {
				...previous.manifest,
				objects: previous.manifest.objects.map((o): ManifestObject => ({
					...o,
					ident: ident(o.ident),
					ddl: o.ddl.map((statement) => withColumns(statement, renamedOn))
				})),
				edges: previous.manifest.edges.map((e) => ({ from: ident(e.from), to: ident(e.to) }))
			}
		}
	}
}

/** The object of a relation record in a manifest: its table's or its roster domain's. */
const holderOf = (
	snapshot: { readonly manifest: { readonly objects: ReadonlyArray<ManifestObject> } },
	schema: string,
	r: Held
): ObjectName => {
	const name: ObjectName = { schema, name: r.ident }
	const found = snapshot.manifest.objects.some((o) => {
		const v = installed(o)
		return (
			(v.kind === "table" && nameKey(v.create.table) === nameKey(name)) ||
			(v.kind === "domain" && nameKey(v.create.name) === nameKey(name))
		)
	})
	if (!found) {
		throw defect(`the manifest installs ${r.ident}, a relation its theory records`)
	}
	return name
}

/** The previous snapshot under the checked renames, and their statements. */
const renamedSnapshot = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	renamed: ReadonlyMap<string, string>,
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
	temporaries: TemporaryCensus
): Applied & { readonly asides: ReadonlyArray<string> } => {
	const schema = previous.schema
	const before = previous.theory.relations
	const after = target.theory.relations
	/** Each renamed relation, and each dropped one whose name a rename takes, renamed aside whole. */
	const takenNames = new Set([...renamed.values()].map((to) => heldIn(after, to)?.ident))
	const movers = Object.entries(before).flatMap(
		([name, r]): ReadonlyArray<readonly [string, Held]> => {
			const held = heldIn(before, name)
			return held !== undefined &&
				(renamed.has(name) || (takenNames.has(r.ident) && !renamed.has(name)))
				? [[name, held]]
				: []
		}
	)
	const moving = movers.map(([name, r]) => {
		const holder = holderOf(previous, schema, r)
		const first: Aside =
			r.kind === "relation"
				? relationAside(previous, "table", holder, { kind: "declared" }, temporaries)
				: {
						kind: "domain",
						name: holder,
						cause: { kind: "declared" },
						to: asideName(temporaries, holder.name)
					}
		return { name, r, first }
	})
	const firstAsides = moving.map((m) => m.first)
	const aside = setAside(previous, firstAsides)
	/** Each renamed relation from its aside name to the target's, its parts left aside for pairedParts. */
	const secondAsides = moving.flatMap(({ name, r, first }): ReadonlyArray<Aside> => {
		const to = renamed.get(name)
		if (to === undefined) {
			return []
		}
		const now = heldIn(after, to)
		if (now === undefined) {
			throw defect(`the target holds ${to}, which applyDeclarations checked each rename to name`)
		}
		const from: ObjectName = { schema, name: first.to }
		if (r.kind === "closed" || first.kind === "domain") {
			return [{ kind: "domain", name: from, cause: { kind: "declared" }, to: now.ident }]
		}
		return [{ kind: "table", name: from, cause: { kind: "declared" }, to: now.ident, owned: [] }]
	})
	const moved = setAside(aside, secondAsides)
	const columns = columnRenames(moved, after, renamed, fields, temporaries)
	/** Each relation's record under its target name: a renamed one's under the target's, with its identifier; one whose
	 * name a rename takes none, since it ends here; any other's under its own. */
	const recordOf = (name: string, r: SnapshotRelation): SnapshotRelation =>
		columns.previous.theory.relations[name] ?? r
	const theory = {
		...columns.previous.theory,
		relations: Object.fromEntries([
			...Object.entries(before).flatMap(
				([name, r]): ReadonlyArray<readonly [string, SnapshotRelation]> =>
					renamed.has(name) || takenNames.has(r.ident) ? [] : [[name, recordOf(name, r)]]
			),
			...Object.entries(before).flatMap(
				([name, r]): ReadonlyArray<readonly [string, SnapshotRelation]> => {
					const to = renamed.get(name)
					const now = to === undefined ? undefined : heldIn(after, to)
					return to === undefined || now === undefined
						? []
						: [[to, { ...recordOf(name, r), ident: now.ident }]]
				}
			)
		])
	}
	return {
		statements: [
			...firstAsides.flatMap((a) => asideStatements(a)),
			...secondAsides.flatMap((a) => asideStatements(a)),
			...columns.statements
		],
		previous: { ...columns.previous, theory },
		asides: firstAsides.flatMap((a) => (a.kind === "domain" ? [] : a.owned.map((o) => o.to)))
	}
}

/** A part of a relation a draft pairs by definition, by its kind as aside.ts Owned names it, and the name it takes. */
interface Paired {
	readonly kind: Owned["kind"]
	readonly name: string
	readonly to: string
}

/** The parts of `was` paired with those of `now` of the same definition (`same`), each with the name `now` gives it:
 * one of its own name first, so a part both name alike stays as it is, then any other, each taken once. */
const pairBy = <P extends { readonly name: string }>(
	kind: (p: P) => Owned["kind"],
	was: ReadonlyMap<string, P>,
	now: ReadonlyMap<string, P>,
	matches: (a: P, b: P) => boolean
): ReadonlyArray<Paired> => {
	const pool = new Map(now)
	const pairs: Array<Paired> = []
	const unpaired: Array<P> = []
	for (const p of was.values()) {
		const own = pool.get(p.name)
		if (own !== undefined && matches(p, own)) {
			pool.delete(p.name)
			pairs.push({ kind: kind(p), name: p.name, to: p.name })
		} else {
			unpaired.push(p)
		}
	}
	for (const p of unpaired) {
		const found = [...pool.values()].find((t) => matches(p, t))
		if (found !== undefined) {
			pool.delete(found.name)
			pairs.push({ kind: kind(p), name: p.name, to: found.name })
		}
	}
	return pairs
}

/** The names a part holds, each in the namespace PostgreSQL holds it in: a key its constraint's name in its relation's
 * own namespace and its index's in pg_class; another constraint its name in its relation's namespace alone; an index
 * and a sequence theirs in pg_class; a statistics object its own among the statistics objects. */
const heldNames = (kind: Owned["kind"], name: string): ReadonlyArray<string> => {
	switch (kind) {
		case "key":
			return [`constraint ${name}`, `relation ${name}`]
		case "constraint":
			return [`constraint ${name}`]
		case "index":
		case "sequence":
			return [`relation ${name}`]
		case "statistics":
			return [`statistics ${name}`]
	}
}

/** A key: a constraint with an index of its own, which takes its name. */
const isKey = (c: TableConstraint): boolean =>
	c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude"

/**
 * The parts of each table `tables` carried to the names the target gives them, and the previous snapshot as it stands
 * after: each constraint, a key's renaming its index, each other index, each extended statistics object and each
 * identity sequence, paired with the target's part of the same definition once every declared rename of the relations,
 * the fields and the law columns has run, so each definition reads its columns and the relations it references under
 * their new names (pairBy). A paired part the target names otherwise is renamed, so the migration neither builds nor
 * validates it again. A previous part holding a name a paired part takes, itself paired with none, is renamed aside
 * first, and the diff drops it there; every renamed part goes through its aside name, so a swap or a chain of names
 * meets none another holds, but one a relation's rename already set aside (`aside`), which goes straight to its name. A
 * part paired with none is the diff's to drop and build. The previous snapshot then names each part as the database
 * holds it (aside.ts withNames).
 */
const pairedParts = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	tables: ReadonlyArray<ObjectName>,
	aside: ReadonlySet<string>,
	temporaries: TemporaryCensus
): { readonly statements: ReadonlyArray<SqlStatement>; readonly previous: DeploySnapshot } => {
	const wasIdent = new Map(previous.manifest.objects.map((o) => [o.ident, o]))
	const nowIdent = new Map(target.manifest.objects.map((o) => [o.ident, o]))
	const constraintKind = (c: PartOf<"constraint">): Owned["kind"] =>
		isKey(c.constraint) ? "key" : "constraint"
	const outward: Array<{ readonly table: ObjectName; readonly owned: ReadonlyArray<Owned> }> = []
	const back: Array<{ readonly table: ObjectName; readonly owned: ReadonlyArray<Owned> }> = []
	const relations = new Map<string, string>()
	const statistics = new Map<string, string>()
	const keys = new Map<string, ReadonlyMap<string, string>>()
	const wasParts = partsByTable(previous.manifest.objects, wasIdent)
	const nowParts = partsByTable(target.manifest.objects, nowIdent)
	for (const table of tables) {
		const was = partsAt(wasParts, table)
		const now = partsAt(nowParts, table)
		const pairs = [
			...pairBy(constraintKind, was.constraint, now.constraint, (a, b) =>
				same({ ...a.constraint, name: "" }, { ...b.constraint, name: "" })
			),
			...pairBy(
				() => "index",
				was.index,
				now.index,
				(a, b) => same({ ...a.create, name: "" }, { ...b.create, name: "" })
			),
			...pairBy(
				() => "statistics",
				was.statistics,
				now.statistics,
				(a, b) =>
					same(
						{ ...a.create, name: { ...a.create.name, name: "" } },
						{ ...b.create, name: { ...b.create.name, name: "" } }
					)
			),
			...pairBy(
				() => "sequence",
				was.sequence,
				now.sequence,
				(a, b) => a.column === b.column
			)
		]
		const moves = pairs.filter((p) => p.name !== p.to)
		const paired = new Set(pairs.flatMap((p) => heldNames(p.kind, p.name)))
		const taken = new Set(moves.flatMap((m) => heldNames(m.kind, m.to)))
		const standing: ReadonlyArray<Paired> = [
			...[...was.constraint.values()].map((c) => ({
				kind: constraintKind(c),
				name: c.name,
				to: c.name
			})),
			...[...was.index.keys()].map((name) => ({ kind: "index" as const, name, to: name })),
			...[...was.sequence.keys()].map((name) => ({ kind: "sequence" as const, name, to: name })),
			...[...was.statistics.keys()].map((name) => ({ kind: "statistics" as const, name, to: name }))
		]
		const holders = standing.filter((h) => {
			const names = heldNames(h.kind, h.name)
			return names.some((n) => taken.has(n)) && !names.some((n) => paired.has(n))
		})
		if (moves.length === 0 && holders.length === 0) {
			continue
		}
		const vacate = (p: Paired): Owned => ({
			kind: p.kind,
			name: p.name,
			to: asideName(temporaries, p.name)
		})
		const direct = moves.filter((m) => aside.has(m.name))
		const through = moves
			.filter((m) => !aside.has(m.name))
			.map((m) => ({ first: vacate(m), to: m.to }))
		const vacated = holders.map(vacate)
		outward.push({ table, owned: [...vacated, ...through.map((m) => m.first)] })
		back.push({
			table,
			owned: [
				...direct,
				...through.map(({ first, to }) => ({ kind: first.kind, name: first.to, to }))
			]
		})
		const final: ReadonlyArray<Owned> = [...moves, ...vacated]
		for (const p of final) {
			if (p.kind === "statistics") {
				statistics.set(p.name, p.to)
			} else if (p.kind !== "constraint") {
				relations.set(p.name, p.to)
			}
		}
		keys.set(
			table.name,
			new Map(
				final.flatMap((p) =>
					p.kind === "key" || p.kind === "constraint" ? [[p.name, p.to] as const] : []
				)
			)
		)
	}
	if (outward.length === 0) {
		return { statements: [], previous }
	}
	return {
		statements: [
			...outward.flatMap((a) => partRenames(a.table, a.owned)),
			...back.flatMap((a) => partRenames(a.table, a.owned))
		],
		previous: withNames(previous, { relations, types: new Map(), statistics, keys })
	}
}

/** The declared field renames carried out on each relation under its target name, through each column's aside name so
 * no order of them meets a name another holds, and the previous snapshot with each renamed column under its target
 * name, as the database holds it once the renames ran: in its relation's record, and wherever the snapshot's
 * definitions name it as PostgreSQL carries a column's rename (withColumns), its table's definition among them. */
const columnRenames = (
	previous: DeploySnapshot,
	after: Readonly<Record<string, SnapshotRelation>>,
	renamed: ReadonlyMap<string, string>,
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
	temporaries: TemporaryCensus
): { readonly statements: ReadonlyArray<SqlStatement>; readonly previous: DeploySnapshot } => {
	const schema = previous.schema
	const statements: Array<SqlStatement> = []
	/** Each table's renamed columns, by its name key, and each renamed fields' relation's record after the renames. */
	const tableColumns = new Map<string, ReadonlyMap<string, string>>()
	const records = new Map<string, SnapshotRelation>()
	for (const [relation, renames] of fields) {
		const was = heldIn(previous.theory.relations, relation)
		const now = heldAlike(after, renamed.get(relation) ?? relation)
		if (was?.kind !== "relation" || now?.kind !== "relation") {
			continue
		}
		const table: ObjectName = { schema, name: now.ident }
		const columnOf = (r: Held & { readonly kind: "relation" }, field: string): ColumnIdent => {
			const f = r.fields.find((x) => x.name === field)
			if (f === undefined) {
				throw defect(`the relation's record holds the field ${field} a rename names`)
			}
			return f.column
		}
		const moves = [...renames].map(([from, to]) => {
			const column = columnOf(was, from)
			return { from, to, column, aside: asideName(temporaries, column), into: columnOf(now, to) }
		})
		/** A field the migration drops whose column name a renamed field takes, set aside first, then dropped under its
		 * aside name; its record ends here. */
		const taken = new Set<string>(moves.map((m) => m.into))
		const holders = was.fields.flatMap((f) =>
			renames.has(f.name) || !taken.has(f.column)
				? []
				: [{ field: f.name, column: f.column, aside: asideName(temporaries, f.column) }]
		)
		const ending = new Set(holders.map((h) => h.field))
		for (const h of holders) {
			statements.push({ kind: "renameColumn", table, from: h.column, to: h.aside })
		}
		for (const m of moves) {
			statements.push({ kind: "renameColumn", table, from: m.column, to: m.aside })
		}
		for (const m of moves) {
			statements.push({ kind: "renameColumn", table, from: m.aside, to: m.into })
		}
		const into = new Map<string, string>([
			...moves.map((m) => [m.column, m.into] as const),
			...holders.map((h) => [h.column, h.aside] as const)
		])
		const fieldInto = new Map(moves.map((m) => [m.from, m] as const))
		tableColumns.set(nameKey(table), into)
		records.set(relation, {
			...was,
			fields: was.fields.flatMap((f) => {
				if (ending.has(f.name)) {
					return []
				}
				const m = fieldInto.get(f.name)
				return [m === undefined ? f : { ...f, name: m.to, column: m.into }]
			})
		})
	}
	const renamedOn = (table: ObjectName): ReadonlyMap<string, string> | undefined =>
		tableColumns.get(nameKey(table))
	const snapshot: DeploySnapshot = {
		...previous,
		manifest: {
			...previous.manifest,
			objects:
				tableColumns.size === 0
					? previous.manifest.objects
					: previous.manifest.objects.map((o): ManifestObject => ({
							...o,
							ddl: o.ddl.map((statement) => withColumns(statement, renamedOn))
						}))
		},
		theory: {
			...previous.theory,
			relations: Object.fromEntries(
				Object.entries(previous.theory.relations).map(
					([name, r]) => [name, records.get(name) ?? r] as const
				)
			)
		}
	}
	return { statements, previous: snapshot }
}

/**
 * `s` with each column of a table `renamed` maps under its new name, wherever PostgreSQL's RENAME COLUMN carries the
 * rename, which it does by the column's attribute number into everything built over it: a table's columns and what its
 * CREATE TABLE declares over them (its keys, its CHECKs, a generated column's expression), a constraint or a column an
 * ALTER TABLE adds to it, a foreign key's columns on it and its referenced columns there, an index's keys, INCLUDE
 * columns and predicate, an extended statistics object's columns, and a column privilege's grant. A column an
 * expression names without a relation is its table's, as every expression over one table's row names it. A
 * statement of any other kind names no column of a table it is built over; the roles' views, policies and functions,
 * and the materialized views, which read columns through a relation of their FROM, the diff builds again whenever
 * they read a column a migration changes.
 */
const withColumns = (
	s: SqlStatement,
	renamed: (table: ObjectName) => ReadonlyMap<string, string> | undefined
): SqlStatement => {
	const nameIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(column: string): string =>
			into?.get(column) ?? column
	const exprIn = (into: ReadonlyMap<string, string> | undefined, e: Expr): Expr =>
		into === undefined
			? e
			: transformExpr(e, {
					...identityHooks,
					expr: (x) =>
						x.kind === "column" && x.table === undefined
							? { ...x, column: nameIn(into)(x.column) }
							: x
				})
	const keyIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(k: KeyColumn): KeyColumn => ({ ...k, column: nameIn(into)(k.column) })
	const referenceIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(k: ForeignKeyColumn): ForeignKeyColumn => ({ ...k, column: nameIn(into)(k.column) })
	const columnIn = (into: ReadonlyMap<string, string> | undefined, c: ColumnDef): ColumnDef => {
		const generated = c.generated
		return {
			...c,
			name: nameIn(into)(c.name),
			generated:
				generated === undefined || generated.kind === "identity" || generated.kind === "uuidv7"
					? generated
					: generated.kind === "stored"
						? { kind: "stored", expr: exprIn(into, generated.expr) }
						: {
								kind: "partial",
								when: exprIn(into, generated.when),
								expr: exprIn(into, generated.expr)
							}
		}
	}
	const inlineIn = (
		into: ReadonlyMap<string, string> | undefined,
		c: InlineConstraint
	): InlineConstraint => {
		switch (c.kind) {
			case "unique":
				return { ...c, columns: mapNonEmpty(c.columns, keyIn(into)) }
			case "exclude":
				return {
					...c,
					elements: mapNonEmpty(c.elements, (e) => ({ ...e, column: nameIn(into)(e.column) }))
				}
			case "check":
				return { ...c, predicate: exprIn(into, c.predicate) }
		}
	}
	const constraintIn = (table: ObjectName, c: TableConstraint): TableConstraint => {
		const into = renamed(table)
		switch (c.kind) {
			case "primaryKey":
				return { ...c, columns: mapNonEmpty(c.columns, keyIn(into)) }
			case "foreignKey":
				return {
					...c,
					columns: mapNonEmpty(c.columns, referenceIn(into)),
					referencedColumns: mapNonEmpty(c.referencedColumns, referenceIn(renamed(c.references)))
				}
			case "unique":
			case "exclude":
			case "check":
				return inlineIn(into, c)
		}
	}
	const actionIn = (table: ObjectName, a: AlterTableAction): AlterTableAction => {
		const into = renamed(table)
		switch (a.kind) {
			case "addConstraint":
				return { ...a, constraint: constraintIn(table, a.constraint) }
			case "addColumn":
			case "addColumnPlaceholder":
				return { ...a, column: columnIn(into, a.column) }
			case "addColumnDefault":
				return { ...a, column: columnIn(into, a.column), default: exprIn(into, a.default) }
			case "setExpression":
				return { ...a, column: nameIn(into)(a.column), expr: exprIn(into, a.expr) }
			case "alterColumnType":
				return {
					...a,
					column: nameIn(into)(a.column),
					using:
						a.using.kind === "expr" ? { kind: "expr", expr: exprIn(into, a.using.expr) } : a.using
				}
			case "dropColumn":
			case "dropDefault":
			case "addIdentity":
			case "dropIdentity":
				return { ...a, column: nameIn(into)(a.column) }
			case "addConstraintUsingIndex":
			case "validateConstraint":
			case "dropConstraint":
			case "enableRowSecurity":
			case "disableRowSecurity":
				return a
		}
	}
	switch (s.kind) {
		case "createTable": {
			const into = renamed(s.table)
			return into === undefined
				? s
				: {
						...s,
						columns: mapNonEmpty(s.columns, (c) => columnIn(into, c)),
						primaryKey: {
							...s.primaryKey,
							columns: mapNonEmpty(s.primaryKey.columns, keyIn(into))
						},
						secondary: s.secondary.map((c) => inlineIn(into, c))
					}
		}
		case "alterTable":
			return { ...s, actions: mapNonEmpty(s.actions, (a) => actionIn(s.table, a)) }
		case "createIndex": {
			const into = renamed(s.table)
			return into === undefined
				? s
				: {
						...s,
						keys: mapNonEmpty(s.keys, (k) => ({
							...k,
							key:
								k.key.kind === "column"
									? { kind: "column", column: nameIn(into)(k.key.column) }
									: { kind: "expr", expr: exprIn(into, k.key.expr) }
						})),
						include: s.include.map(nameIn(into)),
						where: s.where === undefined ? undefined : exprIn(into, s.where)
					}
		}
		case "createStatistics": {
			const into = renamed(s.table)
			if (into === undefined) {
				return s
			}
			const [first, second, ...rest] = s.columns
			return {
				...s,
				columns: [nameIn(into)(first), nameIn(into)(second), ...rest.map(nameIn(into))]
			}
		}
		case "grantColumns": {
			const into = renamed(s.table)
			return into === undefined ? s : { ...s, columns: mapNonEmpty(s.columns, nameIn(into)) }
		}
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createSchema":
		case "createRole":
		case "alterRole":
		case "grantRole":
		case "revokeRole":
		case "grant":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createPolicy":
		case "rename":
		case "drop":
		case "comment":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "dropIndex":
		case "createMaterializedView":
		case "createView":
		case "dropPolicy":
		case "dropFunction":
		case "dropTrigger":
		case "createFunction":
		case "packConstant":
		case "createConstant":
		case "createGuardTrigger":
		case "alterDatabaseDefault":
		case "createExtension":
		case "lockTable":
		case "createCarrier":
		case "begin":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
		case "analyze":
			return s
		case "createConstraintTrigger": {
			const into = renamed(s.table)
			return {
				...s,
				events: mapNonEmpty(s.events, (e) =>
					e.kind === "update" ? { ...e, columns: mapNonEmpty(e.columns, nameIn(into)) } : e
				)
			}
		}
	}
}

/** `s` with every role name it holds that `roles` maps renamed: a role's own statements, the grants to it and of it,
 * a policy's role, a schema's owner and a comment on a role. A statement of any other kind names no role. */
const withRoles = (s: SqlStatement, roles: ReadonlyMap<string, string>): SqlStatement => {
	const role = (name: string): string => roles.get(name) ?? name
	const grantee = (g: Grantee): Grantee =>
		g.kind === "role" ? { kind: "role", name: role(g.name) } : g
	switch (s.kind) {
		case "createRole":
		case "alterRole":
			return { ...s, name: role(s.name) }
		case "grantRole":
			return { ...s, role: role(s.role), to: role(s.to) }
		case "revokeRole":
			return { ...s, role: role(s.role), from: role(s.from) }
		case "grant":
			return { ...s, to: mapNonEmpty(s.to, grantee) }
		case "revoke":
			return { ...s, from: mapNonEmpty(s.from, grantee) }
		case "grantColumns":
			return { ...s, to: role(s.to) }
		case "alterDefaultPrivileges":
			return {
				...s,
				forRole: s.forRole === undefined ? undefined : role(s.forRole),
				from: mapNonEmpty(s.from, grantee)
			}
		case "createPolicy":
			return { ...s, role: role(s.role) }
		case "createSchema":
			return {
				...s,
				authorization: s.authorization === undefined ? undefined : role(s.authorization)
			}
		case "rename":
			return s.object === "ROLE" ? { ...s, name: role(s.name), to: role(s.to) } : s
		case "drop":
			return s.object === "ROLE" ? { ...s, name: role(s.name) } : s
		case "comment":
			return s.on.kind === "ROLE" ? { ...s, on: { kind: "ROLE", name: role(s.on.name) } } : s
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createTable":
		case "alterTable":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "createIndex":
		case "dropIndex":
		case "createMaterializedView":
		case "createView":
		case "dropPolicy":
		case "dropFunction":
		case "dropTrigger":
		case "createFunction":
		case "packConstant":
		case "createConstant":
		case "createGuardTrigger":
		case "createConstraintTrigger":
		case "alterDatabaseDefault":
		case "createExtension":
		case "createStatistics":
		case "lockTable":
		case "createCarrier":
		case "begin":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
		case "analyze":
			return s
	}
}

/**
 * The declared login renames carried out, and the previous snapshot under them.
 *
 * Each renamed login's role, and each role of the previous snapshot whose name a renamed login's role takes (a login
 * dropped, as declared, or a role the target no longer holds), is first renamed aside (identity.aside), so any order of
 * renames, a swap or a chain included, is free of the names it moves into; then each renamed login's role is renamed
 * from its aside name to the target's. ALTER ROLE ... RENAME TO keeps the role's OID, and PostgreSQL holds a role's
 * password, its memberships, the privileges granted to it and its comment by OID, so all of them stay with it. The
 * cluster's password encryption is SCRAM, whose verifier does not depend on the role's name, as MD5's did.
 *
 * The previous snapshot then names each renamed login's role under the target's name, and each set-aside role under its
 * aside name: in every object's identity and statements, every edge, the role defaults, the PUBLIC revokes and the
 * comments. Its logins and its workload record each renamed login under the target's name, and no longer record a
 * login whose role a rename takes. So the diff reads a renamed login as one that stands, and a set-aside role as one
 * the target no longer holds, which it drops at the end of the migration under its aside name.
 */
const loginRenamed = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	logins: ReadonlyMap<string, HeldLogin>,
	temporaries: TemporaryCensus
): { readonly statements: ReadonlyArray<SqlStatement>; readonly previous: DeploySnapshot } => {
	if (logins.size === 0) {
		return { statements: [], previous }
	}
	const moves = [...logins].map(([name, to]) => {
		const was = previous.logins[name]
		if (was === undefined || target.logins[to.name] === undefined) {
			throw defect(`the renamed login ${name} is recorded by both snapshots`)
		}
		return { from: name, to: to.name, role: was.role, into: to.login.role }
	})
	const renamedRoles = new Set(moves.map((m) => m.role))
	const takenRoles = new Set(moves.map((m) => m.into))
	const holders = previous.manifest.objects.flatMap((o) => {
		if (o.kind !== "role") {
			return []
		}
		const v = installed(o)
		return v.kind === "role" && takenRoles.has(v.create.name) && !renamedRoles.has(v.create.name)
			? [v.create.name]
			: []
	})
	const asides = new Map(
		[...moves.map((m) => m.role), ...holders].map(
			(role) => [role, asideName(temporaries, role)] as const
		)
	)
	const asideOf = (role: string): string => {
		const to = asides.get(role)
		if (to === undefined) {
			throw defect(`the role ${role} is set aside`)
		}
		return to
	}
	const statements: ReadonlyArray<SqlStatement> = [
		...[...asides].map(([role, to]): SqlStatement => ({
			kind: "rename",
			object: "ROLE",
			name: role,
			to
		})),
		...moves.map((m): SqlStatement => ({
			kind: "rename",
			object: "ROLE",
			name: asideOf(m.role),
			to: m.into
		}))
	]
	const roles = new Map<string, string>([
		...holders.map((h) => [h, asideOf(h)] as const),
		...moves.map((m) => [m.role, m.into] as const)
	])
	const ident = (id: string): string => {
		const parsed = parseIdent(id)
		if (parsed.kind !== "role" && parsed.kind !== "privileges" && parsed.kind !== "membership") {
			return id
		}
		const to = roles.get(parsed.name)
		return to === undefined ? id : namedIdent(parsed.kind, to)
	}
	const renamedIn = (list: ReadonlyArray<SqlStatement>): ReadonlyArray<SqlStatement> =>
		list.map((s) => withRoles(s, roles))
	const loginTo = new Map(moves.map((m) => [m.from, m] as const))
	/** A record by login name, each renamed login's under the target's name, one whose role a rename takes left out. */
	const byLogin = <V>(
		record: Readonly<Record<string, V>>,
		moved: (v: V, into: string) => V
	): Readonly<Record<string, V>> =>
		Object.fromEntries(
			Object.entries(record).flatMap(([name, v]): ReadonlyArray<readonly [string, V]> => {
				const m = loginTo.get(name)
				if (m !== undefined) {
					return [[m.to, moved(v, m.into)]]
				}
				const held = previous.logins[name]
				return held !== undefined && takenRoles.has(held.role) ? [] : [[name, v]]
			})
		)
	return {
		statements,
		previous: {
			...previous,
			manifest: {
				...previous.manifest,
				objects: previous.manifest.objects.map((o): ManifestObject => ({
					...o,
					ident: ident(o.ident),
					ddl: renamedIn(o.ddl)
				})),
				edges: previous.manifest.edges.map((e) => ({ from: ident(e.from), to: ident(e.to) })),
				roleDefaults: renamedIn(previous.manifest.roleDefaults),
				publicRevokes: renamedIn(previous.manifest.publicRevokes),
				comments: renamedIn(previous.manifest.comments)
			},
			logins: byLogin(previous.logins, (_, role) => ({ role })),
			workload: byLogin(previous.workload, (programs) => programs)
		}
	}
}

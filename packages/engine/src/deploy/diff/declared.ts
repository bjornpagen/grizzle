import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { carriedOn, spelledAxis } from "#compiler/analysis/theory/families.ts"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import { canonicalEquals, Refusal } from "#compiler/core/canonical.ts"
import {
	type Misdeclaration,
	misdeclared,
	type Named,
	namedSpelling,
	undeclaredDrop
} from "#compiler/core/errors.ts"
import {
	conversionOf,
	type DeclaredName,
	declaredAlike,
	identifierOf,
	identity,
	parseDeclaredName,
	type TemporaryCensus
} from "#compiler/core/identity.ts"
import type { ColumnIdent, Identifier, LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type Aside,
	asideName,
	roleAsideName,
	asideStatements,
	type AsidePart,
	partRenames,
	relationAside,
	setAside,
	withNames
} from "#compiler/deploy/diff/aside.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { drawnWriting, fieldWriting } from "#compiler/deploy/snapshot/build.ts"
import {
	type AnyObject,
	installed,
	type PartOf,
	partsAt,
	partsByTable
} from "#compiler/deploy/snapshot/objects.ts"
import {
	type RecordedObject,
	type RecordedStatement,
	recordedObject,
	transformRecorded,
	type WholeStatement
} from "#compiler/deploy/snapshot/recorded.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotLogin,
	SnapshotRelation,
	SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import { rosterCodec } from "#compiler/ir/codes.ts"
import type { SideDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { type CarriedFiller, type FillSpelling, fillersOf } from "#compiler/laws/model/fillers.ts"
import type { LawColumnPlan } from "#compiler/laws/model/plan.ts"
import {
	type PreviousNames,
	restatedBy,
	restatedLaw,
	restatedLawColumn,
	type RestatingSpelling
} from "#compiler/laws/model/restate.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { rowFunctionIdentity } from "#compiler/physical/ddl/row-functions.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import { innerIdent, namedIdent, parseIdent } from "#compiler/physical/obligations/graph.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import {
	type AlterTableAction,
	type ColumnDef,
	type Expr,
	type ForeignKeyColumn,
	type Grantee,
	type InlineConstraint,
	type KeyColumn,
	type ObjectName,
	type SqlStatement,
	type TableConstraint,
	nameKey,
	type NameKey
} from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	ownColumnHooks,
	Transform,
	transformExpr,
	transformStatement
} from "#compiler/sql/transform.ts"

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

/** The key a name is told apart by: its kind and its spelling, a login's name by its conversion, which names its role
 * (core/identity.ts declaredAlike). */
const keyOf = (n: Named): string =>
	n.kind === "login" ? `login ${conversionOf(n.login)}` : `${n.kind} ${namedSpelling(n)}`

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

/** Names a snapshot records, grouped by their conversion (core/identity.ts declaredAlike), each group in the order the
 * names were given: every name is parsed and converted once, as the groups are built, so the names alike a name are
 * one lookup by its conversion. */
class AlikeNames {
	readonly #names: ReadonlySet<string>
	readonly #groups = new Map<string, Array<string>>()

	constructor(names: ReadonlyArray<string>) {
		this.#names = new Set(names)
		for (const name of names) {
			const conversion = conversionOf(declared(name))
			this.#groups.getOrInsertComputed(conversion, () => []).push(name)
		}
	}

	/** Whether `name` is one of these. */
	has(name: string): boolean {
		return this.#names.has(name)
	}

	/** The first of `own` and the names alike it among these, in their order, that `holds`. */
	first(own: string, holds: (name: string) => boolean): string | undefined {
		const alikeOwn = this.#groups.get(conversionOf(own)) ?? []
		return [own, ...alikeOwn.filter((n) => n !== own)].find(holds)
	}
}

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
 * accumulated field. A caller's field holds the caller's values, and an instant the database's clock at each row's
 * write. */
const drawnAgain = (writing: SnapshotWriting): boolean =>
	writing !== "caller" && writing !== "instant"

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
 * or to one name, each Misdeclared, naming what it misses (core/errors.ts Misdeclaration), and of every drop no
 * declaration names (UndeclaredDrop), each stored state the previous snapshot holds
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
 * way when a declaration only renames what it holds (lawColumnRenames). Then each key, index and statistics object of a
 * table a declaration touched is paired by definition with the target's, its columns read under
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
	/** The refusal of a declaration naming `n`, for `m`. */
	const refuse = (n: Named, m: Misdeclaration): never => {
		throw new Refusal(misdeclared(SourceLoc(loc.label, [namedSpelling(n)]), m))
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
		if (was === undefined) {
			return refuse(r.from, { kind: "renameUnheld", from: r.from, to: r.to })
		}
		if (now === undefined) {
			return refuse(r.from, { kind: "renameUndeclared", from: r.from, to: r.to })
		}
		if (was.kind !== now.kind) {
			return refuse(r.from, { kind: "renameAcross", from: r.from, to: r.to })
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
		if (was?.kind !== "relation" || !was.fields.some((f) => f.name === from.field)) {
			return refuse(from, { kind: "renameUnheld", from, to })
		}
		if (into === undefined) {
			return refuse(from, { kind: "renameUndeclared", from, to })
		}
		if (!alike(targetName(from.relation), to.relation)) {
			return refuse(from, { kind: "renameAcross", from, to })
		}
		const of = fields.getOrInsertComputed(from.relation, () => new Map<string, string>())
		of.set(from.field, to.field)
		const columns = takenColumns.getOrInsertComputed(from.relation, () => new Set<string>())
		columns.add(into.column)
	}
	/** Whether a previous field's column is taken by a rename of another field of its relation. */
	const fieldTaken = (
		relation: string,
		field: { readonly name: string; readonly column: string }
	) =>
		fields.get(relation)?.has(field.name) !== true &&
		takenColumns.get(relation)?.has(field.column) === true
	/** Whether a previous field, neither renamed nor taken, is one the target declares again on its relation, under its
	 * name, as a field grizzle draws or accumulates: a declared drop of it drops its stored values, and the target's is
	 * new to the migration, drawn anew over the stored rows. */
	const drawnAnew = (
		relation: string,
		field: { readonly name: string; readonly column: string }
	): boolean => {
		const now = heldAlike(after, targetName(relation))
		const again =
			now?.kind === "relation" ? now.fields.find((x) => alike(x.name, field.name)) : undefined
		return (
			again !== undefined &&
			drawnBy(again.writing) &&
			fields.get(relation)?.has(field.name) !== true &&
			!fieldTaken(relation, field)
		)
	}
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
			!was.codes.some((c) => c.kind === "live" && c.handle === from.handle)
		) {
			return refuse(from, { kind: "renameUnheld", from, to })
		}
		if (
			now?.kind !== "closed" ||
			!now.codes.some((c) => c.kind === "live" && c.handle === to.handle)
		) {
			return refuse(from, { kind: "renameUndeclared", from, to })
		}
		if (!alike(targetName(from.roster), to.roster)) {
			return refuse(from, { kind: "renameAcross", from, to })
		}
		const into = handles.getOrInsertComputed(to.roster, () => new Map<string, string>())
		into.set(to.handle, from.handle)
		const away = handlesAway.getOrInsertComputed(from.roster, () => new Set<string>())
		away.add(from.handle)
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
		if (was === undefined) {
			return refuse(from, { kind: "renameUnheld", from, to })
		}
		if (now === undefined) {
			return refuse(from, { kind: "renameUndeclared", from, to })
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
		return refuse(twice, { kind: "renamedTwice", from: twice })
	}
	const merged = repeated("to")
	if (merged !== undefined) {
		return refuse(merged, { kind: "renamedOnto", to: merged })
	}
	const dropped = (n: Named): boolean => declarations.drops.some((d) => sameNamed(d, n))
	const undeclared = (d: Named): never => {
		throw new Refusal(undeclaredDrop(SourceLoc(loc.label, [namedSpelling(d)]), d))
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
	/**
	 * What is wrong with a declared drop: the previous snapshot does not hold what it names (`dropUnheld`), a handle live;
	 * or the target, under the declared renames, still does, and no rename of another takes its name (`dropKept`). None
	 * for a drop that drops what it names.
	 */
	const misdropped = (d: Named): "dropUnheld" | "dropKept" | undefined => {
		switch (d.kind) {
			case "relation": {
				const was = heldIn(before, d.relation)
				if (was === undefined) {
					return "dropUnheld"
				}
				return !renamed.has(d.relation) &&
					(heldAlike(after, d.relation)?.kind !== was.kind || taken(d.relation, was))
					? undefined
					: "dropKept"
			}
			case "field": {
				const was = heldIn(before, d.relation)
				const now = heldAlike(after, targetName(d.relation))
				const f = was?.kind === "relation" ? was.fields.find((x) => x.name === d.field) : undefined
				if (f === undefined) {
					return "dropUnheld"
				}
				return fields.get(d.relation)?.has(d.field) !== true &&
					(!(now?.kind === "relation" && now.fields.some((x) => alike(x.name, d.field))) ||
						fieldTaken(d.relation, f) ||
						drawnAnew(d.relation, f))
					? undefined
					: "dropKept"
			}
			case "handle": {
				const was = heldIn(before, d.roster)
				const now = heldAlike(after, targetName(d.roster))
				const code =
					was?.kind === "closed"
						? was.codes.findIndex((c) => c.kind === "live" && c.handle === d.handle)
						: -1
				if (code < 0) {
					return "dropUnheld"
				}
				return now?.kind !== "closed" || now.codes[code]?.kind !== "live" ? undefined : "dropKept"
			}
			case "login": {
				const was = loginIn(previous.logins, d.login)
				if (was === undefined) {
					return "dropUnheld"
				}
				return !logins.has(was.name) &&
					(loginIn(target.logins, d.login) === undefined || loginTaken(was))
					? undefined
					: "dropKept"
			}
		}
	}
	for (const d of declarations.drops) {
		const fault = misdropped(d)
		if (fault !== undefined) {
			return refuse(d, { kind: fault, dropped: d })
		}
	}
	/** The fields each declared drop drops while the target declares them again, drawn anew (drawnAnew), by the
	 * previous relation's name. */
	const anew = new Map<string, Set<string>>()
	for (const d of declarations.drops) {
		if (d.kind !== "field") {
			continue
		}
		const was = heldIn(before, d.relation)
		const f = was?.kind === "relation" ? was.fields.find((x) => x.name === d.field) : undefined
		if (f !== undefined && drawnAnew(d.relation, f)) {
			anew.getOrInsertComputed(d.relation, () => new Set<string>()).add(d.field)
		}
	}
	const relations = renamedSnapshot(previous, target, renamed, fields, anew, temporaries)
	const names = previousNames(previous, after, renamed, fields, anew, handles, handlesAway)
	const law = lawColumnRenames(relations.previous, installation, names, temporaries)
	const constants = pairedConstants(
		law.previous,
		installation,
		[...renamed].flatMap(([from, to]) =>
			before[from]?.kind === "closed" ? [{ from: declared(from), to: declared(to) }] : []
		)
	)
	const columns = { ...law, previous: constants.previous }
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
			})
		]
			.map((name): ObjectName => ({ schema: previous.schema, name }))
			.concat(columns.tables)
			.map((table) => [nameKey(table), table] as const)
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
	const roles = loginRenamed(
		restatedLaws(writings, installation, names),
		target,
		logins,
		temporaries
	)
	return {
		statements: [
			...relations.statements,
			...columns.statements,
			...constants.statements,
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
 * holds it live and no rename took it away. Anything else is new to the migration. The laws it states are its theory's.
 */
const previousNames = (
	previous: DeploySnapshot,
	after: Readonly<Record<string, SnapshotRelation>>,
	renamed: ReadonlyMap<string, string>,
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
	anew: ReadonlyMap<string, ReadonlySet<string>>,
	handles: ReadonlyMap<string, ReadonlyMap<string, string>>,
	handlesAway: ReadonlyMap<string, ReadonlySet<string>>
): PreviousNames => {
	const before = previous.theory.relations
	const renamedFrom = new Map([...renamed].map(([from, to]) => [to, from] as const))
	const held = new AlikeNames(Object.keys(before))
	/** The fields of each stored relation the previous snapshot holds, by the relation's name. */
	const heldFields = new Map(
		Object.entries(before).flatMap(([p, r]) =>
			r.kind === "relation" ? [[p, new AlikeNames(r.fields.map((x) => x.name))] as const] : []
		)
	)
	const relation = (t: string): string | undefined =>
		renamedFrom.get(t) ??
		(after[t] === undefined ? t : held.first(t, (p) => before[p] !== undefined && !renamed.has(p)))
	const field = (t: string, f: string): string | undefined => {
		const p = relation(t)
		const was = p === undefined ? undefined : before[p]
		if (p === undefined || was === undefined) {
			return after[t] === undefined ? f : undefined
		}
		const names = heldFields.get(p)
		if (names === undefined) {
			return f
		}
		const renames = fields.get(p)
		const from = [...(renames ?? [])].find(([, to]) => to === f)
		if (from !== undefined) {
			return from[0]
		}
		return names.first(
			f,
			(x) => names.has(x) && renames?.has(x) !== true && anew.get(p)?.has(x) !== true
		)
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
	const laws = new Set<string>(Object.keys(previous.theory.laws))
	return {
		relation,
		field,
		handle,
		handleRenames: new Set(handles.keys()),
		stated: (law) => laws.has(law)
	}
}

/** Whether a field is grizzle's to write, drawn or accumulated, by its filler (snapshot/types.ts SnapshotWriting). */
const drawnBy = (w: SnapshotWriting): boolean =>
	typeof w === "object" && ("drawn" in w || "accumulated" in w)

/**
 * The place the target draws `field` of `relation` in as a sequence's own order: an ordered family's or a tree's index,
 * or a tree's start or end, its member's pre-order interval; none for any other field.
 */
const sequencePlaceOf = (
	installation: Installation,
	relation: string,
	field: string
): { readonly family: Family; readonly role: "index" | "start" | "end" } | undefined => {
	for (const f of installation.laws.theory.families) {
		if (f.member.name !== relation) {
			continue
		}
		if (f.shape.index.kind === "field" && f.shape.index.field.name === field) {
			return { family: f, role: "index" }
		}
		if (f.shape.kind === "tree" && f.shape.start.name === field) {
			return { family: f, role: "start" }
		}
		if (f.shape.kind === "tree" && f.shape.end.name === field) {
			return { family: f, role: "end" }
		}
	}
	return undefined
}

/**
 * Whether `was`, the previous snapshot's record of a field the target draws as the index of an ordered family or a
 * tree, or as a tree's start or end, records that place in a family over the same sequence: a law the previous snapshot
 * states of the target family's kind (its shape, "family" or "tree"), whose record of that place is `was` and whose
 * count record is the one the previous snapshot holds on the target family's owner's table and count's column, as the
 * declarations left them. The member's field is the field `was` is recorded on, so the family orders the same members
 * of the same owners: only its group, by which each member names its owner, may differ, and a tree's root and parent
 * among it. An index holds each member's place in its owner's sequence, which its caller wrote, and a tree's interval
 * its rows' pre-order under that order, so each is kept, never drawn again; the family's laws, validated after the
 * migration's data steps, prove the kept places a sequence of each owner under the new group, and the kept intervals
 * each new tree's pre-order (a tree's parent drawn anew is drawn from them, deploy/diff/backfill.ts parentUpdate).
 */
const sameSequence = (
	previous: DeploySnapshot,
	installation: Installation,
	relation: string,
	field: string,
	was: SnapshotWriting
): boolean => {
	const place = sequencePlaceOf(installation, relation, field)
	if (place === undefined) {
		return false
	}
	const { family, role } = place
	const owner = Object.values(previous.theory.relations).find(
		(r) => r.kind === "relation" && r.ident === family.owner.ident
	)
	const counted =
		owner?.kind === "relation"
			? owner.fields.find((f) => f.column === family.count.column)
			: undefined
	const shape = family.shape.kind === "tree" ? "tree" : "family"
	return (
		counted !== undefined &&
		Object.entries(previous.theory.laws).some(
			([law, stated]) =>
				stated.shape === shape &&
				canonicalEquals(was, drawnWriting({ role: { kind: role }, laws: [law] })) &&
				canonicalEquals(counted.writing, drawnWriting({ role: { kind: "count" }, laws: [law] }))
		)
	)
}

/** A side of a law the previous snapshot records, as the riding rule reads it: its relation and its predicates. */
const ridingSide = (
	side: SideDesc
): { readonly relation: string; readonly predicates: SideDesc["selection"]["conjuncts"] } => ({
	relation: side.relation,
	predicates: side.selection.conjuncts
})

/**
 * What fills a field as the previous snapshot names it (FillSpelling): each law and literal as `spell` restates it
 * (laws/model/restate.ts PreviousSpelling), and a copy's carriers as the laws the previous snapshot records (`laws`, its
 * levels' described laws) that ride its family's axis, restated, and carry its pair, restated, read off their
 * descriptions by the riding rule (analysis/theory/families.ts carriedOn), in identifier order. A copy is its pair's: its
 * carriers' other pairs, a sibling copy added to or taken from one, leave what fills it as it was, so the migration
 * keeps its column and its values, and only what reads the whole pair set, the axis's foreign key and the UNIQUE it
 * references, is replaced. A pair no law the previous snapshot records carries is new to the migration: the spelling
 * is then incomplete, as it is for a name new to it.
 */
class PreviousFill implements FillSpelling {
	readonly #spell: RestatingSpelling
	readonly #laws: ReadonlyArray<DescribedLaw>
	#complete = true

	constructor(spell: RestatingSpelling, laws: ReadonlyArray<DescribedLaw>) {
		this.#spell = spell
		this.#laws = laws
	}

	/** Whether every name, selection and carried pair the spelling was asked for has a previous spelling. */
	get complete(): boolean {
		return this.#complete && this.#spell.complete
	}

	readonly law = (law: TheoryLaw): Identifier<"law"> => this.#spell.law(law)

	readonly literal = (value: TypedLiteral, at: LawField): TypedLiteral =>
		this.#spell.literal(value, at)

	readonly carriers = (copy: CarriedFiller): NonEmptyReadonlyArray<LawId> => {
		const axis = spelledAxis(copy.family, copy.role.axis, this.#spell)
		const from = this.#spell.field(copy.source, copy.from.name)
		const to = this.#spell.field(copy.target, copy.to.name)
		const carriers =
			axis === undefined
				? []
				: this.#laws
						.flatMap(({ law, described }) => {
							if (described.kind !== "contained") {
								return []
							}
							const pairs = described.from.terms.flatMap((t, j) => {
								const target = described.to.terms[j]
								return target === undefined ? [] : [{ from: t, to: target }]
							})
							const carried = carriedOn(
								axis,
								ridingSide(described.from),
								ridingSide(described.to),
								pairs
							)
							return carried?.some((p) => p.from.field === from && p.to.field === to) === true
								? [law]
								: []
						})
						.toSorted(compareStrings)
		if (!isNonEmpty(carriers)) {
			this.#complete = false
			return mapNonEmpty(copy.carriers, (law) => law.id)
		}
		return carriers
	}
}

/**
 * The previous snapshot with each drawn or accumulated field whose filler a declaration only renames recorded as the
 * target records it, and each index whose family orders the same sequence (sameSequence) too. A field's record digests
 * what fills it (snapshot/types.ts SnapshotWriting), its laws among them, and a renamed relation, field or handle
 * renames them, so the target's record of a field whose filler is the previous one's is another digest. Its filler
 * restated under the previous snapshot's names (snapshot/build.ts fieldWriting under laws/model/restate.ts
 * PreviousSpelling) is exactly the previous record then, and the field keeps its column and its values; any other
 * record stands, and the diff draws the field again (diff.ts redrawn). A field is matched by its table and its column,
 * as the diff reads the records.
 */
const restatedWritings = (
	previous: DeploySnapshot,
	target: SnapshotContent,
	installation: Installation,
	names: PreviousNames
): DeploySnapshot => {
	const fillers = fillersOf(installation.laws.theory)
	const laws = previous.levels.flatMap((l) => l.laws)
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
					const restated = restatedBy(names, installation.laws.theory.relations, (spell) => {
						const fill = new PreviousFill(spell, laws)
						const writing = fieldWriting(fillers, now.name, field, fill)
						return fill.complete ? writing : undefined
					})
					return (restated !== undefined && canonicalEquals(restated, f.writing)) ||
						sameSequence(previous, installation, now.name, field.name, f.writing)
						? { ...f, writing: into.writing }
						: f
				})
				return [name, { ...r, fields }]
			}
		)
	)
	return { ...previous, theory: { ...previous.theory, relations } }
}

/**
 * The previous snapshot with the record of each law the target states under the target's identifier: a law whose
 * statement, restated under the previous snapshot's names (laws/model/restate.ts restatedLaw), is one the previous
 * snapshot states is that very law, though a declaration renamed what it reads, so the diff reads the previous installation's record of it, by which it held the law
 * (diff.ts heldBefore, migrationChecks), and checks it again only where its check's identity moved. A record no target
 * law restates to stands under its own identifier but where a target law holds that identifier, whose record it is not.
 */
const restatedLaws = (
	previous: DeploySnapshot,
	installation: Installation,
	names: PreviousNames
): DeploySnapshot => {
	const recorded = previous.theory.laws
	const theory = installation.laws.theory
	const restated = theory.laws.flatMap((law) => {
		const was = restatedLaw(law, names, theory.relations)
		const record = was === undefined ? undefined : recorded[was]
		return was === undefined || record === undefined ? [] : [{ law: law.id, was, record }]
	})
	const taken = new Set<string>([...restated.map((r) => r.was), ...theory.laws.map((l) => l.id)])
	const laws = Object.fromEntries([
		...Object.entries(recorded).filter(([id]) => !taken.has(id)),
		...restated.map((r) => [r.law, r.record] as const)
	])
	return { ...previous, theory: { ...previous.theory, laws } }
}

/** Each table's law columns in `objects`, a manifest's, by name, with their definitions. */
const lawColumnDefinitions = (
	objects: ReadonlyArray<AnyObject>
): ReadonlyMap<NameKey, ReadonlyMap<string, ColumnDef>> => {
	const out = new Map<NameKey, Map<string, ColumnDef>>()
	for (const o of objects) {
		const v = installed(o)
		if (v.kind === "lawColumn") {
			const key = nameKey(v.table)
			out.getOrInsertComputed(key, () => new Map<string, ColumnDef>()).set(v.column, v.definition)
		}
	}
	return out
}

/**
 * The constants the previous snapshot holds that the target holds under another name, each found by what it is: a
 * renamed roster's names and live-codes constants restated under the roster's previous name (physical/ddl/constants.ts
 * rosterConstants), and a row function restated under the previous snapshot's names, each type of a renamed roster
 * named as before and each constant it calls by the name it was found as (physical/ddl/row-functions.ts
 * rowFunctionIdentity). A constant is named by its content, so a restated name the previous snapshot holds is the same
 * content, which the declarations only renamed; any other is another function, which the diff creates beside the
 * previous one and re-points what calls it at, as before.
 *
 * The migration renames each one found, `ALTER FUNCTION … RENAME TO`, which keeps its OID, so every CHECK that calls it
 * and every domain whose CHECK reads it stands, neither added again nor validated; and writes a row function's text
 * again in place, CREATE OR REPLACE under the same signature, where its text names a renamed type, since PostgreSQL
 * carries no rename into a function's source. Only a constant found by its content takes this path. The previous
 * snapshot then holds each under the target's name, its object the target's, every call of it in its statements and
 * every edge naming it renamed.
 */
const pairedConstants = (
	previous: DeploySnapshot,
	installation: Installation,
	rosters: ReadonlyArray<{ readonly from: DeclaredName; readonly to: DeclaredName }>
): { readonly statements: ReadonlyArray<SqlStatement>; readonly previous: DeploySnapshot } => {
	if (!isNonEmpty(rosters)) {
		return { statements: [], previous }
	}
	const held = new Map(
		previous.manifest.objects.flatMap((o) => {
			const v = installed(o)
			return v.kind === "constant" ? [[v.create.name.name, o] as const] : []
		})
	)
	const targets = installation.manifest.objects.flatMap((o) =>
		o.ddl.flatMap((st) =>
			st.kind === "createConstant" && !held.has(st.name.name) ? [{ object: o, create: st }] : []
		)
	)
	/** Each renamed roster's types, its domain's and its sets', by the target's name key, under their previous names. */
	const types = new Map<NameKey, string>(
		rosters.flatMap(({ from, to }): ReadonlyArray<readonly [NameKey, string]> => {
			const codec = installation.names.codes.rosters.get(to)
			if (codec === undefined) {
				return []
			}
			const domain = installation.names.rosterDomain(to)
			const bits = installation.names.bitsDomain(to)
			return [
				[
					nameKey({ schema: domain.schema, name: identifierOf(identity.rosterDomain(to)) }),
					identifierOf(identity.rosterDomain(from))
				] as const,
				[
					nameKey({
						schema: bits.schema,
						name: identifierOf(identity.bitsDomain(to, codec.width))
					}),
					identifierOf(identity.bitsDomain(from, codec.width))
				] as const
			]
		})
	)
	/** Each constant found, by the target's identifier: the previous identifier it was found as. */
	const found = new Map<string, string>()
	for (const { from, to } of rosters) {
		const codec = installation.names.codes.rosters.get(to)
		if (codec === undefined) {
			continue
		}
		const now = rosterConstants(codec)
		const was = rosterConstants({ ...codec, roster: from })
		for (const [n, w] of [
			[now.names, was.names],
			[now.live, was.live]
		] as const) {
			const target = identifierOf(n)
			const prior = identifierOf(w)
			if (
				target !== prior &&
				held.has(prior) &&
				targets.some((t) => t.create.name.name === target)
			) {
				found.set(target, prior)
			}
		}
	}
	/** Whether a held constant is already the previous one of a target constant found. */
	const renamedFrom = (name: string): boolean => [...found.values()].includes(name)
	const languages = new Map(
		[...installation.names.spellings.table].map(([language, spelling]) => [
			matchAre(spelling),
			language
		])
	)
	const scope = {
		installed: installation.names.installed,
		languageOf: (are: string) => languages.get(are)
	}
	const restate = new Transform({
		...identityHooks,
		typeRef: (t) => {
			const was = t.kind === "named" ? types.get(nameKey(t)) : undefined
			return was === undefined || t.kind !== "named" ? t : { ...t, name: was }
		},
		functionRef: (fn) => {
			const was = found.get(fn.name)
			return was === undefined ? fn : { ...fn, name: was }
		}
	})
	/** Whether a definition names a renamed roster's type, which its text then holds under the target's name. */
	const namesARenamedType = (
		create: Extract<SqlStatement, { readonly kind: "createConstant" }>
	) => {
		let names = false
		new Transform({
			...identityHooks,
			typeRef: (t) => {
				names = names || (t.kind === "named" && types.has(nameKey(t)))
				return t
			}
		}).statement(create)
		return names
	}
	/** The row functions the previous snapshot holds that the target does not, by name: each a candidate for a target row
	 * function the declarations only renamed. */
	const heldRows = [...held].flatMap(([name, o]) => {
		const v = installed(o)
		return v.kind === "constant" &&
			v.create.language === "plpgsql" &&
			!targets.some((t) => t.create.name.name === name)
			? [name]
			: []
	})
	const replaced: Array<SqlStatement> = []
	for (const { create } of targets) {
		if (create.language !== "plpgsql" || found.has(create.name.name)) {
			continue
		}
		const restated = identifierOf(
			rowFunctionIdentity(scope, {
				params: create.params.map((p) => restate.functionParam(p)),
				returns: restate.type(create.returns),
				body: restate.expr(create.body)
			})
		)
		const prior = heldRows.find((h) => h === restated && !renamedFrom(h))
		if (prior !== undefined) {
			found.set(create.name.name, prior)
			if (namesARenamedType(create)) {
				replaced.push({ kind: "replaceConstant", constant: create })
			}
		}
	}
	if (found.size === 0) {
		return { statements: [], previous }
	}
	const statements: Array<SqlStatement> = [
		...targets.flatMap(({ create }): ReadonlyArray<SqlStatement> => {
			const prior = found.get(create.name.name)
			return prior === undefined
				? []
				: [
						{
							kind: "rename",
							object: "FUNCTION",
							name: { schema: create.name.schema, name: prior },
							args: create.params.map((p) => p.type),
							to: create.name.name
						}
					]
		}),
		...replaced
	]
	const renamedTo = new Map([...found].map(([target, prior]) => [prior, target] as const))
	const objectOf = new Map(
		targets.flatMap(({ object, create }) =>
			found.has(create.name.name) ? [[create.name.name, recordedObject(object)] as const] : []
		)
	)
	const identOf = new Map(
		[...renamedTo].flatMap(([prior, target]) => {
			const was = held.get(prior)
			const now = objectOf.get(target)
			return was === undefined || now === undefined ? [] : [[was.ident, now.ident] as const]
		})
	)
	/** Every name of a function renamed, a call of it, a grant of EXECUTE on it, a revoke from PUBLIC and a comment on
	 * it alike, as PostgreSQL holds each of them by the function's OID. */
	const calls: AstHooks = {
		...identityHooks,
		functionRef: (fn) => {
			const to = renamedTo.get(fn.name)
			return to === undefined ? fn : { ...fn, name: to }
		},
		objectName: (name, namespace) => {
			const to = namespace === "function" ? renamedTo.get(name.name) : undefined
			return to === undefined ? name : { ...name, name: to }
		}
	}
	return {
		statements,
		previous: {
			...previous,
			manifest: {
				...previous.manifest,
				objects: previous.manifest.objects.map((o): RecordedObject => {
					const v = installed(o)
					const to = v.kind === "constant" ? renamedTo.get(v.create.name.name) : undefined
					const now = to === undefined ? undefined : objectOf.get(to)
					return now ?? { ...o, ddl: transformRecorded(o.ddl, calls) }
				}),
				edges: previous.manifest.edges.map((e) => ({
					from: identOf.get(e.from) ?? e.from,
					to: identOf.get(e.to) ?? e.to
				})),
				roleDefaults: previous.manifest.roleDefaults.map((st) => transformStatement(st, calls)),
				publicRevokes: previous.manifest.publicRevokes.map((st) => transformStatement(st, calls)),
				comments: previous.manifest.comments.map((st) => transformStatement(st, calls))
			}
		}
	}
}

/** A law column the installation plans on a table: its name and its plan. */
interface PlannedLawColumn {
	readonly column: string
	readonly plan: LawColumnPlan
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
 * A law column is named by what it holds (core/identity.ts LawColumnStatement), its relations, fields, handles and laws
 * among them, so a declaration that renames any of them, or a canonical text that states them otherwise, renames the
 * column. A target column the previous snapshot holds under its own name is that column. Any other holds exactly the
 * values of the previous column it is found as (heldAs): a column grizzle draws, the column its statement, restated
 * under the previous snapshot's names (laws/model/restate.ts restatedLawColumn), names; a column PostgreSQL generates,
 * the previous generated column of its table whose definition is its own once each column it reads is named by the
 * target column it was found as, whatever either is named. A table's columns PostgreSQL does not generate are found
 * before those it does, and a generation reads no generated column (PostgreSQL refuses one that does, 42P17), so every
 * law column a generation reads is found before it: a generated column over a law column a declaration renames, as a
 * family's predecessor reads its index, is found. The migration renames that column to the target's name, with ALTER
 * TABLE ... RENAME COLUMN, so it neither drops nor draws it again and rewrites no row. A previous column that holds a
 * target column's name but is not that column under the declarations (its name is reused for something else) is first
 * renamed aside, and the diff drops it there. Every column goes through its aside name (identity.aside), so a swap or a
 * chain of renames meets no name another holds. The previous snapshot then names each column as the database holds it
 * once the renames ran, in its object's identity and statements, wherever a definition names it (withColumns), and in
 * every edge.
 */
const lawColumnRenames = (
	previous: DeploySnapshot,
	installation: Installation,
	names: PreviousNames,
	temporaries: TemporaryCensus
): {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly previous: DeploySnapshot
	readonly tables: ReadonlyArray<ObjectName>
} => {
	const laws = new Map(installation.laws.theory.laws.map((l) => [l.id, l] as const))
	const held = lawColumnDefinitions(previous.manifest.objects)
	const defined = lawColumnDefinitions(installation.manifest.objects)
	const targets = new Map<
		NameKey,
		{
			readonly table: ObjectName
			readonly natives: Array<PlannedLawColumn>
		}
	>()
	for (const n of installation.laws.natives) {
		if (n.namespace !== "column") {
			continue
		}
		const table: ObjectName = {
			schema: identifierOf(installation.names.levelOf(n.object.relation.name)),
			name: n.owner
		}
		const key = nameKey(table)
		const of = targets.getOrInsertComputed(key, () => ({ table, natives: [] }))
		of.natives.push({ column: n.object.column, plan: n.plan })
	}
	const columnsOf = new Map(
		[...targets].map(([key, { table, natives }]) => {
			const holds = held.get(key) ?? new Map<string, ColumnDef>()
			const definitions = defined.get(key) ?? new Map<string, ColumnDef>()
			const taken = new Set(natives.map((n) => n.column))
			/** Each held column paired so far, by the target column it is: what a held generation reads it as. */
			const into = new Map<string, string>()
			const readThrough = (d: ColumnDef): ColumnDef =>
				new Transform(ownColumnHooks((c) => into.get(c) ?? c)).columnDef(d)
			const heldAs = ({ column, plan }: PlannedLawColumn): string | undefined => {
				if (holds.has(column)) {
					return column
				}
				const definition = definitions.get(column)
				if (definition === undefined) {
					throw defect(`the installation adds the law column ${column} it plans`)
				}
				if (definition.generated === undefined) {
					return restatedLawColumn(plan, laws, names, installation.laws.theory.relations)
				}
				return [...holds].find(
					([c, d]) =>
						!taken.has(c) &&
						!into.has(c) &&
						d.generated !== undefined &&
						canonicalEquals({ ...readThrough(d), name: "" }, { ...definition, name: "" })
				)?.[0]
			}
			const generates = (n: PlannedLawColumn): boolean =>
				definitions.get(n.column)?.generated !== undefined
			const was = new Map<string, string | undefined>()
			for (const native of [
				...natives.filter((n) => !generates(n)),
				...natives.filter(generates)
			]) {
				const found = heldAs(native)
				was.set(native.column, found)
				if (found !== undefined) {
					into.set(found, native.column)
				}
			}
			return [
				key,
				{
					table,
					columns: natives.map((n): TargetLawColumn => ({
						column: n.column,
						was: was.get(n.column)
					}))
				}
			] as const
		})
	)
	const statements: Array<SqlStatement> = []
	const tableColumns = new Map<NameKey, ReadonlyMap<string, string>>()
	for (const [key, { table, columns }] of columnsOf) {
		const holds = held.get(key) ?? new Map<string, ColumnDef>()
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
		const holders = [...holds.keys()].flatMap((h) =>
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
		const table = columnsOf.get(key)?.table
		return table === undefined ? [] : [table]
	})
	if (tableColumns.size === 0) {
		return { statements, previous, tables }
	}
	const renamedOn = (table: ObjectName): ReadonlyMap<string, string> | undefined =>
		tableColumns.get(nameKey(table))
	const ident = (id: string): string => {
		const parsed = parseIdent(id)
		if (parsed.kind !== "column") {
			return id
		}
		const to = tableColumns
			.get(nameKey({ schema: parsed.schema, name: parsed.relation }))
			?.get(parsed.name)
		return to === undefined ? id : innerIdent("column", parsed.schema, parsed.relation, to)
	}
	return {
		statements,
		tables,
		previous: {
			...previous,
			manifest: {
				...previous.manifest,
				objects: previous.manifest.objects.map((o): RecordedObject => ({
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
	snapshot: { readonly manifest: { readonly objects: ReadonlyArray<AnyObject> } },
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
	anew: ReadonlyMap<string, ReadonlySet<string>>,
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
	/** Each renamed roster's bits domain the previous installation holds, where the target's is of its width and no other
	 * domain holds its name: renamed with its roster, through its aside name, so no column typed by it is converted. */
	const domainsHeld = new Map(
		previous.manifest.objects.flatMap((o) => {
			const v = installed(o)
			return v.kind === "domain" ? [[v.create.name.name, v.create.name] as const] : []
		})
	)
	const bitsMoving = movers.flatMap(
		([name, r]): ReadonlyArray<{ readonly first: Aside; readonly to: string }> => {
			const to = renamed.get(name)
			const now = to === undefined ? undefined : heldIn(after, to)
			if (r.kind !== "closed" || to === undefined || now?.kind !== "closed") {
				return []
			}
			const width = rosterCodec(declared(name), r.codes).width
			const was = identifierOf(identity.bitsDomain(declared(name), width))
			const becomes = identifierOf(identity.bitsDomain(declared(to), width))
			const holder = domainsHeld.get(was)
			return holder === undefined ||
				was === becomes ||
				domainsHeld.has(becomes) ||
				rosterCodec(declared(to), now.codes).width !== width
				? []
				: [
						{
							first: {
								kind: "domain",
								name: holder,
								cause: { kind: "declared" },
								to: asideName(temporaries, holder.name)
							},
							to: becomes
						}
					]
		}
	)
	const firstAsides = [...moving.map((m) => m.first), ...bitsMoving.map((m) => m.first)]
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
	const bitsSecond = bitsMoving.map(({ first, to }): Aside => ({
		kind: "domain",
		name: { schema: first.name.schema, name: first.to },
		cause: { kind: "declared" },
		to
	}))
	const moved = setAside(aside, [...secondAsides, ...bitsSecond])
	const columns = columnRenames(moved, after, renamed, fields, anew, temporaries)
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
			...bitsSecond.flatMap((a) => asideStatements(a)),
			...columns.statements
		],
		previous: { ...columns.previous, theory },
		asides: firstAsides.flatMap((a) => (a.kind === "domain" ? [] : a.owned.map((o) => o.to)))
	}
}

/** A part of a relation a draft pairs by definition, by its kind as aside.ts AsidePart names it, and the name it takes. */
interface Paired {
	readonly kind: AsidePart["kind"]
	readonly name: string
	readonly to: string
}

/** The parts of `was` paired with those of `now` of the same definition (`canonicalEquals`), each with the name `now` gives it:
 * one of its own name first, so a part both name alike stays as it is, then any other, each taken once. */
const pairBy = <P extends { readonly name: string }>(
	kind: (p: P) => AsidePart["kind"],
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
 * its own in pg_class. */
const heldNames = (kind: AsidePart["kind"], name: string): ReadonlyArray<string> => {
	switch (kind) {
		case "key":
			return [`constraint ${name}`, `relation ${name}`]
		case "constraint":
			return [`constraint ${name}`]
		case "index":
			return [`relation ${name}`]
	}
}

/** A key: a constraint with an index of its own, which takes its name. */
const isKey = (c: TableConstraint): boolean =>
	c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude"

/**
 * The parts of each table `tables` carried to the names the target gives them, and the previous snapshot as it stands
 * after: each constraint, a key's renaming its index, and each other index, paired
 * with the target's part of the same definition once every declared rename of the relations,
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
	const constraintKind = (c: PartOf<"constraint">): AsidePart["kind"] =>
		isKey(c.constraint) ? "key" : "constraint"
	const outward: Array<{ readonly table: ObjectName; readonly owned: ReadonlyArray<AsidePart> }> =
		[]
	const back: Array<{ readonly table: ObjectName; readonly owned: ReadonlyArray<AsidePart> }> = []
	const relations = new Map<string, string>()
	const keys = new Map<string, ReadonlyMap<string, string>>()
	const wasParts = partsByTable(previous.manifest.objects, wasIdent)
	const nowParts = partsByTable(target.manifest.objects, nowIdent)
	for (const table of tables) {
		const was = partsAt(wasParts, table)
		const now = partsAt(nowParts, table)
		const pairs = [
			...pairBy(constraintKind, was.constraint, now.constraint, (a, b) =>
				canonicalEquals({ ...a.constraint, name: "" }, { ...b.constraint, name: "" })
			),
			...pairBy(
				() => "index",
				was.index,
				now.index,
				(a, b) => canonicalEquals({ ...a.create, name: "" }, { ...b.create, name: "" })
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
			...[...was.index.keys()].map((name) => ({ kind: "index" as const, name, to: name }))
		]
		const holders = standing.filter((h) => {
			const names = heldNames(h.kind, h.name)
			return names.some((n) => taken.has(n)) && !names.some((n) => paired.has(n))
		})
		if (moves.length === 0 && holders.length === 0) {
			continue
		}
		const vacate = (p: Paired): AsidePart => ({
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
		const final: ReadonlyArray<AsidePart> = [...moves, ...vacated]
		for (const p of final) {
			if (p.kind !== "constraint") {
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
		previous: withNames(previous, { relations, types: new Map(), keys })
	}
}

/** The declared field renames carried out on each relation under its target name, through each column's aside name so
 * no order of them meets a name another holds, and the previous snapshot with each renamed column under its target
 * name, as the database holds it once the renames ran: in its relation's record, its primary key's field names among
 * them, and wherever the snapshot's definitions name it as PostgreSQL carries a column's rename (withColumns), its
 * table's definition among them. */
const columnRenames = (
	previous: DeploySnapshot,
	after: Readonly<Record<string, SnapshotRelation>>,
	renamed: ReadonlyMap<string, string>,
	fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
	anew: ReadonlyMap<string, ReadonlySet<string>>,
	temporaries: TemporaryCensus
): { readonly statements: ReadonlyArray<SqlStatement>; readonly previous: DeploySnapshot } => {
	const schema = previous.schema
	const statements: Array<SqlStatement> = []
	/** Each table's renamed columns, by its name key, and each renamed fields' relation's record after the renames. */
	const tableColumns = new Map<NameKey, ReadonlyMap<string, string>>()
	const records = new Map<string, SnapshotRelation>()
	for (const relation of new Set([...fields.keys(), ...anew.keys()])) {
		const renames = fields.get(relation) ?? new Map<string, string>()
		const dropped = anew.get(relation) ?? new Set<string>()
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
		/** A field the migration drops whose column name a renamed field takes, or one the target declares again drawn
		 * anew, set aside first, then dropped under its aside name; its record ends here. */
		const taken = new Set<string>(moves.map((m) => m.into))
		const holders = was.fields.flatMap((f) =>
			renames.has(f.name) || !(taken.has(f.column) || dropped.has(f.name))
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
			}),
			primaryKey: was.primaryKey.map((name) => renames.get(name) ?? name)
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
					: previous.manifest.objects.map((o): RecordedObject => ({
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
 * columns and predicate, a table's declared statistics' columns, and a column privilege's grant. A column an
 * expression names without a relation is its table's, as every expression over one table's row names it. A
 * statement of any other kind names no column of a table it is built over; the roles' views, policies and functions,
 * and the materialized views, which read columns through a relation of their FROM, the diff builds again whenever
 * they read a column a migration changes.
 */
const withColumns = (
	s: RecordedStatement,
	renamed: (table: ObjectName) => ReadonlyMap<string, string> | undefined
): RecordedStatement => {
	const nameIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(column: string): string =>
			into?.get(column) ?? column
	const exprIn = (into: ReadonlyMap<string, string> | undefined, e: Expr): Expr =>
		into === undefined ? e : transformExpr(e, ownColumnHooks(nameIn(into)))
	const keyIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(k: KeyColumn): KeyColumn => ({ ...k, column: nameIn(into)(k.column) })
	const referenceIn =
		(into: ReadonlyMap<string, string> | undefined) =>
		(k: ForeignKeyColumn): ForeignKeyColumn => ({ ...k, column: nameIn(into)(k.column) })
	const columnIn = (into: ReadonlyMap<string, string> | undefined, c: ColumnDef): ColumnDef =>
		into === undefined
			? c
			: { ...new Transform(ownColumnHooks(nameIn(into))).columnDef(c), name: nameIn(into)(c.name) }
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
			case "addColumnUnchecked":
				return { ...a, column: columnIn(into, a.column) }
			case "addColumnDefault":
				return { ...a, column: columnIn(into, a.column), default: exprIn(into, a.default) }
			case "setExpression":
				return {
					...a,
					column: nameIn(into)(a.column),
					generation:
						into === undefined
							? a.generation
							: new Transform(ownColumnHooks(nameIn(into))).storedGeneration(a.generation)
				}
			case "alterColumnType":
				return {
					...a,
					column: nameIn(into)(a.column),
					using:
						a.using.kind === "expr" ? { kind: "expr", expr: exprIn(into, a.using.expr) } : a.using
				}
			case "dropColumn":
			case "dropDefault":
			case "setNotNull":
				return { ...a, column: nameIn(into)(a.column) }
			case "addConstraintUsingIndex":
			case "validateConstraint":
			case "alterConstraintDeferral":
			case "dropConstraint":
			case "enableRowSecurity":
			case "disableRowSecurity":
			case "replicaIdentity":
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
		case "declareStatistics": {
			const into = renamed(s.table)
			return into === undefined
				? s
				: {
						...s,
						columns: mapNonEmpty(s.columns, (c) => ({ ...c, column: nameIn(into)(c.column) }))
					}
		}
		case "grantColumns": {
			const into = renamed(s.table)
			return into === undefined ? s : { ...s, columns: mapNonEmpty(s.columns, nameIn(into)) }
		}
		case "createPublication":
			return {
				...s,
				tables: s.tables.map((p) => {
					const into = renamed(p.table)
					return into === undefined || p.columns.kind === "whole"
						? p
						: {
								...p,
								columns: { kind: "listed", columns: mapNonEmpty(p.columns.columns, nameIn(into)) }
							}
				})
			}
		case "dropPublication":
		case "createLiveSecret":
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
		case "replaceConstant":
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
		case "recordedFunction":
		case "recordedDeclaredFunction":
		case "recordedConstant":
		case "handOverFunction":
		case "createRowType":
		case "adoptRole":
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createTransitionTrigger":
		case "resetDatabaseDefault":
		case "createExtension":
		case "lockTable":
		case "createCarrier":
		case "emptyCarrier":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
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
 * a policy's role and a comment on a role. A statement of any other kind names no role. */
const withRoles = (s: WholeStatement, roles: ReadonlyMap<string, string>): WholeStatement => {
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
			return { ...s, from: mapNonEmpty(s.from, grantee) }
		case "createPolicy":
			return { ...s, role: role(s.role) }
		case "handOverFunction":
			return { ...s, owner: role(s.owner) }
		case "adoptRole":
			return { ...s, role: role(s.role) }
		case "rename":
			return s.object === "ROLE" ? { ...s, name: role(s.name), to: role(s.to) } : s
		case "drop":
			return s.object === "ROLE" ? { ...s, name: role(s.name) } : s
		case "comment":
			return s.on.kind === "ROLE" ? { ...s, on: { kind: "ROLE", name: role(s.on.name) } } : s
		case "replaceConstant":
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createSchema":
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
		case "createRowType":
		case "createPublication":
		case "dropPublication":
		case "createLiveSecret":
		case "createGuardTrigger":
		case "createUpdateGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "resetDatabaseDefault":
		case "createExtension":
		case "declareStatistics":
		case "lockTable":
		case "createCarrier":
		case "emptyCarrier":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
		case "refresh":
			return s
	}
}

/**
 * The declared login renames carried out, and the previous snapshot under them.
 *
 * Each renamed login's role, and each role of the previous snapshot whose name a renamed login's role takes (a login
 * dropped, as declared, or a role the target no longer holds), is first renamed aside (identity.roleAside), so any order of
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
			(role) => [role, roleAsideName(temporaries, role)] as const
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
			manifest: manifestUnderRoles(previous.manifest, roles),
			logins: byLogin(previous.logins, (_, role) => ({ role })),
			workload: byLogin(previous.workload, (programs) => programs)
		}
	}
}

/**
 * `manifest` with each role `roles` maps named under its new name: in every object's identity and statements, every
 * edge, the role defaults, the PUBLIC revokes and the comments.
 */
const manifestUnderRoles = (
	manifest: DeploySnapshot["manifest"],
	roles: ReadonlyMap<string, string>
): DeploySnapshot["manifest"] => {
	const ident = (id: string): string => {
		const parsed = parseIdent(id)
		if (parsed.kind !== "role" && parsed.kind !== "privileges" && parsed.kind !== "membership") {
			return id
		}
		const to = roles.get(parsed.name)
		return to === undefined ? id : namedIdent(parsed.kind, to)
	}
	/** A statement with its roles renamed: neither a function nor a constant names a role. */
	const renamed = (s: SqlStatement): SqlStatement =>
		s.kind === "createFunction" ||
		s.kind === "createDeclaredFunction" ||
		s.kind === "createConstant" ||
		s.kind === "packConstant" ||
		s.kind === "stubConstant"
			? s
			: withRoles(s, roles)
	const renamedIn = (list: ReadonlyArray<SqlStatement>): ReadonlyArray<SqlStatement> =>
		list.map(renamed)
	return {
		...manifest,
		objects: manifest.objects.map((o): RecordedObject => ({
			...o,
			ident: ident(o.ident),
			ddl: o.ddl.map((s) =>
				s.kind === "recordedFunction" ||
				s.kind === "recordedDeclaredFunction" ||
				s.kind === "recordedConstant"
					? s
					: withRoles(s, roles)
			)
		})),
		edges: manifest.edges.map((e) => ({ from: ident(e.from), to: ident(e.to) })),
		roleDefaults: renamedIn(manifest.roleDefaults),
		publicRevokes: renamedIn(manifest.publicRevokes),
		comments: renamedIn(manifest.comments)
	}
}

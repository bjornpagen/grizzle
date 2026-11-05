import { Refusal } from "#compiler/core/canonical.ts"
import { type Dropped, undeclaredDrop, unsupported } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
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
	relationAside,
	setAside
} from "#compiler/deploy/diff/aside.ts"
import type { Declarations, Named } from "#compiler/deploy/diff/plan.ts"
import {
	installed,
	type ManifestObject,
	nameKey,
	relationParts,
	same
} from "#compiler/deploy/snapshot/objects.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotRelation
} from "#compiler/deploy/snapshot/types.ts"
import type { ObjectName, SqlStatement } from "#compiler/sql/ast.ts"

/**
 * A draft's declarations (`--rename`, `--drop`) applied to the previous snapshot: the statements that carry out its
 * renames, which run first, and the previous snapshot as it stands after them, which the diff compares with the target.
 * A renamed relation or field is then one identity under its target name, so the diff changes it in place and never
 * reads a drop and an addition as one.
 */
export interface Applied {
	readonly statements: ReadonlyArray<SqlStatement>
	readonly previous: DeploySnapshot
}

/** A name as D9 spells it, for a refusal. */
const spelled = (n: Named): string => {
	switch (n.kind) {
		case "relation":
			return n.relation
		case "field":
			return `${n.relation}.${n.field}`
		case "handle":
			return `${n.roster}#${n.handle}`
	}
}

const sameNamed = (a: Named, b: Named): boolean => spelled(a) === spelled(b) && a.kind === b.kind

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

/**
 * The previous snapshot under the draft's declarations, and the statements that carry them out; or the refusal of a
 * declaration that names what the previous snapshot or the target does not hold as it says, and of every drop no
 * declaration names (UndeclaredDrop): each stored relation and roster the previous snapshot holds and the target no
 * longer declares, each field of a relation both hold that the target's lacks, and each roster handle whose code the
 * target's codes hold as a hole. Data a migration loses is lost only where it says so.
 *
 * A renamed relation or roster is first renamed aside with every name it owns (aside.ts relationAside), as is each
 * relation dropped whose name a rename takes, so any order of renames is free of the names it moves into, a swap or a
 * chain included; then each renamed one is renamed from its aside name to the target's, each part it owns that the
 * target's relation declares by the same definition renamed to the target's name for it (pairParts), the rest left
 * under their aside names for the diff to drop. A renamed field is renamed in place, through its own aside name, on its
 * relation under the target's name; what is built over it is built again as the target declares it. A renamed handle
 * keeps its code: the codes were drafted under the rename (ir/codes.ts draftCodebook), so nothing more is drafted for it.
 */
export const applyDeclarations = (
	previous: DeploySnapshot,
	target: SnapshotContent,
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
	/** The field renames, by the previous relation's name, previous field to target field. */
	const fields = new Map<string, Map<string, string>>()
	for (const r of declarations.renames) {
		const from = r.from
		const to = r.to
		if (from.kind !== "field" || to.kind !== "field") {
			continue
		}
		const was = heldIn(before, from.relation)
		const now = heldIn(after, to.relation)
		if (
			was?.kind !== "relation" ||
			now?.kind !== "relation" ||
			targetName(from.relation) !== to.relation ||
			!was.fields.some((f) => f.name === from.field) ||
			!now.fields.some((f) => f.name === to.field)
		) {
			return refuse(
				from,
				`a rename of ${spelled(from)} to ${spelled(to)}, a field the previous snapshot declares renamed to one the target declares on that relation`
			)
		}
		const of = fields.get(from.relation) ?? new Map<string, string>()
		of.set(from.field, to.field)
		fields.set(from.relation, of)
	}
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
			targetName(from.roster) !== to.roster ||
			!was.codes.some((c) => c.kind === "live" && c.handle === from.handle) ||
			!now.codes.some((c) => c.kind === "live" && c.handle === to.handle)
		) {
			return refuse(
				from,
				`a rename of ${spelled(from)} to ${spelled(to)}, a handle the previous snapshot's roster holds renamed to one the target's holds`
			)
		}
	}
	const named = declarations.renames.map((r) => spelled(r.from))
	if (new Set(named).size < named.length) {
		const twice = named.find((n, i) => named.indexOf(n) !== i)
		const r = declarations.renames.find((x) => spelled(x.from) === twice)
		if (r !== undefined) {
			return refuse(r.from, `two renames of ${spelled(r.from)}`)
		}
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
		const now = heldIn(after, targetName(name))
		if (now?.kind !== was.kind) {
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
					!now.fields.some((x) => x.name === to) &&
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
	/** Whether a declared drop drops what it names: something the previous snapshot holds that the target, under the
	 * declared renames, no longer does. */
	const drops = (d: Named): boolean => {
		switch (d.kind) {
			case "relation": {
				const was = heldIn(before, d.relation)
				return (
					was !== undefined &&
					!renamed.has(d.relation) &&
					heldIn(after, d.relation)?.kind !== was.kind
				)
			}
			case "field": {
				const was = heldIn(before, d.relation)
				const now = heldIn(after, targetName(d.relation))
				return (
					was?.kind === "relation" &&
					was.fields.some((f) => f.name === d.field) &&
					fields.get(d.relation)?.has(d.field) !== true &&
					!(now?.kind === "relation" && now.fields.some((f) => f.name === d.field))
				)
			}
			case "handle": {
				const was = heldIn(before, d.roster)
				const now = heldIn(after, targetName(d.roster))
				const code =
					was?.kind === "closed"
						? was.codes.findIndex((c) => c.kind === "live" && c.handle === d.handle)
						: -1
				return code >= 0 && (now?.kind !== "closed" || now.codes[code]?.kind !== "live")
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
	return renamedSnapshot(previous, target, renamed, fields, temporaries)
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
): Applied => {
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
	const firstAsides = movers.map(([, r]): Aside => {
		const name = holderOf(previous, schema, r)
		return r.kind === "relation"
			? relationAside(previous, "table", name, { kind: "declared" }, temporaries)
			: { kind: "domain", name, cause: { kind: "declared" }, to: asideName(temporaries, name.name) }
	})
	const aside = setAside(previous, firstAsides)
	/** Each renamed relation from its aside name to the target's, with the parts the target declares alike. */
	const secondAsides = movers.flatMap(([name, r], i): ReadonlyArray<Aside> => {
		const to = renamed.get(name)
		const first = firstAsides[i]
		const now = to === undefined ? undefined : heldIn(after, to)
		if (first === undefined || now === undefined) {
			return []
		}
		const from: ObjectName = { schema, name: first.to }
		const into: ObjectName = { schema, name: now.ident }
		if (r.kind === "closed" || first.kind === "domain") {
			return [{ kind: "domain", name: from, cause: { kind: "declared" }, to: now.ident }]
		}
		return [
			{
				kind: "table",
				name: from,
				cause: { kind: "declared" },
				to: now.ident,
				owned: pairedParts(aside, target, from, into)
			}
		]
	})
	const moved = setAside(aside, secondAsides)
	const columns = columnRenames(moved, after, renamed, fields, temporaries)
	const theory = {
		...columns.previous.theory,
		relations: Object.fromEntries(
			Object.entries(before).flatMap(
				([name, r]): ReadonlyArray<readonly [string, SnapshotRelation]> => {
					const to = renamed.get(name)
					const now = to === undefined ? undefined : heldIn(after, to)
					if (to === undefined || now === undefined) {
						return [[name, columns.previous.theory.relations[name] ?? r]]
					}
					const record = columns.previous.theory.relations[name] ?? r
					return [[to, { ...record, ident: now.ident }]]
				}
			)
		)
	}
	return {
		statements: [
			...firstAsides.flatMap((a) => asideStatements(a)),
			...secondAsides.flatMap((a) => asideStatements(a)),
			...columns.statements
		],
		previous: { ...columns.previous, theory }
	}
}

/** The parts of the set-aside relation `from` the target's relation `into` declares by the same definition, each to be
 * renamed from its aside name to the target's: a key by its constraint, which renames its index, another index, an
 * extended statistics object and an identity sequence by its column. */
const pairedParts = (
	aside: DeploySnapshot,
	target: SnapshotContent,
	from: ObjectName,
	into: ObjectName
): ReadonlyArray<Owned> => {
	const wasIdent = new Map(aside.manifest.objects.map((o) => [o.ident, o]))
	const nowIdent = new Map(target.manifest.objects.map((o) => [o.ident, o]))
	const was = relationParts(from, aside.manifest.objects, wasIdent)
	const now = relationParts(into, target.manifest.objects, nowIdent)
	const unpaired = <P extends { readonly name: string }>(parts: ReadonlyMap<string, P>) =>
		new Map(parts)
	const keys = unpaired(now.constraint)
	const indexes = unpaired(now.index)
	const statistics = unpaired(now.statistics)
	const sequences = unpaired(now.sequence)
	const take = <P extends { readonly name: string }>(
		pool: Map<string, P>,
		is: (p: P) => boolean
	): P | undefined => {
		const found = [...pool.values()].find(is)
		if (found !== undefined) {
			pool.delete(found.name)
		}
		return found
	}
	return [
		...[...was.constraint.values()].flatMap((c): ReadonlyArray<Owned> => {
			const k = c.constraint
			if (k.kind !== "primaryKey" && k.kind !== "unique" && k.kind !== "exclude") {
				return []
			}
			const pair = take(keys, (t) => same({ ...t.constraint, name: "" }, { ...k, name: "" }))
			return pair === undefined ? [] : [{ kind: "key", name: c.name, to: pair.name }]
		}),
		...[...was.index.values()].flatMap((x): ReadonlyArray<Owned> => {
			const pair = take(indexes, (t) =>
				same({ ...t.create, name: "" }, { ...x.create, name: "", table: into })
			)
			return pair === undefined ? [] : [{ kind: "index", name: x.name, to: pair.name }]
		}),
		...[...was.statistics.values()].flatMap((x): ReadonlyArray<Owned> => {
			const pair = take(statistics, (t) =>
				same(
					{ ...t.create, name: { ...t.create.name, name: "" } },
					{ ...x.create, name: { ...x.create.name, name: "" }, table: into }
				)
			)
			return pair === undefined ? [] : [{ kind: "statistics", name: x.name, to: pair.name }]
		}),
		...[...was.sequence.values()].flatMap((q): ReadonlyArray<Owned> => {
			const pair = take(sequences, (t) => t.column === q.column)
			return pair === undefined ? [] : [{ kind: "sequence", name: q.name, to: pair.name }]
		})
	].filter((o) => o.name !== o.to)
}

/** The declared field renames carried out on each relation under its target name, through each column's aside name so
 * no order of them meets a name another holds, and the previous snapshot with each renamed column under its target
 * name: in its table's definition and in its relation's record. */
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
		const now = heldIn(after, renamed.get(relation) ?? relation)
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
		 * aside name. */
		const taken = new Set<string>(moves.map((m) => m.into))
		const holders = was.fields.flatMap((f) =>
			renames.has(f.name) || !taken.has(f.column)
				? []
				: [{ column: f.column, aside: asideName(temporaries, f.column) }]
		)
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
			fields: was.fields.map((f) => {
				const m = fieldInto.get(f.name)
				return m === undefined ? f : { ...f, name: m.to, column: m.into }
			})
		})
	}
	const snapshot: DeploySnapshot = {
		...previous,
		manifest: {
			...previous.manifest,
			objects: previous.manifest.objects.map((o): ManifestObject => {
				const v = installed(o)
				const into = v.kind === "table" ? tableColumns.get(nameKey(v.create.table)) : undefined
				if (v.kind !== "table" || into === undefined) {
					return o
				}
				return {
					...o,
					ddl: [
						{
							...v.create,
							columns: mapNonEmpty(v.create.columns, (c) => ({
								...c,
								name: into.get(c.name) ?? c.name
							}))
						},
						...o.ddl.slice(1)
					]
				}
			})
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

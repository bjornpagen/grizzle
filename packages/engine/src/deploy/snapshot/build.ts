import {
	canonicalEquals,
	catchRefusal,
	type EncodeOptions,
	everyProperty,
	type Json,
	Refusal,
	toJson,
	withoutSourceLocs,
	writeCanonicalJson
} from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact, unsupported } from "#compiler/core/errors.ts"
import { digest, ownedDigest } from "#compiler/core/fingerprint.ts"
import { type DeclaredName, declaredAlike, identifierOf } from "#compiler/core/identity.ts"
import type { Identifier, LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import { SchemaFingerprint as toSchemaFingerprint } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { type Lines, textOf } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { headNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Comparator, compareStrings, mapInput } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { Declarations, MigrationPlan } from "#compiler/deploy/diff/plan.ts"
import {
	ledgerGuardObject,
	ledgerObject,
	ledgerPrivilegesObject,
	ledgerPublished
} from "#compiler/deploy/ledger/ledger.ts"
import { installed, type ManifestObject } from "#compiler/deploy/snapshot/objects.ts"
import {
	type CompileFacts,
	type DeploySnapshot,
	type IndexKeyColumn,
	type LawColumnHolds,
	manifestFileName,
	type SnapshotContent,
	type SnapshotDerived,
	type SnapshotFiles,
	snapshotFileName,
	type SnapshotField,
	type SnapshotIndex,
	type SnapshotLaw,
	type SnapshotLevel,
	type SnapshotRelation,
	type SnapshotTables,
	type SnapshotTheory,
	type SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import type { LawChecks } from "#compiler/deploy/snapshot/violation.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { rosterCodebook } from "#compiler/ir/codes.ts"
import { type Codebook, codecOf, type PreviousRoster } from "#compiler/ir/codes.ts"
import type { Writing } from "#compiler/ir/desc.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import {
	type AccessIndexRequest,
	type InstallationManifest,
	indexOpclassText,
	type PhysicalObject,
	type PhysicalReason,
	type ProgramAccess,
	type StoredIndexRequest,
	type WorkloadAccess
} from "#compiler/ir/products.ts"
import { Roster, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	type Filler,
	type FillRole,
	type FillSpelling,
	fillersOf,
	ownFill
} from "#compiler/laws/model/fillers.ts"
import { type LawModel, statedTheory } from "#compiler/laws/model/model.ts"
import type { LawColumnPlan } from "#compiler/laws/model/plan.ts"
import { type LivePlan, type LiveSource, noLive } from "#compiler/live/notify.ts"
import type { ClosedNames, NamedClosed } from "#compiler/physical/ddl/constants.ts"
import { storedTextDomains } from "#compiler/physical/ddl/domains.ts"
import { isolationFunctionIdent } from "#compiler/physical/ddl/isolation.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import { namedIdent } from "#compiler/physical/obligations/graph.ts"
import { levelChain, own, type Owned } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import {
	type CreateIndex,
	type CreateTable,
	type ObjectName,
	type SqlStatement,
	tableConstraints,
	type TableConstraint
} from "#compiler/sql/ast.ts"
import type { OwnerFunction } from "#compiler/sql/constants.ts"

/** Entries in the code-unit order of their keys. */
const byKey: Comparator<readonly [string, unknown]> = mapInput(
	compareStrings,
	(entry: readonly [string, unknown]) => entry[0]
)

/** Every property but the snapshot's own fingerprint. */
const withoutFingerprint: EncodeOptions = {
	omit: (...[key, , path]) => path.length === 0 && key === "fingerprint"
}

/**
 * The fingerprint of a snapshot's JSON value: the digest of every property but its own fingerprint. It is the content
 * fingerprint a finished snapshot records, and the integrity check of a read one, computed over the value JSON gave
 * before anything reads it as a snapshot: the digest is total over any value, so an edited or corrupted snapshot.json is
 * refused by its fingerprint and never reaches typed code (the shell's boundary/snapshot.ts).
 */
export const snapshotFingerprint = (
	value: unknown
): Result.Result<SchemaFingerprint, CompileError> =>
	Result.map(digest("snapshot", value, withoutFingerprint), toSchemaFingerprint)

/** The fingerprint of a schema's empty snapshot, which a database holds before its first migration: the source of that
 * migration and the latest target of a database without the schema's ledger. It depends on the installed schema
 * identifier alone, so a compiler change never orphans a first migration. */
export const emptyFingerprint = (schema: string): SchemaFingerprint => {
	return toSchemaFingerprint(ownedDigest("empty-snapshot", { schema }, everyProperty))
}

/** The empty snapshot of a schema: no object and no roster, so its codebook is the empty one (codebookOf). Its
 * fingerprint is emptyFingerprint, not the digest of its content. */
export const emptySnapshot = (input: {
	readonly schemaName: string
	readonly schema: string
}): DeploySnapshot => ({
	fingerprint: emptyFingerprint(input.schema),
	schemaName: input.schemaName,
	schema: input.schema,
	levels: [],
	theory: { schema: emptyFingerprint(input.schema), relations: {}, laws: {} },
	manifest: { objects: [], edges: [], roleDefaults: [], publicRevokes: [], comments: [] },
	constraintToLaw: { tables: {}, domains: {} },
	logins: {},
	workload: {},
	accessPaths: [],
	live: noLive
})

/** A workload access request as the snapshot records it. */
const storedRequest = (r: AccessIndexRequest): StoredIndexRequest => ({
	...r,
	keys: r.keys.map((k) => ({ expr: k.expr, dir: k.dir, opclass: indexOpclassText(k.opclass) }))
})

export const isEmptySnapshot = (s: DeploySnapshot): boolean =>
	s.fingerprint === emptyFingerprint(s.schema)

/** A digest the snapshot records, of a value the compiler built: its failure is a kernel refusal. */
const recordedDigest = (domain: string, value: unknown, options: EncodeOptions): string => {
	const d = digest(domain, value, options)
	if (!d.ok) {
		throw new Refusal(d.error)
	}
	return d.value
}

/** What fills a drawn or accumulated field, as its record digests it: its role and its laws, each by its identifier. */
export interface FillerForm {
	readonly role: FillRole
	readonly laws: NonEmptyReadonlyArray<string>
}

/** What fills a field as `spell` spells its laws (FillerForm). */
const fillerForm = (
	field: LawField,
	filler: Filler | undefined,
	spell: FillSpelling
): FillerForm => {
	if (filler === undefined) {
		throw defect(`the theory names what fills the field ${field.name}`)
	}
	return { role: filler.role, laws: mapNonEmpty(filler.laws, spell.law) }
}

/** The record of a field drawn as `form` says (SnapshotWriting): a drawn field's, and a previous snapshot's record of a
 * family's index or count, read by the identifier of the law the snapshot states it under (deploy/diff/declared.ts). */
export const drawnWriting = (form: FillerForm): SnapshotWriting => ({
	drawn: recordedDigest("drawn", form, everyProperty)
})

/** How a field is written, as the snapshot records it (SnapshotWriting): a generated field by the digest of its
 * expression as ownership declares it (`declared`), a drawn one by the digest of what draws it, an accumulated one by
 * the digest of its start value, typed as the theory types it, and of what fills it, each spelled by `spell`. */
const recordedWriting = (
	field: LawField,
	declared: Writing,
	filler: Filler | undefined,
	spell: FillSpelling
): SnapshotWriting => {
	const w = field.writing
	switch (w.kind) {
		case "caller":
		case "serial":
		case "retirement":
			return w.kind
		case "generated":
			if (declared.kind !== "generated") {
				throw defect(`ownership declares the field ${field.name} generated, as its theory does`)
			}
			return { generated: recordedDigest("generation", declared.expr, withoutSourceLocs) }
		case "drawn":
			return drawnWriting(fillerForm(field, filler, spell))
		case "accumulated":
			return {
				accumulated: recordedDigest(
					"accumulated",
					{ start: spell.literal(w.start, field), filler: fillerForm(field, filler, spell) },
					everyProperty
				)
			}
	}
}

/** A stored relation's field's writing as `spell` spells what fills it (recordedWriting), its expression read off
 * its ownership. */
export const fieldWriting = (
	installation: Installation,
	fillers: ReadonlyMap<string, ReadonlyMap<string, Filler>>,
	relation: string,
	field: LawField,
	spell: FillSpelling
): SnapshotWriting => {
	const declared = installation.owned.relations[relation]?.fields[field.name]
	if (declared === undefined) {
		throw defect(`ownership holds the field ${field.name} of the stored relation ${relation}`)
	}
	return recordedWriting(field, declared.writing, fillers.get(relation)?.get(field.name), spell)
}

/** Every property of a value but its rosters. */
const withoutRosters: EncodeOptions = { omit: (_key, value) => value instanceof Roster }

/**
 * A field's type as the snapshot records it: every property of the type but its rosters, beside the name of the roster
 * it is over. A roster's handles are its codes, which the roster's own record holds, so a column keeps its recorded type
 * when its roster grows; and the type's is the only roster a type holds, since its contract's predicate resolves no
 * other (scalar/contract.ts).
 */
const recordedType = (type: ScalarType): string =>
	recordedDigest("scalar-type", { type, roster: rosterOf(type)?.closed }, withoutRosters)

const theoryOf = (installation: Installation, checks: LawChecks): SnapshotTheory => {
	const owned = installation.owned
	const theory = installation.laws.theory
	const fillers = fillersOf(theory)
	/** A stored relation's field as the snapshot records it. */
	const fieldOf = (relation: string, f: LawField): SnapshotField => ({
		name: f.name,
		column: f.column,
		type: recordedType(f.type),
		writing: fieldWriting(installation, fillers, relation, f, ownFill)
	})
	/** A stored relation's record, from its handle. */
	/** The columns each table of the installation is created with: its CREATE TABLE's and its law columns', by name. */
	const created = new Map<string, number>()
	for (const o of installation.manifest.objects) {
		const v = installed(o)
		const table =
			v.kind === "table" ? v.create.table.name : v.kind === "lawColumn" ? v.table.name : undefined
		if (table !== undefined) {
			created.set(
				table,
				(created.get(table) ?? 0) + (v.kind === "table" ? v.create.columns.length : 1)
			)
		}
	}
	const stored = (t: RelationInfo): SnapshotRelation => ({
		kind: "relation",
		ident: t.ident,
		mutable: t.mutable,
		level: t.level,
		fields: t.fields.map((f) => fieldOf(t.name, f)),
		primaryKey: t.primaryKey,
		attnums: defined(created.get(t.ident), "every stored relation is installed as a table")
	})
	/**
	 * A materialized derived relation's or a roster's record, from its ownership; a stored relation's is its theory
	 * handle's. A live derived relation installs nothing and holds no row, so the snapshot records none.
	 */
	const ownedRecord = (
		o: (typeof owned.relations)[string]
	): ReadonlyArray<readonly [string, SnapshotRelation]> => {
		switch (o.kind) {
			case "derived":
				return o.view.kind === "live"
					? []
					: [
							[
								o.name,
								{ kind: "derived", ident: o.view.ident, mutable: o.mutable, level: o.desc.level }
							]
						]
			case "closed":
				return [
					[
						o.name,
						{
							kind: "closed",
							ident: o.ident,
							mutable: false,
							level: o.level,
							codes: codecOf(installation.names.codes, o.roster).codes
						}
					]
				]
			case "relation":
			case "closedRelation":
				return []
		}
	}
	const entries: ReadonlyArray<readonly [string, SnapshotRelation]> = [
		...Object.values(owned.relations).flatMap(ownedRecord),
		...Object.values(theory.relations).flatMap(
			(t): ReadonlyArray<readonly [string, SnapshotRelation]> =>
				t.kind === "relation" ? [[t.name, stored(t)]] : []
		)
	]
	const relations: Record<string, SnapshotRelation> = {}
	for (const [name, relation] of entries.toSorted(byKey)) {
		relations[name] = relation
	}
	const laws: Record<string, SnapshotLaw> = {}
	const migrations = new Map(checks.migrations.map((c) => [c.law, c.digest] as const))
	const rules = new Map(checks.rules.map((c) => [c.law, c.digest] as const))
	for (const law of theory.laws.toSorted(
		mapInput(compareStrings, (l: { readonly id: string }) => l.id)
	)) {
		const checked = migrations.get(law.id)
		const ruled = rules.get(law.id)
		laws[law.id] =
			checked !== undefined
				? { kind: "migration", shape: law.shape, digest: checked }
				: ruled !== undefined
					? { kind: "trigger", shape: law.shape, digest: ruled }
					: { kind: "native", shape: law.shape }
	}
	return { schema: owned.fingerprint, relations, laws }
}

/**
 * The codebook a snapshot records: each roster's codes, by its declared name (served.ts rosterCodebook), the closed
 * relation's key in the snapshot's theory, which only a declared name ever is. The empty snapshot holds none.
 */
export const codebookOf = (snapshot: DeploySnapshot): Codebook =>
	rosterCodebook(
		Object.entries(snapshot.theory.relations).flatMap(([name, r]) =>
			r.kind === "closed" ? [[trusted<DeclaredName>(name), r.codes] as const] : []
		)
	)

/** The columns a migration adds to each table, by its name: each ADD COLUMN its plan drafts, and each column of a
 * CREATE TABLE. A field set aside (deploy/diff/plan.ts SetAside) takes one more: its set-aside column's ADD COLUMN
 * (addColumnUnchecked) holds a new attribute number, renamed into the field's name, while its old column's stays
 * spent once dropped. */
const addedColumns = (plan: MigrationPlan): ReadonlyMap<string, number> => {
	const out = new Map<string, number>()
	const add = (table: string, n: number): void => {
		out.set(table, (out.get(table) ?? 0) + n)
	}
	for (const { draft: d } of plan.steps) {
		if (d.kind === "alteration") {
			add(
				d.table.name,
				d.actions.filter(
					(a) =>
						a.kind === "addColumn" ||
						a.kind === "addColumnUnchecked" ||
						a.kind === "placeholderColumn"
				).length
			)
			continue
		}
		const statements = d.kind === "statement" ? [d.statement] : d.kind === "confirm" ? d.keep : []
		for (const s of statements) {
			if (s.kind === "createTable") {
				add(s.table.name, s.columns.length)
			} else if (s.kind === "alterTable") {
				add(s.table.name, s.actions.filter((a) => a.kind === "addColumn").length)
			}
		}
	}
	return out
}

/**
 * The target state with each table's attribute numbers as the migration leaves them: a table the previous snapshot
 * holds keeps every number it used and takes one per column the plan adds; a new one, one per column it is created
 * with. A table past `limit` counting its dropped columns is refused: PostgreSQL never reuses an attribute number, so
 * only recreating the table frees them. A draft's limit is PostgreSQL's (tableMaxColumns).
 */
export const withAttnums = (
	state: SnapshotContent,
	previous: DeploySnapshot,
	plan: MigrationPlan,
	limit: number
): Result.Result<SnapshotContent, CompileError> => {
	const added = addedColumns(plan)
	const relations: Record<string, SnapshotRelation> = {}
	for (const [name, r] of Object.entries(state.theory.relations)) {
		if (r.kind !== "relation") {
			relations[name] = r
			continue
		}
		const was = previous.theory.relations[name]
		const attnums =
			was?.kind === "relation" && was.ident === r.ident
				? was.attnums + (added.get(r.ident) ?? 0)
				: r.attnums
		if (attnums > limit) {
			return Result.err(
				unsupported(
					SourceLoc(`grizzle generate of schema ${state.schemaName}`, [name]),
					`a column of ${name} past its ${limit} attribute numbers, ${attnums} counting the dropped columns', which PostgreSQL never reuses: recreate the table`
				)
			)
		}
		relations[name] = { ...r, attnums }
	}
	return Result.ok({ ...state, theory: { ...state.theory, relations } })
}

/**
 * What a draft under `declared` makes of each roster `previous` records, against the names of the rosters the schema
 * declares, as declared.ts applyDeclarations reads the declarations: a roster a declared rename names continues as the
 * rename's new name; one whose name a rename of another takes ends; any other continues as the schema's roster of an
 * alike name (core/identity.ts declaredAlike), which is one installed domain, and ends where the schema declares none.
 * The one reading of which roster a roster of the schema continues, and so of its codes (ir/codes.ts PreviousRoster):
 * the codes a draft drafts (draftCodebook) and the conversions of a column between rosters (deploy/diff/diff.ts
 * DomainReading) both follow it, and each roster of the schema continues one previous roster at most.
 */
export const rosterFates = (
	previous: DeploySnapshot,
	declared: Declarations,
	rosters: ReadonlyArray<DeclaredName>
): ReadonlyArray<PreviousRoster> => {
	const renamed = new Map(
		declared.renames.flatMap((r) =>
			r.from.kind === "relation" && r.to.kind === "relation"
				? [[r.from.relation, r.to.relation] as const]
				: []
		)
	)
	const taken = [...renamed.values()]
	return [...codebookOf(previous).rosters.values()].map((codec): PreviousRoster => {
		const to = renamed.get(codec.roster)
		if (to !== undefined) {
			return { codec, fate: { kind: "continued", as: to } }
		}
		const alike = rosters.find((r) => declaredAlike(r, codec.roster))
		return {
			codec,
			fate:
				alike === undefined || taken.some((t) => declaredAlike(t, codec.roster))
					? { kind: "ended" }
					: { kind: "continued", as: alike }
		}
	})
}

/**
 * Whether one slot continues another: a hole stays a hole, and a live code stays live, by the same handle or by the one
 * a declared rename names it, or becomes a hole. A code never takes another meaning, so no stored code is read as
 * another handle.
 */
const continuesSlot = (before: CodeSlot, after: CodeSlot): boolean =>
	before.kind === "live" || after.kind === "hole"

/** Whether `after` continues `before`: every code `before` minted kept in place (continuesSlot), and new codes after. */
const continuesCodes = (before: RosterCodes, after: RosterCodes): boolean =>
	after.length >= before.length &&
	before.every((slot, code) => {
		const now = after[code]
		return now !== undefined && continuesSlot(slot, now)
	})

/**
 * The first previous roster whose codes the roster it continues as (rosterFates) records in `next` otherwise than as
 * their continuation, or undefined when every one continues: what a draft checks the compiled installation's codebook
 * by, since a codebook drafted from another snapshot would give stored codes other meanings.
 */
export const discontinuedRoster = (
	previous: ReadonlyArray<PreviousRoster>,
	next: Codebook
): string | undefined =>
	previous.find(({ codec, fate }) => {
		if (fate.kind === "ended") {
			return false
		}
		const after = next.rosters.get(fate.as)
		return after !== undefined && !continuesCodes(codec.codes, after.codes)
	})?.codec.roster

/** The roles of the installation's logins, in login name order, which Db.open's admission reads the ledger as. */
const installationLogins = (installation: Installation): ReadonlyArray<string> =>
	installation.worlds.map((l) => l.role)

/**
 * A draft's workload: each login's programs' access, the access requests they and the roles' write filters make, and the
 * live plan of its read programs' footprints (program/workload/compile.ts ServedWorkloadPlan live).
 */
export interface DraftWorkload {
	readonly access: WorkloadAccess
	readonly accessPaths: ReadonlyArray<AccessIndexRequest>
	readonly live: LivePlan
}

/** The workload of a schema without one. */
export const noWorkload: DraftWorkload = { access: {}, accessPaths: [], live: noLive }

interface TargetInput {
	readonly installation: Installation
	readonly workload: DraftWorkload
	/** The installation's checks (snapshot/violation.ts lawChecks), whose digests the snapshot records. */
	readonly checks: LawChecks
}

/**
 * The installation's levels as the snapshot records them (SnapshotLevel), root first: each level's name, schema and
 * fingerprint, and the laws its theory states that the theory of the level below it does not, each described as an
 * outcome names it. A lower level's theory is the one its checked schema states, the level owned alone; the top's is
 * the installation's own. A lower level's law model is not compiled: the installation's, of every slice under planned
 * cycles, specialized every law of the schema, each lower level's included, and a lower level's law specializes alone
 * as it does there, so the level alone refuses nothing the installation's did not.
 */
const levelsOf = (installation: Installation): ReadonlyArray<SnapshotLevel> => {
	const owned = installation.owned
	const chain = levelChain(owned.desc)
	const top = chain.length - 1
	const stated = new Set<LawId>()
	return owned.levels.map((level, i): SnapshotLevel => {
		const desc = chain[i]
		const theory =
			i === top || desc === undefined
				? installation.laws.theory
				: unwrapCompiled(
						Result.flatMap(own(desc), (alone) => statedTheory(alone, everySlice(alone)))
					)
		const laws: Array<DescribedLaw> = []
		for (const law of theory.laws) {
			if (!stated.has(law.id)) {
				stated.add(law.id)
				laws.push({
					law: law.id,
					described: defined(
						installation.described.get(law.id),
						"the installation describes its laws"
					)
				})
			}
		}
		return {
			name: level.name,
			schema: identifierOf(defined(installation.names.levels[i], "a level's schema")),
			fingerprint: level.fingerprint,
			laws: laws.toSorted((a, b) => compareStrings(a.law, b.law))
		}
	})
}

/** A compiled value, or its refusal thrown, which targetState returns. */
const unwrapCompiled = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/** An installed table as snapshotTablesOf gathers it: its relation, each field by its column, and its indexes. */
interface GatheredTable {
	readonly relation: string
	readonly fields: ReadonlyMap<string, string>
	readonly indexes: Map<string, SnapshotIndex>
}

/** A key column of an index's statement: the column it names and its direction (IndexKeyColumn). */
interface KeyAt {
	readonly column: string
	readonly direction: IndexKeyColumn["direction"]
}

/** The record of `entries` in code-unit order of their keys, each value mapped by `value`. */
const keyOrdered = <A, B>(
	entries: Iterable<readonly [string, A]>,
	value: (a: A) => B
): Readonly<Record<string, B>> =>
	Object.fromEntries(
		[...entries]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([k, a]) => [k, value(a)] as const)
	)

/** A two-level map's value at `outer`, then `inner`. */
const valueAt = <V>(
	map: ReadonlyMap<string, ReadonlyMap<string, V>>,
	outer: string,
	inner: string
): V | undefined => map.get(outer)?.get(inner)

/** `value` set at `outer`, then `inner`, of a two-level map. */
const setAt = <V>(
	map: Map<string, Map<string, V>>,
	outer: string,
	inner: string,
	value: V
): void => {
	const within = map.get(outer) ?? new Map<string, V>()
	within.set(inner, value)
	map.set(outer, within)
}

/** What a law column the law model planned holds (LawColumnHolds), by the field whose values it holds. */
const holdsOf = (plan: LawColumnPlan, field: string): LawColumnHolds => {
	switch (plan.kind) {
		case "term":
			return { kind: "term", field }
		case "constant":
			return { kind: "constant", target: plan.target.name, field: plan.field.name }
		case "drawn":
			return { kind: "drawn", field: plan.field.name }
		case "indexPred":
			return { kind: "predecessor", field: plan.field.name }
	}
}

/** The key columns of a primary key's, a unique key's or a span key's constraint, a B-tree's ascending, a GiST's none. */
const constraintKeys = (constraint: TableConstraint): NonEmptyReadonlyArray<KeyAt> => {
	switch (constraint.kind) {
		case "primaryKey":
		case "unique": {
			const direction = constraint.columns.some((c) => c.withoutOverlaps) ? "none" : "asc"
			return mapNonEmpty(constraint.columns, (c) => ({ column: c.column, direction }))
		}
		case "exclude":
			return mapNonEmpty(constraint.elements, (e) => ({ column: e.column, direction: "none" }))
		case "check":
		case "foreignKey":
			throw defect(`the constraint ${constraint.name}, which installs no index`)
	}
}

/** The key columns of a CREATE INDEX, each a column it names, a B-tree's with its direction, any other's with none. */
const createdKeys = (create: CreateIndex): NonEmptyReadonlyArray<KeyAt> =>
	mapNonEmpty(create.keys, (k) => {
		if (k.key.kind !== "column") {
			throw defect(`the index ${create.name} over an expression, which no installation creates`)
		}
		return {
			column: k.key.column,
			direction: create.method !== "btree" ? "none" : k.direction === "ASC" ? "asc" : "desc"
		}
	})

/**
 * Every table and materialized view the installation installs, as a plan names it (SnapshotTables): each stored
 * relation's table and each materialized derived relation's view, under its declared name, by the installation's names
 * (physical/ddl/names.ts InstallNames relation), and on each, every index its manifest installs, read through the one
 * view of a manifest object (objects.ts installed): a created index by its CREATE INDEX, a primary key's, a unique
 * key's and an exclusion constraint's by its constraint, as its table declares it or its own ALTER TABLE adds it. Each
 * index has the reasons the manifest records and its key columns in order, each read from the statement's own column
 * and resolved, never parsed: a field of the relation, a stored relation's own or a derived relation's heading's, by
 * the column the installation's names give it, or a law column by what the law model planned it to hold and the laws
 * its manifest object records. An index on any other table, or over a column neither resolves, is a defect of the
 * installation's compile.
 */
const snapshotTablesOf = (installation: Installation): SnapshotTables => {
	const schemas = new Map<string, Map<string, GatheredTable>>()
	const relations = [
		...Object.values(installation.laws.theory.relations).flatMap((t) =>
			t.kind === "relation" ? [t.name] : []
		),
		...Object.values(installation.owned.relations).flatMap((o) =>
			o.kind === "derived" && o.view.kind !== "live" ? [o.name] : []
		)
	]
	const derivedHeadings = new Map(
		installation.checked.derived.map((a) => [a.name, a.heading.map((c) => c.name)] as const)
	)
	for (const relation of relations) {
		const table = installation.names.relation(relation)
		const fieldNames =
			derivedHeadings.get(relation) ??
			Object.keys(installation.owned.relations[relation]?.fields ?? {})
		const fields = new Map(
			fieldNames.map((field) => [installation.names.column(relation, field), field] as const)
		)
		setAt(schemas, table.schema, table.name, { relation, fields, indexes: new Map() })
	}
	const holds = new Map<string, Map<string, LawColumnHolds>>()
	for (const n of installation.laws.natives) {
		if (n.namespace === "column") {
			setAt(holds, n.object.relation.name, n.object.column, holdsOf(n.plan, n.object.field.name))
		}
	}
	const creates = new Map<string, Map<string, CreateTable>>()
	const lawColumns = new Map<string, Map<string, ReadonlyArray<LawId>>>()
	for (const o of installation.manifest.objects) {
		const v = installed(o)
		if (v.kind === "table") {
			setAt(creates, v.create.table.schema, v.create.table.name, v.create)
		}
		if (v.kind === "lawColumn") {
			setAt(
				lawColumns,
				`${v.table.schema}.${v.table.name}`,
				v.column,
				o.reasons.flatMap((r) => (r.kind === "law" ? [r.law] : []))
			)
		}
	}
	const index = (
		table: ObjectName,
		name: string,
		keys: NonEmptyReadonlyArray<KeyAt>,
		reasons: ReadonlyArray<PhysicalReason>
	): void => {
		const on = valueAt(schemas, table.schema, table.name)
		if (on === undefined) {
			throw defect(
				`the index ${name} is on a relation's table or materialized view, not ${table.name}`
			)
		}
		const columns = mapNonEmpty(keys, (k): IndexKeyColumn => {
			const field = on.fields.get(k.column)
			if (field !== undefined) {
				return { kind: "field", field, direction: k.direction }
			}
			const held = valueAt(holds, on.relation, k.column)
			const laws = valueAt(lawColumns, `${table.schema}.${table.name}`, k.column)
			if (held === undefined || laws === undefined) {
				throw defect(
					`the column ${k.column} of index ${name}: a field or a law column of ${on.relation}`
				)
			}
			return { kind: "law", holds: held, laws, direction: k.direction }
		})
		on.indexes.set(name, { columns, reasons })
	}
	const declared = (table: ObjectName, name: string): TableConstraint => {
		const create = valueAt(creates, table.schema, table.name)
		const constraint =
			create === undefined ? undefined : tableConstraints(create).find((c) => c.name === name)
		if (constraint === undefined) {
			throw defect(`the constraint ${name}, which its table ${table.name} declares`)
		}
		return constraint
	}
	for (const o of installation.manifest.objects) {
		const v = installed(o)
		switch (v.kind) {
			case "index":
			case "uniqueIndex":
				index(v.create.table, v.create.name, createdKeys(v.create), o.reasons)
				break
			case "primaryKey":
			case "unique":
				index(
					v.table,
					v.name,
					constraintKeys(
						v.placement.kind === "own" ? v.placement.constraint : declared(v.table, v.name)
					),
					o.reasons
				)
				break
			case "table":
			case "constant":
			case "domain":
			case "materializedView":
			case "statistics":
			case "isolationTrigger":
			case "lawTrigger":
			case "refusalFunction":
			case "advanceFunction":
			case "unitFunction":
			case "isolationFunction":
			case "snapshotGuard":
			case "lawFunction":
			case "worldFunction":
			case "role":
			case "membership":
			case "privileges":
			case "roleSchema":
			case "view":
			case "policy":
			case "rowSecurity":
			case "replicaIdentity":
			case "liveSecret":
			case "publication":
			case "decoder":
			case "lawColumn":
			case "check":
			case "foreignKey":
			case "ledger":
			case "schema":
			case "extension":
			case "validation":
			case "databaseDefault":
				break
		}
	}
	return keyOrdered(schemas, (tables) =>
		keyOrdered(tables, (t) => ({ relation: t.relation, indexes: keyOrdered(t.indexes, (i) => i) }))
	)
}

/** The installation's derived runtime facts, which snapshot.json records beside the snapshot's content (SnapshotDerived):
 * each closed relation's constants as readers address them, the installation's plan's, the foreign key graph's
 * cycles, its law model's, which planned them from every law, every table and materialized view it installs with its
 * indexes (snapshotTablesOf), its live source, and the types its plan casts its served parameters to
 * (InstallPlan.installedParams). */
export const derivedOf = (installation: Installation): SnapshotDerived => ({
	...derivedFacts(installation.owned, installation.closed, installation.laws),
	tables: snapshotTablesOf(installation),
	live: liveSourceOf(installation),
	params: installation.installedParams
})

/**
 * The installation's live source in installed terms (live/notify.ts LiveSource): none where it serves no read;
 * otherwise each footprint table by its table's identifier, with the identifiers of the columns of the fields it
 * routes by, in code point order. A materialized view of the plan publishes nothing: its refresh announces itself.
 */
const liveSourceOf = (installation: Installation): LiveSource => {
	const { live, names } = installation
	return live.kind === "none"
		? { kind: "none" }
		: {
				kind: "source",
				tables: Object.fromEntries(
					live.tables.map(
						(t) =>
							[
								names.relation(t.relation).name,
								t.routes.map((field) => names.column(t.relation, field)).toSorted(compareStrings)
							] as const
					)
				),
				views: live.views.map((view) => names.relation(view).name).toSorted(compareStrings)
			}
}

/**
 * The compile facts of an installation of `owned` whose closed relations' constants are named as `closed` names
 * them, under its law model `model` (derivedOf): what a level's artifacts compile under besides its codes, from a
 * snapshot (adapter/served/login.ts artifactsUnder) or, before the snapshot is written, from the basis the installation
 * is compiled over, so both read the same facts.
 */
export const derivedFacts = (owned: Owned, closed: ClosedNames, model: LawModel): CompileFacts => ({
	closed,
	fkCycles: model.fkCycles,
	references: model.references,
	textDomains: storedTextDomains(owned, model.theory)
})

/** The target snapshot's content, built from the compiled installation of the current schema and workload, with the
 * migrations ledger's objects added to its manifest: the ledger table and its SERIALIZABLE guard trigger in Setup,
 * after the guard's function, every login's SELECT on it in Publish, and the ledger among the tables of the live
 * source's publication (ledgerPublished), where the installation holds one. */
export const targetState = (input: TargetInput): Result.Result<SnapshotContent, CompileError> =>
	catchRefusal(() => {
		const { installation } = input
		const schema = installation.names.schema
		const objects: Array<ManifestObject> = []
		/** The ledger and its guard follow the isolation function the guard runs, so the first Setup file creates the
		 * function before the ledger. */
		const ledger = ledgerObject(schema)
		const guard = ledgerGuardObject(schema)
		for (const o of installation.manifest.objects) {
			objects.push(o.kind === "publication" ? ledgerPublished(schema, o) : o)
			if (o.kind === "isolationFunction") {
				objects.push(ledger, guard)
			}
		}
		const privileges = ledgerPrivilegesObject(schema, installationLogins(installation))
		if (privileges !== undefined) {
			objects.push(privileges)
		}
		/** The installation's edges, in its order (by the identities its objects' names were minted from), then the
		 * ledger's. */
		const edges = [
			...installation.manifest.edges,
			{ from: namedIdent("schema", schema), to: ledger.ident },
			{ from: isolationFunctionIdent(schema), to: guard.ident },
			{ from: ledger.ident, to: guard.ident },
			...installation.manifest.objects.flatMap((o) =>
				o.kind === "publication" ? [{ from: ledger.ident, to: o.ident }] : []
			)
		]
		return {
			schemaName: headNonEmpty(installation.owned.levels).name,
			schema,
			levels: levelsOf(installation),
			theory: theoryOf(installation, input.checks),
			manifest: { ...installation.manifest, objects, edges },
			constraintToLaw: {
				tables: sortedOwners(installation.constraintToLaw.tables),
				domains: sortedOwners(installation.constraintToLaw.domains)
			},
			logins: sortedRecord(
				Object.fromEntries(installation.worlds.map((l) => [l.name, { role: l.role }] as const))
			),
			workload: input.workload.access,
			accessPaths: input.workload.accessPaths.map((r) => storedRequest(r)),
			live: input.workload.live
		}
	})

const sortedRecord = <V>(record: Readonly<Record<string, V>>): Readonly<Record<string, V>> =>
	Object.fromEntries(Object.entries(record).toSorted(byKey))

/** One kind of owner's constraint laws, its owners and each owner's constraint names in key order. */
const sortedOwners = <V>(
	owners: Readonly<Record<string, Readonly<Record<string, V>>>>
): Readonly<Record<string, Readonly<Record<string, V>>>> =>
	sortedRecord(
		Object.fromEntries(
			Object.entries(owners).map(([owner, named]) => [owner, sortedRecord(named)] as const)
		)
	)

/** The form of a snapshot, before the canonical tags: what its fingerprint digests and what snapshot.json writes. Each
 * record of the documented form holds exactly its documented fields, and each installed statement is the statement
 * itself, every clause stated. A key whose value is absent is left out, as an undefined clause of a statement and the
 * type's default operator class of an access path's key are. The shell reads exactly this value back as the snapshot,
 * once its fingerprint holds (boundary/snapshot.ts). */
type SnapshotForm = RecordOf<never>

/** A unit of snapshot.json laid out compact, on one line of its own, as its one canonical value: an installed
 * statement, the unit the diff compares and a review reads, so a changed statement is one changed line; or a level's
 * law as an outcome names it. */
class CompactLine {
	readonly value: SqlStatement | DescribedLaw
	constructor(value: SqlStatement | DescribedLaw) {
		this.value = value
	}
}

/** A value of the snapshot's form whose compact units, its installed statements and its levels' laws, are `S`: the units
 * themselves, which the fingerprint digests, or their CompactLines, which snapshot.json is written from. */
type FormOf<S> =
	| string
	| number
	| boolean
	| bigint
	| S
	| ReadonlyArray<FormOf<S>>
	| { readonly [key: string]: FormOf<S> }

/** A record of the snapshot's form whose installed statements are `S`. */
type RecordOf<S> = { readonly [key: string]: FormOf<S> }

/** How a form holds its compact units: an installed statement and a level's law. */
interface Units<S> {
	readonly statement: (s: SqlStatement) => S
	readonly law: (l: DescribedLaw) => S
}

/** Each unit as itself. */
const asValues: Units<SqlStatement | DescribedLaw> = { statement: (s) => s, law: (l) => l }

/** Each unit as its line of snapshot.json. */
const asLines: Units<CompactLine> = {
	statement: (s) => new CompactLine(s),
	law: (l) => new CompactLine(l)
}

const writingForm = (w: SnapshotWriting): FormOf<never> =>
	typeof w === "string"
		? w
		: "generated" in w
			? { generated: w.generated }
			: "drawn" in w
				? { drawn: w.drawn }
				: { accumulated: w.accumulated }

const fieldForm = (f: SnapshotField): SnapshotForm => ({
	name: f.name,
	column: f.column,
	type: f.type,
	writing: writingForm(f.writing)
})

/** A roster's codes as the snapshot writes them: `[{"kind":"live","handle":"a"},{"kind":"hole"},…]`. */
const codesForm = (codes: RosterCodes): FormOf<never> =>
	codes.map((slot): SnapshotForm =>
		slot.kind === "live" ? { kind: slot.kind, handle: slot.handle } : { kind: slot.kind }
	)

/** What every relation's record of the theory states: its kind, ident, mutability and level. */
const relationHead = (r: SnapshotRelation): SnapshotForm => ({
	kind: r.kind,
	ident: r.ident,
	mutable: r.mutable,
	level: r.level
})

const relationForm = (r: SnapshotRelation): SnapshotForm => {
	const of = relationHead(r)
	switch (r.kind) {
		case "derived":
			return of
		case "relation":
			return {
				...of,
				fields: r.fields.map(fieldForm),
				primaryKey: r.primaryKey,
				attnums: r.attnums
			}
		case "closed":
			return { ...of, codes: codesForm(r.codes) }
	}
}

const lawForm = (l: SnapshotLaw): SnapshotForm => {
	switch (l.kind) {
		case "native":
			return { kind: l.kind, shape: l.shape }
		case "migration":
		case "trigger":
			return { kind: l.kind, shape: l.shape, digest: l.digest }
	}
}

const valuesForm = <V>(
	record: Readonly<Record<string, V>>,
	form: (v: V) => SnapshotForm
): SnapshotForm =>
	Object.fromEntries(Object.entries(record).map(([key, value]) => [key, form(value)] as const))

/** A relation's record as manifest.json writes it: a roster's without its codes, which snapshot.json holds
 * (rostersForm), any other's whole. */
const laidOutRelationForm = (r: SnapshotRelation): SnapshotForm =>
	r.kind === "closed" ? relationHead(r) : relationForm(r)

/** The theory's form, each relation's record written by `relation`. */
const theoryForm = (
	t: SnapshotTheory,
	relation: (r: SnapshotRelation) => SnapshotForm
): SnapshotForm => ({
	schema: t.schema,
	relations: valuesForm(t.relations, relation),
	laws: valuesForm(t.laws, lawForm)
})

/** Each roster's codes, by its declared name, as snapshot.json writes them. */
const rostersForm = (t: SnapshotTheory): SnapshotForm =>
	Object.fromEntries(
		Object.entries(t.relations).flatMap(([name, r]) =>
			r.kind === "closed" ? [[name, codesForm(r.codes)] as const] : []
		)
	)

const reasonForm = (r: PhysicalReason): SnapshotForm => {
	switch (r.kind) {
		case "law":
			return { kind: r.kind, law: r.law }
		case "access":
			return { kind: r.kind }
		case "enforcement":
			return { kind: r.kind, of: r.of }
		case "proof":
			return { kind: r.kind, premises: r.premises }
	}
}

const objectForm = <S>(o: PhysicalObject<SqlStatement>, units: Units<S>): RecordOf<S> => ({
	kind: o.kind,
	ident: o.ident,
	ddl: o.ddl.map(units.statement),
	reasons: o.reasons.map(reasonForm),
	state: o.state,
	phase: o.phase
})

const manifestForm = <S>(m: InstallationManifest<SqlStatement>, units: Units<S>): RecordOf<S> => ({
	objects: m.objects.map((o) => objectForm(o, units)),
	edges: m.edges.map((e) => ({ from: e.from, to: e.to })),
	roleDefaults: m.roleDefaults.map(units.statement),
	publicRevokes: m.publicRevokes.map(units.statement),
	comments: m.comments.map(units.statement)
})

const requestForm = (r: StoredIndexRequest): SnapshotForm => ({
	relation: r.relation,
	keys: r.keys.map((k): SnapshotForm =>
		k.opclass === undefined
			? { expr: k.expr, dir: k.dir }
			: { expr: k.expr, dir: k.dir, opclass: k.opclass }
	),
	method: r.method,
	role: r.role,
	use: r.use
})

/** The JSON form of a program's access: its paths and statistics, each in its canonical order. */
const accessForm = (a: ProgramAccess): SnapshotForm => ({
	paths: a.paths.map((p): SnapshotForm => ({
		relation: p.relation,
		derived: p.derived,
		method: p.method,
		keys: p.keys.map((k): SnapshotForm => ({ field: k.field, dir: k.dir })),
		use: p.use
	})),
	statistics: a.statistics.map((st): SnapshotForm => ({
		relation: st.relation,
		columns: st.columns,
		use: st.use
	}))
})

/** The JSON form of an owner function of a dependent key: its function's identifier and its width. */
const ownerFunctionForm = (f: OwnerFunction<Identifier<"closedConstant">>): SnapshotForm => ({
	function: f.function,
	width: f.width
})

/** The JSON form of a closed relation's constants as readers address them (NamedClosed), a payload field of no
 * dictionary stating none. */
const closedForm = (c: NamedClosed): SnapshotForm => ({
	function: c.function,
	key:
		c.key.kind === "product"
			? {
					kind: c.key.kind,
					coordinates: c.key.coordinates.map((k): SnapshotForm => ({
						field: k.field,
						radix: k.radix
					}))
				}
			: {
					kind: c.key.kind,
					owner: c.key.owner.map((k): SnapshotForm => ({ field: k.field, radix: k.radix })),
					block: c.key.block.map((b): SnapshotForm =>
						b.kind === "codes"
							? { kind: b.kind, field: b.field, radix: b.radix }
							: { kind: b.kind, field: b.field, count: b.count }
					),
					bases: ownerFunctionForm(c.key.bases),
					counts: c.key.counts.map(ownerFunctionForm),
					cells: c.key.cells
				},
	width: c.width,
	payload: c.payload.map((p): SnapshotForm =>
		p.dictionary === undefined
			? { field: p.field, radix: p.radix }
			: { field: p.field, radix: p.radix, dictionary: p.dictionary }
	),
	keys: c.keys,
	functions: c.functions
})

/** The JSON form of the installation's derived runtime facts (SnapshotDerived): each member's form by its owner. */
const derivedForm = (d: SnapshotDerived): SnapshotForm => ({
	live: d.live,
	params: {
		domains: d.params.domains,
		contracts: d.params.contracts.map((c) => ({
			name: c.name,
			digest: c.digest,
			checked: c.checked
		}))
	},
	closed: Object.fromEntries([...d.closed].map(([name, c]) => [name, closedForm(c)] as const)),
	fkCycles: d.fkCycles,
	references: d.references.map((r) => ({ law: r.law, part: r.part })),
	textDomains: Object.fromEntries([...d.textDomains].toSorted(([a], [b]) => compareStrings(a, b))),
	tables: Object.fromEntries(
		Object.entries(d.tables).map(([schema, tables]) => [
			schema,
			Object.fromEntries(
				Object.entries(tables).map(([name, t]) => [
					name,
					{
						relation: t.relation,
						indexes: Object.fromEntries(
							Object.entries(t.indexes).map(([n, i]) => [
								n,
								{
									columns: i.columns.map((c) =>
										c.kind === "field"
											? { kind: c.kind, field: c.field, direction: c.direction }
											: { kind: c.kind, holds: c.holds, laws: c.laws, direction: c.direction }
									),
									reasons: i.reasons
								}
							])
						)
					}
				])
			)
		])
	)
})

const levelsForm = <S>(levels: ReadonlyArray<SnapshotLevel>, units: Units<S>): FormOf<S> =>
	levels.map((l): RecordOf<S> => ({
		name: l.name,
		schema: l.schema,
		fingerprint: l.fingerprint,
		laws: l.laws.map(units.law)
	}))

/** The members of the content manifest.json holds, the theory's relations written by `relation`: every member but
 * the ones snapshot.json holds (runtimeForm). */
const migrationForm = <S>(
	c: SnapshotContent,
	units: Units<S>,
	relation: (r: SnapshotRelation) => SnapshotForm
): RecordOf<S> => ({
	schemaName: c.schemaName,
	schema: c.schema,
	theory: theoryForm(c.theory, relation),
	manifest: manifestForm(c.manifest, units),
	logins: valuesForm(c.logins, (l): SnapshotForm => ({ role: l.role })),
	workload: valuesForm(c.workload, (programs) => valuesForm(programs, accessForm)),
	accessPaths: c.accessPaths.map(requestForm)
})

/** The JSON form of a snapshot's content: every field of the snapshot but its fingerprint, the one value the
 * fingerprint digests, whichever file holds each member. */
const contentForm = <S>(c: SnapshotContent, units: Units<S>): RecordOf<S> => ({
	...migrationForm(c, units, relationForm),
	levels: levelsForm(c.levels, units),
	constraintToLaw: c.constraintToLaw,
	live: liveForm(c.live)
})

/**
 * The JSON form of a live plan: its kind, and for one that reads, each footprint table's relation and the fields it
 * routes by, and each view's name.
 */
const liveForm = (plan: LivePlan): SnapshotForm =>
	plan.kind === "none"
		? { kind: plan.kind }
		: {
				kind: plan.kind,
				tables: plan.tables.map((t): SnapshotForm => ({ relation: t.relation, routes: t.routes })),
				views: plan.views
			}

/** snapshot.json's form: the members DbLayer.make reads (ServedSnapshot), its fingerprint, every level, the
 * constraint-to-law map, the live plan (`live`), each roster's codes (`rosters`), which manifest.json's theory records
 * without, and the installation's derived runtime facts (`derived`), which the content and its fingerprint hold none
 * of. */
const runtimeForm = <S>(
	s: DeploySnapshot,
	derived: SnapshotDerived,
	units: Units<S>
): RecordOf<S> => ({
	fingerprint: s.fingerprint,
	levels: levelsForm(s.levels, units),
	constraintToLaw: s.constraintToLaw,
	live: liveForm(s.live),
	rosters: rostersForm(s.theory),
	derived: derivedForm(derived)
})

/** The finished snapshot: the target state, fingerprinted. */
export const finishSnapshot = (
	state: SnapshotContent
): Result.Result<DeploySnapshot, CompileError> =>
	Result.map(snapshotFingerprint(contentForm(state, asValues)), (fingerprint) => ({
		...state,
		fingerprint
	}))

/**
 * A JSON form's list or record written with tabs, `head` before its first line and `tail` after its last: one item or
 * member per line, each written by `write`, an object's keys in code point order (RFC 8785's order, as the canonical
 * text), a member's key in its head and its separating comma in its tail.
 */
const nestedValue = <V>(
	out: Lines,
	head: string,
	value: ReadonlyArray<V> | { readonly [key: string]: V },
	tail: string,
	write: (out: Lines, head: string, value: V, tail: string) => void
): void => {
	if (isList(value)) {
		if (value.length === 0) {
			return out.line(`${head}[]${tail}`)
		}
		out.line(`${head}[`)
		const items = out.nested()
		for (const [i, item] of value.entries()) {
			write(items, "", item, i === value.length - 1 ? "" : ",")
		}
		return out.line(`]${tail}`)
	}
	const entries = Object.entries(value).toSorted(([a], [b]) => compareStrings(a, b))
	if (entries.length === 0) {
		return out.line(`${head}{}${tail}`)
	}
	out.line(`${head}{`)
	const members = out.nested()
	for (const [i, [key, member]] of entries.entries()) {
		write(members, `${JSON.stringify(key)}: `, member, i === entries.length - 1 ? "" : ",")
	}
	return out.line(`}${tail}`)
}

/** A JSON form value written with tabs, `head` before its first line and `tail` after its last (`nestedValue`). */
const jsonValue = (out: Lines, head: string, value: Json, tail: string): void =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? out.line(`${head}${JSON.stringify(value)}${tail}`)
		: nestedValue(out, head, value, tail, jsonValue)

const jsonTextLoc = SourceLoc("JSON text", [])

/** The reviewable text of a canonical value: its JSON form, keys in code point order, indented by tabs, ending in a
 * newline. Equal values are equal bytes. A text past V8's longest string is refused as ResourceBound (stringLength),
 * and a kernel Refusal its writer throws is its failure. */
export const writeJsonText = (value: unknown): Result.Result<string, CompileError> =>
	Result.flatMap(toJson(value, everyProperty), (json) =>
		Result.flatMap(
			catchRefusal(() =>
				textOf(maxStringLength.value, "\t", jsonTextLoc, (out) => {
					jsonValue(out, "", json, "")
					out.line("")
				})
			),
			(text) => text
		)
	)

/** A kernel result's value, or its failure thrown as a Refusal for the writer's door to return. */
const valueOf = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/**
 * snapshot.json's text of a form value, `head` before its first line and `tail` after its last: an installed statement
 * on one line, its compact canonical JSON; a scalar as its canonical JSON; a list or a record one item or member per
 * line, a record's keys in code point order.
 */
const formValue = (out: Lines, head: string, value: FormOf<CompactLine>, tail: string): void => {
	if (value instanceof CompactLine) {
		const compact = valueOf(writeCanonicalJson(valueOf(toJson(value.value, everyProperty))))
		return out.line(`${head}${compact}${tail}`)
	}
	if (typeof value !== "object") {
		return jsonValue(out, head, valueOf(toJson(value, everyProperty)), tail)
	}
	return nestedValue(out, head, value, tail, formValue)
}

/** A snapshot file's text of its form: written with object keys in code point order and indented by tabs for review,
 * each installed statement compact on a line of its own (formValue), ending in a newline. */
const fileText = (form: RecordOf<CompactLine>): string =>
	valueOf(
		textOf(maxStringLength.value, "\t", jsonTextLoc, (out) => {
			formValue(out, "", form, "")
			out.line("")
		})
	)

/** The texts of a snapshot's two files in `migrations/<schema>/`: snapshot.json, what an application imports
 * (runtimeForm), and manifest.json, every other member (migrationForm), each member in one of them. Together they are
 * the snapshot's canonical JSON form laid out for review, so a changed statement is one changed line and the same
 * snapshot is the same bytes on every machine. The layout is the writer's: the fingerprint digests the content's
 * canonical text (contentForm), which no layout changes, and joinedSnapshot puts the two back together. */
export const writeSnapshot = (
	snapshot: DeploySnapshot,
	derived: SnapshotDerived
): Result.Result<SnapshotFiles, CompileError> =>
	catchRefusal(() => ({
		snapshot: fileText(runtimeForm(snapshot, derived, asLines)),
		manifest: fileText(migrationForm(snapshot, asLines, laidOutRelationForm))
	}))

/**
 * Whether the derived runtime facts snapshot.json records, as read (JoinedSnapshot.derived), are `computed`, the facts the
 * compile derives (derivedOf): their canonical texts are equal (derivedForm). A member missing, as in a snapshot.json
 * laid out before its facts were derived, or another compile's facts, are not; `grizzle check` refuses them and
 * `grizzle generate` writes snapshot.json again, with no migration, since no fact is part of the fingerprinted content.
 */
export const derivedHolds = (recorded: unknown, computed: SnapshotDerived): boolean =>
	canonicalEquals(recorded, derivedForm(computed), everyProperty)

/** A snapshot's two files joined (joinedSnapshot): the JSON form of its whole content, which its fingerprint digests,
 * and snapshot.json's derived runtime facts as recorded, kept out of the content, absent from a file that holds none. */
export interface JoinedSnapshot {
	readonly content: Readonly<Record<string, unknown>>
	readonly derived: unknown
}

/** A member a snapshot file must hold that it does not: no pair grizzle wrote. */
const unjoined = (file: string, at: ReadonlyArray<string>, what: string): CompileError =>
	malformedArtifact("snapshot", at, `${file} ${what}`)

/**
 * The JSON form of a whole snapshot from the JSON values of its two files, the layout writeSnapshot writes undone:
 * manifest.json's members and snapshot.json's, which share none, each roster's codes put back into the record of the
 * theory manifest.json holds for it, and snapshot.json's derived runtime facts set apart from the content. A pair that
 * does not join so is none grizzle wrote, refused as MalformedArtifact;
 * what joins is trusted only once its fingerprint holds over the whole (the shell's boundary/snapshot.ts).
 */
export const joinedSnapshot = (
	runtime: unknown,
	migration: unknown
): Result.Result<JoinedSnapshot, CompileError> => {
	if (!isRecord(runtime)) {
		return Result.err(unjoined(snapshotFileName, [], "holding an object"))
	}
	if (!isRecord(migration)) {
		return Result.err(unjoined(manifestFileName, [], "holding an object"))
	}
	const { rosters, derived, ...served } = runtime
	const theory = migration["theory"]
	const relations = isRecord(theory) ? theory["relations"] : undefined
	if (!isRecord(rosters)) {
		return Result.err(unjoined(snapshotFileName, ["rosters"], "recording each roster's codes"))
	}
	if (!isRecord(theory) || !isRecord(relations)) {
		return Result.err(
			unjoined(manifestFileName, ["theory", "relations"], "recording the theory's relations")
		)
	}
	const shared = Object.keys(served).find((key) => Object.hasOwn(migration, key))
	if (shared !== undefined) {
		return Result.err(unjoined(manifestFileName, [shared], "holding no member snapshot.json holds"))
	}
	const joined: Record<string, unknown> = { ...relations }
	for (const [name, codes] of Object.entries(rosters)) {
		const relation = relations[name]
		if (!isRecord(relation) || relation["kind"] !== "closed" || Object.hasOwn(relation, "codes")) {
			return Result.err(
				unjoined(
					manifestFileName,
					["theory", "relations", name],
					"recording the roster whose codes snapshot.json holds"
				)
			)
		}
		joined[name] = { ...relation, codes }
	}
	return Result.ok({
		content: { ...migration, ...served, theory: { ...theory, relations: joined } },
		derived
	})
}

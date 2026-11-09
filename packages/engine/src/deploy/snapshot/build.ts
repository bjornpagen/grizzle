import {
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
import type { LawId, SchemaFingerprint } from "#compiler/core/ids.ts"
import { SchemaFingerprint as toSchemaFingerprint } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { type Lines, textOf } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { headNonEmpty } from "#compiler/core/nonempty.ts"
import { type Comparator, compareStrings, mapInput } from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { Declarations, MigrationPlan } from "#compiler/deploy/diff/plan.ts"
import {
	ledgerGuardObject,
	ledgerObject,
	ledgerPrivilegesObject
} from "#compiler/deploy/ledger/ledger.ts"
import { installed, type ManifestObject } from "#compiler/deploy/snapshot/objects.ts"
import { rosterCodebook } from "#compiler/deploy/snapshot/served.ts"
import {
	type DeploySnapshot,
	manifestFileName,
	type SnapshotContent,
	type SnapshotFiles,
	snapshotFileName,
	type SnapshotField,
	type SnapshotLaw,
	type SnapshotLevel,
	type SnapshotRelation,
	type SnapshotTheory,
	type SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
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
import { type Filler, type FillSpelling, fillersOf, ownFill } from "#compiler/laws/model/fillers.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { isolationFunctionIdent } from "#compiler/physical/ddl/isolation.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { DescribedLaw } from "#compiler/physical/install/plan.ts"
import { namedIdent } from "#compiler/physical/obligations/graph.ts"
import { levelChain, own } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"

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
	accessPaths: []
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

/** What fills a drawn or accumulated field, as its record digests it: its role and its laws. */
const fillerForm = (field: LawField, filler: Filler | undefined, spell: FillSpelling) => {
	if (filler === undefined) {
		throw defect(`the theory names what fills the field ${field.name}`)
	}
	return { role: filler.role, laws: filler.laws.map(spell.law) }
}

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
			return w.kind
		case "generated":
			if (declared.kind !== "generated") {
				throw defect(`ownership declares the field ${field.name} generated, as its theory does`)
			}
			return { generated: recordedDigest("generation", declared.expr, withoutSourceLocs) }
		case "drawn":
			return { drawn: recordedDigest("drawn", fillerForm(field, filler, spell), everyProperty) }
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

const theoryOf = (installation: Installation): SnapshotTheory => {
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
							codes: codecOf(installation.names.codes, new Roster(o.name, o.desc.handles)).codes
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
	const checks = lawChecks(installation)
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

/** The codebook a snapshot records: each roster's codes, by its declared name (served.ts rosterCodebook). The empty
 * snapshot holds none. */
export const codebookOf = (snapshot: DeploySnapshot): Codebook =>
	rosterCodebook(
		Object.entries(snapshot.theory.relations).flatMap(([name, r]) =>
			r.kind === "closed" ? [[name, r.codes] as const] : []
		)
	)

/** The columns a migration adds to each table, by its name: each ADD COLUMN its plan drafts, and each column of a
 * CREATE TABLE. */
const addedColumns = (plan: MigrationPlan): ReadonlyMap<string, number> => {
	const out = new Map<string, number>()
	const add = (table: string, n: number): void => {
		out.set(table, (out.get(table) ?? 0) + n)
	}
	for (const { draft: d } of plan.steps) {
		if (d.kind === "placeholderColumn") {
			add(d.table.name, 1)
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

/** A draft's workload: each login's programs' access, and the access requests they and the roles' write filters make. */
export interface DraftWorkload {
	readonly access: WorkloadAccess
	readonly accessPaths: ReadonlyArray<AccessIndexRequest>
}

/** The workload of a schema without one. */
export const noWorkload: DraftWorkload = { access: {}, accessPaths: [] }

interface TargetInput {
	readonly installation: Installation
	readonly workload: DraftWorkload
}

/**
 * The installation's levels as the snapshot records them (SnapshotLevel), root first: each level's name, schema and
 * fingerprint, and the laws its theory states that the theory of the level below it does not, each described as an
 * outcome names it. A lower level's theory is its law model's, compiled from the level as it is owned alone; the top's
 * is the installation's own.
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
						Result.flatMap(own(desc), (owned) => compileLaws(owned, everySlice(owned)))
					).theory
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

/** The target snapshot's content, built from the compiled installation of the current schema and workload, with the
 * migrations ledger's objects added to its manifest: the ledger table and its SERIALIZABLE guard trigger in Setup,
 * after the guard's function, and every login's SELECT on it in Publish. */
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
			objects.push(o)
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
			{ from: ledger.ident, to: guard.ident }
		]
		return {
			schemaName: headNonEmpty(installation.owned.levels).name,
			schema,
			levels: levelsOf(installation),
			theory: theoryOf(installation),
			manifest: { ...installation.manifest, objects, edges },
			constraintToLaw: {
				tables: sortedOwners(installation.constraintToLaw.tables),
				domains: sortedOwners(installation.constraintToLaw.domains)
			},
			logins: sortedRecord(
				Object.fromEntries(installation.worlds.map((l) => [l.name, { role: l.role }] as const))
			),
			workload: input.workload.access,
			accessPaths: input.workload.accessPaths.map((r) => storedRequest(r))
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
	constraintToLaw: c.constraintToLaw
})

/** snapshot.json's form: the members DbLayer.make reads (ServedSnapshot), its fingerprint, every level, the
 * constraint-to-law map and each roster's codes (`rosters`), which manifest.json's theory records without. */
const runtimeForm = <S>(s: DeploySnapshot, units: Units<S>): RecordOf<S> => ({
	fingerprint: s.fingerprint,
	levels: levelsForm(s.levels, units),
	constraintToLaw: s.constraintToLaw,
	rosters: rostersForm(s.theory)
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
	snapshot: DeploySnapshot
): Result.Result<SnapshotFiles, CompileError> =>
	catchRefusal(() => ({
		snapshot: fileText(runtimeForm(snapshot, asLines)),
		manifest: fileText(migrationForm(snapshot, asLines, laidOutRelationForm))
	}))

/** A member a snapshot file must hold that it does not: no pair grizzle wrote. */
const unjoined = (file: string, at: ReadonlyArray<string>, what: string): CompileError =>
	malformedArtifact("snapshot", at, `${file} ${what}`)

/**
 * The JSON form of a whole snapshot from the JSON values of its two files, the layout writeSnapshot writes undone:
 * manifest.json's members and snapshot.json's, which share none, each roster's codes put back into the record of the
 * theory manifest.json holds for it. A pair that does not join so is none grizzle wrote, refused as MalformedArtifact;
 * what joins is trusted only once its fingerprint holds over the whole (the shell's boundary/snapshot.ts).
 */
export const joinedSnapshot = (
	runtime: unknown,
	migration: unknown
): Result.Result<Readonly<Record<string, unknown>>, CompileError> => {
	if (!isRecord(runtime)) {
		return Result.err(unjoined(snapshotFileName, [], "holding an object"))
	}
	if (!isRecord(migration)) {
		return Result.err(unjoined(manifestFileName, [], "holding an object"))
	}
	const { rosters, ...served } = runtime
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
	return Result.ok({ ...migration, ...served, theory: { ...theory, relations: joined } })
}

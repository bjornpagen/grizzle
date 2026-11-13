import { appendAll } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type TemporaryCensus,
	type TemporaryKind
} from "#compiler/core/identity.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import {
	type Comparator,
	combine,
	compareNumbers,
	compareStrings,
	flip,
	mapInput
} from "#compiler/core/order.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type * as Result from "#compiler/core/result.ts"
import { type Aside, asideStatements } from "#compiler/deploy/diff/aside.ts"
import {
	type BackfilledTable,
	backfillOf,
	type DrawnColumns,
	drawnColumns
} from "#compiler/deploy/diff/backfill.ts"
import {
	type AbandonedSchema,
	type Action,
	type Alteration,
	alterationPass,
	alterTablePasses,
	alterationStatement,
	type ColumnConversion,
	type Draft,
	isTableSlot,
	type MigrationPlan,
	type RetypeReason,
	type SetAside,
	type Slot,
	type Step,
	type Swap,
	slots,
	type TableSlot
} from "#compiler/deploy/diff/plan.ts"
import { ledgerPrivilegesIdent } from "#compiler/deploy/ledger/ledger.ts"
import {
	type BuiltOver,
	builtOver,
	constraintColumns,
	generationColumns,
	type Installed,
	installed,
	keyOrCheckDefinition,
	type ManifestObject,
	nameKey,
	objectTable,
	type PartOf,
	type Parts,
	partsAt,
	partsByTable,
	refuse,
	same
} from "#compiler/deploy/snapshot/objects.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotTheory,
	SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import type { LawChecks, MigrationCheck } from "#compiler/deploy/snapshot/violation.ts"
import { keptRosters, type PreviousRoster, type RosterFate } from "#compiler/ir/codes.ts"
import type { InstallationManifest, PhysicalKind } from "#compiler/ir/products.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { targetKey, touchedTargets } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent, parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	AlterRole,
	AlterTable,
	AlterTableAction,
	Collation,
	ColumnDef,
	ColumnGeneration,
	CreateConstant,
	CreateDomain,
	CreateIndex,
	CreateTable,
	Expr,
	ForeignKey,
	FunctionName,
	Grant,
	GrantRole,
	ObjectName,
	PackConstant,
	Revoke,
	SqlStatement,
	TableConstraint,
	TypeRef,
	TypeSchema
} from "#compiler/sql/ast.ts"

import {
	call,
	cast,
	col,
	columnKey,
	desc,
	functionNameOf,
	ge,
	lit,
	objectName,
	provedSelect,
	table as tableFrom,
	tableCol,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"

interface DiffInput {
	readonly previous: DeploySnapshot
	readonly target: SnapshotContent
	/** The compiled target, for the violation queries of the laws a migration discharges. */
	readonly installation: Installation
	/** The target's checks (snapshot/violation.ts lawChecks), the ones its snapshot records the digests of. */
	readonly checks: LawChecks
	/** The renames the migration declares (declared.ts), which `previous` stands after, drafted once the holders are set
	 * aside. */
	readonly renames: ReadonlyArray<SqlStatement>
	/** The holders `previous` already has set aside, whose renames the plan drafts first. */
	readonly asides: ReadonlyArray<Aside>
	/** The census of this migration's temporaries, which set the holders aside and admits every other temporary the
	 * diff mints: an index's swap name. */
	readonly temporaries: TemporaryCensus
	/** The schemas the migrations directory holds that the configuration no longer lists, when `previous` is the empty
	 * snapshot: the schema's creation then leaves their rows behind (`Loss`). */
	readonly abandoned: ReadonlyArray<AbandonedSchema>
	/** Each roster the previous snapshot records, with what the draft makes of it (snapshot/build.ts rosterFates): which
	 * of the previous installation's domains are a roster's, and which roster of the target each continues as. */
	readonly rosters: ReadonlyArray<PreviousRoster>
}

/** How a marker names a holder's kind. */
const holdingText: { readonly [K in Aside["kind"]]: string } = {
	table: "relation",
	materializedView: "derived relation",
	domain: "domain"
}

/** Why a marker says a holder is set aside: the kind of object taking its name, or where its identity may move. */
const asideWhy = (a: Aside): string => {
	switch (a.cause.kind) {
		case "taken":
			return `the removed ${holdingText[a.kind]} ${printObjectName(a.name)} holds the name the ${holdingText[a.cause.taker.kind]} ${printObjectName(a.name)} takes`
		case "declared":
			return `the migration declares the ${holdingText[a.kind]} ${printObjectName(a.name)} renamed`
	}
}

/** What a set-aside holder owns that goes aside with it: a relation's indexes, sequences and statistics; a type, none. */
const ownedAside = (a: Aside): string =>
	(a.kind === "table" || a.kind === "materializedView") && a.owned.length > 0
		? ", with each index, identity sequence and statistics object it owns, whose names a relation of its old name would take, renamed aside too"
		: ""

/** What a migration does to a column of a table it keeps (ColumnFates): kept as it is; converted in place, a field
 * whose type changes; redefined, a law column whose definition changes, or a field rewritten (fieldChange), dropped and
 * added again; or dropped, a field or law column the target no longer holds. */
type ColumnFate =
	| { readonly kind: "kept" }
	| { readonly kind: "converted" }
	| { readonly kind: "redefined" }
	| { readonly kind: "dropped" }

const keptColumn: ColumnFate = { kind: "kept" }
const convertedColumn: ColumnFate = { kind: "converted" }
const droppedColumn: ColumnFate = { kind: "dropped" }
const redefinedColumn: ColumnFate = { kind: "redefined" }

/** The fate of each column of a table, fields and law columns, by name. */
type ColumnFates = ReadonlyMap<string, ColumnFate>

/** The capability a draft refuses when a name moves between a login and a role in one migration, as when the two
 * exchange names: its PostgreSQL role would turn from a login into a role, or back, which no statement does, so the
 * draft is refused at that role, never drafted. */
export const loginRoleExchange =
	"a login and a role exchanging one name, which no statement turns into each other: rename one of them"

/** What a migration drops: an object of every kind but those no step drops (the schema, its ledger, extensions and the
 * database's defaults outlive it; a validation installs nothing; privileges and memberships are revoked, never dropped;
 * an isolation trigger goes with its table), and a column. */
type Dropped =
	| Exclude<
			PhysicalKind,
			"databaseDefault" | "extension" | "validation" | "privileges" | "ledger" | "membership"
	  >
	| "column"

/** The one order in which a migration drops what it drops, by kind, each step that drops several sorting them by it
 * (dropWorlds, dropReplaced, publish.removed): the roles' policies before their views and the world functions they
 * call; the foreign keys before the keys they reference; the keys and CHECKs before the indexes, a row security
 * switched off beside them; then the roles and their schemas, the statistics objects, the materialized views before
 * what they read, the functions, the law
 * columns and columns, the tables over the domains they use, the domains over the constants their CHECKs read, and the
 * constants last, which RESTRICT refuses to drop while anything still reads one. Within a kind, each step keeps its own
 * order: publish.removed the reverse install order, so a materialized view goes before the lower one it reads, a table
 * before one it references and a constant before the one its body reads; and a level's schema after everything in it. */
const dropOrder: { readonly [K in Dropped]: number } = {
	policy: 0,
	view: 1,
	worldFunction: 2,
	foreignKey: 3,
	primaryKey: 4,
	unique: 4,
	check: 4,
	index: 5,
	uniqueIndex: 5,
	rowSecurity: 5,
	role: 6,
	roleSchema: 6,
	statistics: 7,
	materializedView: 9,
	lawTrigger: 3,
	isolationTrigger: 3,
	refusalFunction: 11,
	advanceFunction: 11,
	isolationFunction: 11,
	snapshotGuard: 11,
	lawFunction: 11,
	lawColumn: 12,
	column: 13,
	table: 14,
	domain: 15,
	constant: 16,
	schema: 17
}

/** SET CONSTRAINTS ALL IMMEDIATE, before Structure's first data step (holdsDataSteps): an UPDATE of rows the
 * migration's own transaction wrote (a table rewritten by a generated column's ADD COLUMN or a conversion, or updated
 * by an earlier UPDATE) queues the check of every deferrable foreign key over them until the commit, since
 * PostgreSQL fires a referencing row's check whatever its keys when its own transaction wrote the row (PostgreSQL
 * 19rc1, src/backend/utils/adt/ri_triggers.c RI_FKey_fk_upd_check_required at 1515, slot_is_current_xact_tuple at
 * 1585-1586), and refuses to alter a table with a check pending (src/backend/commands/tablecmds.c CheckTableNotInUse at
 * 4448, AfterTriggerPendingOnRel at 4462, 55006 at 4466), as a fill's DROP COLUMN, the backfill's DROP DEFAULT and
 * every constraint added after them do. Under it each check runs at the end of its UPDATE. It holds for the rest of the
 * Structure transaction, which every data step, the reviewer's, a fill's and the backfill's, runs after: Structure's
 * statements before it, its drops and its tables' alterations, write no row. */
const checkedAtOnce: SqlStatement = { kind: "setConstraintsImmediate" }

/** A drop drafted with its kind's place in the drop order. */
interface Drop {
	readonly rank: number
	readonly draft: Action
}

const byDropOrder = mapInput(compareNumbers, (d: { readonly rank: number }) => d.rank)

const tableIdent = (name: ObjectName): string => qualifiedIdent("table", name.schema, name.name)
const viewIdent = (name: ObjectName): string =>
	qualifiedIdent("materializedView", name.schema, name.name)

const statement = (s: SqlStatement): Action => ({ kind: "statement", statement: s })

const alter = (table: ObjectName, actions: AlterTable["actions"]): SqlStatement => ({
	kind: "alterTable",
	table,
	actions
})

/** A constraint's ADD, after the DROP of the one it replaces under its name. */
const replacing = (
	replace: boolean,
	name: string,
	add: AlterTableAction
): NonEmptyReadonlyArray<AlterTableAction> =>
	replace ? [{ kind: "dropConstraint", name }, add] : [add]

/** A primary key or candidate key a B-tree index implements, one with no span; none for any other constraint. */
const btreeKeyOf = (
	c: TableConstraint
): Extract<TableConstraint, { readonly kind: "primaryKey" | "unique" }> | undefined =>
	(c.kind === "primaryKey" || c.kind === "unique") && !c.columns.some((k) => k.withoutOverlaps)
		? c
		: undefined

/** A table both installations hold, read once before anything is drafted: the target's object, the previous table's
 * position in the install order (publish.removed drops objects of one kind in reverse order), the previous and the
 * target declaration, and the fate of each column of the previous table, its fields' and its law columns'
 * (ColumnFates). */
interface KeptTable {
	readonly object: ManifestObject
	readonly order: number
	readonly old: CreateTable
	readonly create: CreateTable
	readonly fates: ColumnFates
	/** The change of each field both declarations hold, by name (fieldChangesOf). */
	readonly changes: ReadonlyMap<string, FieldChange>
}

/** The fate of the column `column` of a table both install, the one every part of the previous table is built over
 * has: a column its table lacks is a malformed snapshot. */
const columnFate = (kept: KeptTable, column: string): ColumnFate =>
	kept.fates.get(column) ?? refuse(kept.object.ident, `a table whose columns include ${column}`)

/** A kept table as its visit drafts it, planned before anything is drafted: its fields paired by name, and its identity
 * sequences paired by column, one the target names otherwise renamed. */
interface KeptPlan {
	readonly table: KeptTable
	/** The previous declaration's fields the target no longer holds. */
	readonly removed: ReadonlyArray<ColumnDef>
	/** The target's fields in its order, each new or with the previous field of its name. */
	readonly fields: ReadonlyArray<
		| { readonly kind: "added"; readonly column: ColumnDef }
		| { readonly kind: "held"; readonly column: ColumnDef; readonly was: ColumnDef }
	>
	/** Each identity sequence of a field both hold whose identity stays, the previous one's with the target's, which a
	 * target naming it otherwise renames it to. */
	readonly sequences: ReadonlyArray<{
		readonly was: PartOf<"sequence">
		readonly now: PartOf<"sequence">
	}>
}

/** A removal drafted for publish.removed, ordered by the drop order (dropOrder), then reverse install order, then as
 * drafted: the columns of one table in its column order. */
interface Removal {
	readonly rank: number
	readonly order: number
	readonly draft: Draft
}

/** A materialized view the previous manifest installs that a migration drops at the start of Structure, by table key:
 * one whose definition changes, or that reads a relation this migration recreates or a table whose column it converts.
 * One the target keeps is created again; one it no longer has cannot outlive what it reads. */
interface ViewDrop {
	readonly key: string
	readonly view: Installed & { readonly kind: "materializedView" }
	/** Created again when the target keeps it, dropped for good when it does not. */
	readonly fate: "recreated" | "dropped"
}

/** What takes an object of the previous installation away in Structure, before the target's objects are visited: the
 * drop of the roles' views, world functions and policies (dropWorlds); the drop of a materialized view, which takes the
 * indexes and statistics objects on it along (dropViews); or the replacement of a column it is built over
 * (takenByReplacement), before which its own `drop` takes it away (dropReplaced). */
type Taken =
	| { readonly kind: "world" }
	| { readonly kind: "view" }
	| ({ readonly kind: "replaced" } & Replaced)

/** What a migration does to an object of the previous installation, decided once when the Differ is built, so no rule
 * acts on an object an earlier step already took away: taken away in Structure (Taken); kept, the target holding it,
 * its visit drafting any change; or removed, the target no longer holding it: dropped in place (remove), or, a primary
 * key the target replaces under a new name on the table it keeps (`swapped`), in the ALTER TABLE that adds the target's
 * (ownConstraint), or, a foreign key referencing a key the target swaps (`unbound`), just before that key, `by` the
 * target's (ownConstraint). */
type Fate =
	| Taken
	| { readonly kind: "kept" }
	| { readonly kind: "removed" }
	| { readonly kind: "swapped" }
	| { readonly kind: "unbound"; readonly by: string }

/** An object of the previous installation with its position in the install order and its fate. */
interface Previous {
	readonly object: ManifestObject
	readonly order: number
	readonly fate: Fate
}

/** What an object of the target is to this migration, read off the previous object it follows: new, created by its
 * visit, when the previous installation lacks it or a view's or the roles' drop took it away; following `before`, which
 * stands until its visit drafts the change: the previous object of its identity, or, for a primary key on a table both
 * install, the removed one it swaps in for (Fate `swapped`); or created again by its visit once a replacement took the
 * previous one away (`replaced`). */
type Arrival =
	| { readonly kind: "new" }
	| { readonly kind: "follows"; readonly before: ManifestObject }
	| { readonly kind: "replaced"; readonly how: Replacement }

const arrivedNew: Arrival = { kind: "new" }

/** What the target's object of an identity whose previous object `taken` took away is: new after a view's or the roles'
 * drop, which create it as they create a new one; created again after its replacement. */
const arrivalAfter = (taken: Taken): Arrival => {
	switch (taken.kind) {
		case "world":
		case "view":
			return arrivedNew
		case "replaced":
			return { kind: "replaced", how: taken.how }
	}
}

/** An object of the target with what it is to this migration. */
interface Target {
	readonly object: ManifestObject
	readonly arrival: Arrival
}

/** The run order of the steps: by slot, then (the sort being stable) as drafted. */
const stepOrder: Comparator<Step> = mapInput(compareNumbers, (s: Step) => slots.indexOf(s.slot))

const roleDefaultText = (s: SqlStatement) => canonicalTextOf(s)

/** Each role setting with the queries listed before it. */
const roleSettings = (list: ReadonlyArray<SqlStatement>) => {
	const out: Array<{
		readonly statement: AlterRole
		readonly prelude: ReadonlyArray<SqlStatement>
	}> = []
	const prelude: Array<SqlStatement> = []
	for (const s of list) {
		if (s.kind === "alterRole") {
			out.push({ statement: s, prelude: [...prelude] })
		} else {
			prelude.push(s)
		}
	}
	return out
}

/** A table's one alteration in a slot that alters each table once (TableSlot), as the visits draft it: its first
 * subcommand, which places it, and the rest in the order the visits draft them. */
interface TableAlteration {
	readonly table: ObjectName
	readonly first: Alteration
	readonly rest: Array<Alteration>
}

/** Where the plan's steps stand while the visits draft them: a step drafted whole, or the place of a table's one
 * alteration in its slot, which later visits may still add subcommands to (Differ.alter). */
type Drafting =
	| { readonly kind: "step"; readonly step: Step }
	| { readonly kind: "alteration"; readonly slot: TableSlot; readonly alteration: TableAlteration }
	| { readonly kind: "fill"; readonly fill: TableFill }

/** A table's fill of its set-aside fields (SetAside) in structure.fill, as the visits draft it: its first field, which
 * places it, and the rest in the order the visits set them aside. */
interface TableFill {
	readonly table: ObjectName
	readonly first: SetAside
	readonly rest: Array<SetAside>
}

/** Each set-aside field of a table by its name, with its set-aside column's: none for a table that sets none aside. */
type AsideColumns = ReadonlyMap<string, string>

const noAside: AsideColumns = new Map()

/** The fields a fill sets aside, by name, each with its set-aside column. */
const asideColumnsOf = (fill: TableFill): AsideColumns =>
	new Map([fill.first, ...fill.rest].map((f) => [f.column.name, f.aside] as const))

/** An expression with each column it reads that `aside` sets aside read as its set-aside column. */
const throughAside = (e: Expr, aside: AsideColumns): Expr =>
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind !== "column" || x.table !== undefined) {
				return x
			}
			const column = aside.get(x.column)
			return column === undefined ? x : { ...x, column }
		}
	})

/** The columns of its own row an expression reads, by name. */
const rowColumns = (e: Expr): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column" && x.table === undefined) {
				out.push(x.column)
			}
			return x
		}
	})
	return out
}

/** Whether a generation reads a field `aside` sets aside. */
const readsAside = (g: ColumnGeneration, aside: AsideColumns): boolean => {
	const reads = (e: Expr) => rowColumns(e).some((c) => aside.has(c))
	switch (g.kind) {
		case "stored":
			return reads(g.expr)
		case "partial":
			return reads(g.when) || reads(g.expr)
		case "identity":
		case "uuidv7":
			return false
	}
}

/**
 * A subcommand of a table's Structure alteration, its generated column over a set-aside field generated over the
 * set-aside column instead, which the fill renames into the field's name, so the expression reads the field once the
 * migration ends, PostgreSQL holding its reads by attribute number: a partial projection, NULL wherever it selects
 * nothing, as it is; any other added with no NOT NULL (addColumnUnchecked), since the set-aside column is NULL until the
 * fill, which sets its NOT NULL once the fill has drawn it (`checked`).
 */
const asideSubcommand = (
	a: Alteration,
	aside: AsideColumns
): { readonly alteration: Alteration; readonly checked: ReadonlyArray<string> } => {
	if (
		a.kind !== "addColumn" ||
		a.column.generated === undefined ||
		!readsAside(a.column.generated, aside)
	) {
		return { alteration: a, checked: [] }
	}
	const g = a.column.generated
	switch (g.kind) {
		case "partial":
			return {
				alteration: {
					...a,
					column: {
						...a.column,
						generated: {
							...g,
							when: throughAside(g.when, aside),
							expr: throughAside(g.expr, aside)
						}
					}
				},
				checked: []
			}
		case "stored":
			return {
				alteration: {
					kind: "addColumnUnchecked",
					column: { ...a.column, generated: { ...g, expr: throughAside(g.expr, aside) } }
				},
				checked: [a.column.name]
			}
		case "identity":
		case "uuidv7":
			return { alteration: a, checked: [] }
	}
}
/** An alteration's subcommands in PostgreSQL's pass order, the order of drafting within a pass (alterationPass). */
const byPass = mapInput(compareNumbers, (a: Alteration) =>
	alterTablePasses.indexOf(alterationPass(a))
)

/** The draft of a table's alteration, its subcommands in pass order: the one ALTER TABLE PostgreSQL runs as written. */
const alterationDraft = (a: TableAlteration, aside: AsideColumns): Action => ({
	kind: "alteration",
	table: a.table,
	actions: sortNonEmpty(
		mapNonEmpty([a.first, ...a.rest], (x) => asideSubcommand(x, aside).alteration),
		byPass
	)
})

/** The draw a set-aside field takes once its fill renames it into its name: its identity, its uuidv7() default, or none
 * for a field its caller writes. */
const drawOf = (column: ColumnDef): ReadonlyArray<AlterTableAction> => {
	switch (column.generated?.kind) {
		case "identity":
			return [{ kind: "addIdentity", column: column.name, sequence: column.generated.sequence }]
		case "uuidv7":
			return [{ kind: "setUuidv7Default", column: column.name }]
		case "stored":
		case "partial":
		case undefined:
			return []
	}
}

/**
 * The steps of a table's fill: the fill itself, its UPDATE at the reviewer's values (Action fill), in structure.fill;
 * then its settling, in structure.settle, after every table's fill, so a fill that joins another table's old column,
 * a field set aside or declared dropped, reads it still standing under its name: the fields' old columns dropped; each
 * set-aside column renamed into its field's name; then one ALTER TABLE setting the NOT NULL of each field and of each
 * generated column over one (asideSubcommand's `checked`, read off the table's Structure alteration `structure`), each
 * field's identity or uuidv7() default, and each identity's advance after it, past the values the fill drew.
 */
const fillSteps = (
	fill: TableFill,
	structure: TableAlteration | undefined,
	aside: AsideColumns
): ReadonlyArray<Step> => {
	const t = fill.table
	const fields = mapNonEmpty([fill.first, ...fill.rest], (f) => f)
	const checked =
		structure === undefined
			? []
			: [structure.first, ...structure.rest].flatMap((a) => asideSubcommand(a, aside).checked)
	const takes = fields.flatMap(({ column }) => drawOf(column))
	const advances = fields.flatMap(({ column }): ReadonlyArray<SqlStatement> =>
		column.generated?.kind === "identity"
			? [advance(t, column.name, column.generated.sequence, column.type)]
			: []
	)
	const settled = (s: SqlStatement): Step => ({ slot: "structure.settle", draft: statement(s) })
	return [
		{ slot: "structure.fill", draft: { kind: "fill", table: t, fields } },
		settled(
			alter(
				t,
				mapNonEmpty(fields, (f) => ({ kind: "dropColumn", column: f.column.name }))
			)
		),
		...fields.map((f) =>
			settled({ kind: "renameColumn", table: t, from: f.aside, to: f.column.name })
		),
		settled(
			alter(t, [
				...mapNonEmpty(fields, (f): AlterTableAction => ({
					kind: "setNotNull",
					column: f.column.name
				})),
				...checked.map((column): AlterTableAction => ({ kind: "setNotNull", column })),
				...takes
			])
		),
		...advances.map(settled)
	]
}

/** A draft's alteration of one table, which a slot that alters each table once merges into the table's one: an ALTER
 * TABLE statement's actions, or an alteration's subcommands; any other draft is none. */
const alteredBy = (
	d: Draft
):
	| { readonly table: ObjectName; readonly actions: NonEmptyReadonlyArray<Alteration> }
	| undefined => {
	switch (d.kind) {
		case "statement":
			return d.statement.kind === "alterTable"
				? { table: d.statement.table, actions: d.statement.actions }
				: undefined
		case "alteration":
			return { table: d.table, actions: d.actions }
		case "fill":
		case "violation":
		case "analyze":
		case "dropStatistics":
		case "loss":
		case "confirm":
			return undefined
	}
}

class Differ {
	readonly input: DiffInput
	readonly schema: string
	/** The PostgreSQL schemas of the installation's levels, the previous's and the target's, the root's among them. */
	readonly levelSchemas: ReadonlySet<string>
	/** The plan's steps as the visits draft them, each table's alteration in a slot that alters each table once at the
	 * place of its first subcommand (drafted). */
	readonly drafting: Array<Drafting> = []
	/** Each table's one alteration in each slot that alters each table once, by table key (nameKey). */
	readonly alterations: { readonly [S in TableSlot]: Map<string, TableAlteration> } = {
		structure: new Map(),
		"structure.constraints": new Map()
	}
	/** The keys structure.constraints adds again after their conversion (ownConstraint): a foreign key onto one is its
	 * own statement after the key's (foreignKey). */
	readonly constrainedKeys = new Set<KeyAfter>()
	/** Each table's fill of its set-aside fields, by table key (setAside). */
	readonly fills = new Map<string, TableFill>()
	readonly prev: ReadonlyMap<string, ManifestObject>
	readonly next: ReadonlyMap<string, ManifestObject>
	/** The parts of every relation of the previous and of the target installation, by name key (partsByTable). */
	readonly prevParts: ReadonlyMap<string, Parts>
	readonly nextParts: ReadonlyMap<string, Parts>
	/** The domains of the previous and the target installation (domainsOf), which a column of each is read through to
	 * what it holds (representationOf). */
	readonly prevDomains: ReadonlyMap<string, DomainReading>
	readonly nextDomains: ReadonlyMap<string, DomainReading>
	/** Each table both installations hold, by identity, with the fate of each of its columns (KeptTable). */
	readonly keptTables: ReadonlyMap<string, KeptTable>
	/** The materialized views this migration drops at the start of Structure (viewDropsOf). */
	readonly viewDrops: ReadonlyArray<ViewDrop>
	/** What publish.removed drops, gathered while drafting and drafted in order once every removal is known
	 * (draftRemovals). */
	readonly removals: Array<Removal> = []
	/** Keys of relations that may hold rows that this migration attaches in Validate. */
	readonly attached = new Set<KeyAfter>()
	/** Every index this migration builds under a temporary name, as swapName mints it. */
	readonly swaps: Array<Swap> = []
	/** The keys of tables both snapshots install whose index this migration drops in Validate beside a key the target
	 * declares over the same columns, by identity (replacedKeysOf): each goes before the foreign keys over those columns
	 * are added (replacedKey, unbind). */
	readonly replaced: ReadonlyMap<string, ReplacedKey>
	/** Each table both installations hold as its visit drafts it, by identity (KeptPlan). */
	readonly keptPlans: ReadonlyMap<string, KeptPlan>
	/** Recreated materialized views, by table key: their privileges went with their drop. */
	readonly recreatedViews: ReadonlySet<string>
	/** Relations this migration drops at the start of Structure and does not create again, by table key: a view the
	 * target no longer has that reads a recreated relation. Their privileges went with them. */
	readonly dropped: ReadonlySet<string>
	/** The identity sequences of a table both snapshots install that this migration drops, by name key, each with its
	 * fate (sequenceFatesOf). */
	readonly sequences: ReadonlyMap<string, SequenceFate>
	/** What each installed materialized view reads, by table key: the previous snapshot's edges, and the qualified
	 * names of every installed definition. */
	readonly reads: ReadonlyMap<string, ReadonlySet<string>>
	/** The names of the roles' views and world functions this migration drops at the start of Structure, by name key,
	 * whose privileges went with them. */
	readonly worldGone: ReadonlySet<string>
	/** Domains whose constraint this migration replaces, by name key: the validation statements that cast to one run
	 * again in Publish. */
	readonly reconstrained = new Set<string>()
	/** Every object of the previous installation, in its install order, with its fate. */
	readonly previous: ReadonlyArray<Previous>
	/** Every object of the target, in its install order, with what it is to this migration. */
	readonly targets: ReadonlyArray<Target>
	/** What each object of the target that follows a previous one or replaces a taken one is, by identity (arrivalOf). */
	readonly arrivals: ReadonlyMap<string, Arrival>
	/** The columns the target's families draw, each with the placeholder default it is added under to a table that may
	 * hold rows (backfill.ts drawnColumns). */
	readonly drawn: DrawnColumns
	/** The drawn columns this migration adds to tables that may hold rows under their placeholders, by table key, which
	 * the backfill draws and then drops the default of. */
	readonly backfilled = new Map<string, BackfilledTable>()

	constructor(input: DiffInput) {
		this.input = input
		this.schema = input.target.schema
		this.drawn = drawnColumns(input.installation)
		const previousObjects = input.previous.manifest.objects
		const targetObjects = input.target.manifest.objects
		this.prev = new Map(previousObjects.map((o) => [o.ident, o]))
		this.next = new Map(targetObjects.map((o) => [o.ident, o]))
		this.prevParts = partsByTable(this.prev.values(), this.prev)
		this.nextParts = partsByTable(this.next.values(), this.next)
		this.prevDomains = domainsOf(
			input.previous.manifest,
			rosterConstantsOf(input.previous.schema, input.rosters)
		)
		this.nextDomains = domainsOf(
			input.target.manifest,
			rosterConstantsOf(input.target.schema, keptRosters(input.installation.names.codes))
		)
		this.levelSchemas = new Set([
			input.target.schema,
			...input.target.levels.map((l) => l.schema),
			...input.previous.levels.map((l) => l.schema)
		])
		this.reads = installedReads(input.previous, this.levelSchemas)
		this.keptTables = this.keptTablesOf()
		this.sequences = sequenceFatesOf(this.keptTables.values())
		const replacedBy = this.takenByReplacement()
		this.viewDrops = this.viewDropsOf()
		this.recreatedViews = new Set(
			this.viewDrops.flatMap((d) => (d.fate === "recreated" ? [d.key] : []))
		)
		this.dropped = new Set(this.viewDrops.flatMap((d) => (d.fate === "dropped" ? [d.key] : [])))
		/** What this migration takes away and builds again beneath the roles' objects without changing its DDL: each
		 * materialized view it drops (recreated or not), each object it drops before replacing a column it is built
		 * over, and each table a column of which it converts in place. */
		const tableKeys = new Map(
			[...previousObjects, ...targetObjects].flatMap((o) => {
				const v = installed(o)
				return v.kind === "table" ? [[nameKey(v.create.table), o.ident] as const] : []
			})
		)
		const convertedTables = this.convertedTables()
		const beneath = new Set([
			...this.viewDrops.map((d) => d.view.object.ident),
			...replacedBy.keys(),
			...convertedTables.flatMap((key) => {
				const ident = tableKeys.get(key)
				return ident === undefined ? [] : [ident]
			})
		])
		const worlds = worldChangesOf(input.previous.manifest, input.target.manifest, beneath)
		const viewKeys = new Set(this.viewDrops.map((d) => d.key))
		/** What takes a previous object away in Structure, if anything does. */
		const takenOf = (o: ManifestObject): Taken | undefined => {
			if (worlds.drops.has(o.ident)) {
				return { kind: "world" }
			}
			const on = objectTable(o)
			if (on !== undefined && viewKeys.has(nameKey(on))) {
				return { kind: "view" }
			}
			const replaced = replacedBy.get(o.ident)
			return replaced === undefined ? undefined : { kind: "replaced", ...replaced }
		}
		const taken = new Map(
			previousObjects.flatMap((o): ReadonlyArray<readonly [string, Taken]> => {
				const t = takenOf(o)
				return t === undefined ? [] : [[o.ident, t]]
			})
		)
		const arrivals = new Map<string, Arrival>()
		for (const o of previousObjects) {
			if (this.next.has(o.ident)) {
				const t = taken.get(o.ident)
				arrivals.set(o.ident, t === undefined ? { kind: "follows", before: o } : arrivalAfter(t))
			}
		}
		this.arrivals = arrivals
		/** Whether a previous object is removed by the target and taken away by no step of Structure. */
		const removed = (o: ManifestObject): boolean => !this.next.has(o.ident) && !taken.has(o.ident)
		/** The removed primary key of each table both install whose new primary key the target names anew (an aliased
		 * relation keeps its table and names its key anew): the target's swaps in for it. */
		const swapped = new Set<string>()
		for (const o of targetObjects) {
			const v = installed(o)
			if (v.kind !== "primaryKey" || !this.mayHoldRows(v.table)) {
				continue
			}
			const arrival = this.arrivalOf(o)
			if (arrival.kind !== "new" && !(arrival.kind === "replaced" && arrival.how === "redefined")) {
				continue
			}
			const prior = previousObjects.find((p) => {
				const w = installed(p)
				return w.kind === "primaryKey" && nameKey(w.table) === nameKey(v.table) && removed(p)
			})
			if (prior !== undefined) {
				swapped.add(prior.ident)
				arrivals.set(o.ident, { kind: "follows", before: prior })
			}
		}
		/** The removed foreign keys that reference a key the target swaps on a table that may hold rows, each with the
		 * target's key, the first in its install order: PostgreSQL refuses to drop a key a foreign key depends on
		 * (2BP01). */
		const unbound = new Map<string, string>()
		for (const o of targetObjects) {
			const v = installed(o)
			const arrival = this.arrivalOf(o)
			if (
				(v.kind !== "primaryKey" && v.kind !== "unique") ||
				arrival.kind !== "follows" ||
				!this.mayHoldRows(v.table)
			) {
				continue
			}
			const old = this.constraintOf(arrival.before, this.prev)
			if (same(old, keyOrCheckDefinition(v, this.next))) {
				continue
			}
			const key = keyBefore(v.table, constraintColumns(old))
			for (const p of previousObjects) {
				const w = installed(p)
				if (
					w.kind === "foreignKey" &&
					removed(p) &&
					!unbound.has(p.ident) &&
					referencedBefore(w.constraint) === key
				) {
					unbound.set(p.ident, o.ident)
				}
			}
		}
		this.previous = previousObjects.map((object, order): Previous => {
			const by = unbound.get(object.ident)
			const fate: Fate =
				taken.get(object.ident) ??
				(this.next.has(object.ident)
					? { kind: "kept" }
					: swapped.has(object.ident)
						? { kind: "swapped" }
						: by === undefined
							? { kind: "removed" }
							: { kind: "unbound", by })
			return { object, order, fate }
		})
		this.targets = targetObjects.map((object) => ({ object, arrival: this.arrivalOf(object) }))
		this.worldGone = new Set(
			this.previous.flatMap(({ object, fate }) => {
				if (fate.kind !== "world") {
					return []
				}
				const v = installed(object)
				return v.kind === "view" || v.kind === "worldFunction" ? [nameKey(v.create.name)] : []
			})
		)
		this.replaced = this.replacedKeysOf()
		this.keptPlans = new Map(
			[...this.keptTables].map(([ident, kept]) => [ident, this.planKept(kept)] as const)
		)
	}

	/** Each table both installations hold, by identity (KeptTable): the fate of each field of the previous table is its
	 * field change's (fieldChangesOf), converted, redefined where it is rewritten, kept otherwise, dropped where the
	 * target holds it no longer; of each law column, kept, redefined where its value changes, or dropped. */
	keptTablesOf(): ReadonlyMap<string, KeptTable> {
		const previousObjects = this.input.previous.manifest.objects
		const previousTables = new Map(
			previousObjects.flatMap((o, order) => {
				const v = installed(o)
				return v.kind === "table" ? [[o.ident, { old: v.create, order }] as const] : []
			})
		)
		const previousWritings = writingsByTable(this.input.previous.theory)
		const targetWritings = writingsByTable(this.input.target.theory)
		const lawColumnsByTable = new Map<
			string,
			Array<{
				readonly object: ManifestObject
				readonly column: Installed & { readonly kind: "lawColumn" }
			}>
		>()
		for (const p of previousObjects) {
			const w = installed(p)
			if (w.kind !== "lawColumn") {
				continue
			}
			const key = nameKey(w.table)
			const held = lawColumnsByTable.get(key)
			if (held === undefined) {
				lawColumnsByTable.set(key, [{ object: p, column: w }])
			} else {
				held.push({ object: p, column: w })
			}
		}
		return new Map(
			this.input.target.manifest.objects.flatMap(
				(o): ReadonlyArray<readonly [string, KeptTable]> => {
					const v = installed(o)
					const at = previousTables.get(o.ident)
					if (v.kind !== "table" || at === undefined) {
						return []
					}
					const { old, order } = at
					const create = v.create
					const key = nameKey(create.table)
					const changes = redrawn(
						fieldChangesOf(old.columns, create.columns, (b, c) => this.retyped(b, c)),
						previousWritings.get(create.table.name) ?? noWritings,
						targetWritings.get(create.table.name) ?? noWritings
					)
					const fields = old.columns.map((b): readonly [string, ColumnFate] => {
						const change = changes.get(b.name)
						if (change === undefined) {
							return [b.name, droppedColumn]
						}
						return [
							b.name,
							change.kind === "converted"
								? convertedColumn
								: change.kind === "rewritten"
									? redefinedColumn
									: keptColumn
						]
					})
					const lawColumns = (lawColumnsByTable.get(key) ?? []).map(({ object: p, column: w }) => {
						const now = this.next.get(p.ident)
						const fate =
							now === undefined
								? droppedColumn
								: same(p.ddl, now.ddl)
									? keptColumn
									: redefinedColumn
						const reads = builtOver(w, (c) => keyOrCheckDefinition(c, this.prev))?.columns ?? []
						return { column: w.column, reads, fate }
					})
					return [
						[
							o.ident,
							{
								object: o,
								order,
								old,
								create,
								fates: generatedOver(new Map(fields), lawColumns),
								changes
							}
						]
					]
				}
			)
		)
	}

	/** The tables of which this migration converts a field's column in place or drops and adds one again, by table key:
	 * PostgreSQL refuses either under a view that reads the column. */
	convertedTables(): ReadonlyArray<string> {
		return [...this.keptTables.values()].flatMap((k) =>
			[...k.changes.values()].some((c) => c.kind === "converted" || c.kind === "rewritten")
				? [nameKey(k.create.table)]
				: []
		)
	}

	/** What an object of the target is to this migration (Arrival): new when it follows no previous object. */
	arrivalOf(o: ManifestObject): Arrival {
		return this.arrivals.get(o.ident) ?? arrivedNew
	}

	/** A drafted step in its slot: in a slot that alters each table once, an alteration of a table merges into the
	 * table's one alteration there (alter); every other step stands where it is drafted. */
	push(slot: Slot, draft: Draft): void {
		if (isTableSlot(slot)) {
			const altered = alteredBy(draft)
			if (altered !== undefined) {
				this.alter(slot, altered.table, altered.actions)
				return
			}
		}
		this.drafting.push({ kind: "step", step: { slot, draft } })
	}

	/** `actions` added to the one alteration of `table` in `slot`, which stands at the place of the table's first
	 * subcommand there. A later subcommand moves up to it: what it reads is drafted before the table's first (its domains
	 * and constants in Setup or before every table, its table's columns in the alteration itself, which PostgreSQL adds
	 * pass by pass), and nothing between the two reads it but what reads the table, which may read it sooner. */
	alter(slot: TableSlot, table: ObjectName, actions: NonEmptyReadonlyArray<Alteration>): void {
		const key = nameKey(table)
		const held = this.alterations[slot].get(key)
		if (held !== undefined) {
			appendAll(held.rest, actions)
			return
		}
		const [first, ...rest] = actions
		const alteration: TableAlteration = { table, first, rest }
		this.alterations[slot].set(key, alteration)
		this.drafting.push({ kind: "alteration", slot, alteration })
	}

	/** A statement that keeps its own place in its slot, after the alteration of its table there: a foreign key onto a
	 * key its slot adds again, which its table's alteration may stand before (constrainedKeys). */
	apart(slot: Slot, s: SqlStatement): void {
		this.drafting.push({ kind: "step", step: { slot, draft: statement(s) } })
	}

	/** The steps drafted so far, each table's alteration at its place with every subcommand drafted until now. */
	drafted(): ReadonlyArray<Step> {
		return this.drafting.flatMap((d) => this.stepsOf(d))
	}

	/** The steps one drafting stands for: a step itself, a table's alteration as drafted until now, or a table's fill's. */
	stepsOf(d: Drafting): ReadonlyArray<Step> {
		switch (d.kind) {
			case "step":
				return [d.step]
			case "alteration":
				return [{ slot: d.slot, draft: alterationDraft(d.alteration, this.asideOf(d)) }]
			case "fill":
				return fillSteps(
					d.fill,
					this.alterations.structure.get(nameKey(d.fill.table)),
					asideColumnsOf(d.fill)
				)
		}
	}

	/** The set-aside fields an alteration's generated columns read through: its table's fill's, in Structure alone. */
	asideOf(d: Extract<Drafting, { readonly kind: "alteration" }>): AsideColumns {
		const fill = d.slot === "structure" ? this.fills.get(nameKey(d.alteration.table)) : undefined
		return fill === undefined ? noAside : asideColumnsOf(fill)
	}

	/** A field of `t` set aside (SetAside): its set-aside column added in the table's one Structure alteration, with no
	 * NOT NULL and no default, so it changes the catalog alone, and the field joined to the table's fill in
	 * structure.fill, which stands at the place of the table's first. */
	setAside(t: ObjectName, field: SetAside): void {
		this.alter("structure", t, [
			{
				kind: "addColumnUnchecked",
				column: {
					name: field.aside,
					type: field.column.type,
					collation: field.column.collation,
					generated: undefined
				}
			}
		])
		const key = nameKey(t)
		const held = this.fills.get(key)
		if (held !== undefined) {
			held.rest.push(field)
			return
		}
		const fill: TableFill = { table: t, first: field, rest: [] }
		this.fills.set(key, fill)
		this.drafting.push({ kind: "fill", fill })
	}

	sql(slot: Slot, statements: ReadonlyArray<SqlStatement>): void {
		for (const s of statements) {
			this.push(slot, statement(s))
		}
	}

	/** A drop of what the target no longer has, drafted in publish.removed at its place in the drop order (dropOrder) and
	 * its position `order` in the previous install order. */
	removal(rank: number, order: number, draft: Draft): void {
		this.removals.push({ rank, order, draft })
	}

	/** The identifier of a temporary this migration mints, as its census admits it (core/identity.ts TemporaryCensus):
	 * never a name an object standing while the migration runs has, nor another temporary's, so no statement under it
	 * creates, renames or drops an object that stands; a collision is refused as DigestCollision. */
	temporary<K extends TemporaryKind>(t: Identity<K>): string {
		const named = this.input.temporaries.admit(t)
		if (!named.ok) {
			throw new Refusal(named.error)
		}
		return named.value
	}

	/** The temporary name an index, or a key's index, is built under on `table` before it is swapped in for `name`: the
	 * naming door's (identity.swap), never a name of a live object, so the build's DROP INDEX ... IF EXISTS can never
	 * drop one; recorded as the plan's Swap, which the folder's laws read a refusal of the build by. */
	swapName(table: ObjectName, name: string): string {
		const swap = this.temporary(identity.swap(name))
		this.swaps.push({ table: table.name, name: swap, of: name })
		return swap
	}

	/** Whether the target's relation `name` holds rows before this migration runs: it follows the previous one, which
	 * stands; a new relation, and a materialized view dropped and created again, hold none. */
	mayHoldRows(name: ObjectName): boolean {
		const relation = this.next.get(tableIdent(name)) ?? this.next.get(viewIdent(name))
		return relation !== undefined && this.arrivalOf(relation).kind === "follows"
	}

	/** The previous object a target object follows (Arrival), which stands until its visit: none when it is new or
	 * created again, so the target's is drafted as new. */
	beforeOf(o: ManifestObject): ManifestObject | undefined {
		const arrival = this.arrivalOf(o)
		return arrival.kind === "follows" ? arrival.before : undefined
	}

	/** The definition of a table object; another kind has none. */
	createTableOf(o: ManifestObject): CreateTable | undefined {
		const v = installed(o)
		return v.kind === "table" ? v.create : undefined
	}

	/** The definition of a constraint object of `objects`' manifest: a foreign key's own, or a key's or CHECK's
	 * (keyOrCheckDefinition). Every caller passes a constraint object, so another kind refuses. */
	constraintOf(o: ManifestObject, objects: ReadonlyMap<string, ManifestObject>): TableConstraint {
		const v = installed(o)
		if (v.kind === "foreignKey") {
			return v.constraint
		}
		if (v.kind !== "primaryKey" && v.kind !== "unique" && v.kind !== "check") {
			return refuse(o.ident, "a table constraint")
		}
		return keyOrCheckDefinition(v, objects)
	}

	run(): MigrationPlan {
		for (const a of this.input.asides) {
			this.push("setup.drop", {
				kind: "confirm",
				note: `${asideWhy(a)}, so the draft renames it aside to ${quoteIdent(a.to)}${ownedAside(a)}; a declared rename takes it from there, or the end of this migration drops it, as declared`,
				instruction: `Keep the renames below and delete this line; they are one decision, kept or removed together`,
				keep: asideStatements(a)
			})
		}
		this.sql("setup.drop", this.input.renames)
		const { checks } = this.input
		this.migrationChecks(checks.migrations)
		this.dropWorlds()
		this.dropViews()
		this.dropReplaced()
		this.markAttached()
		for (const t of this.targets) {
			this.visit(t)
		}
		if (this.holdsDataSteps(this.backfill())) {
			this.push("structure.immediate", statement(checkedAtOnce))
		}
		this.ruleChecks(checks.rules)
		this.validations()
		for (const p of this.previous.toReversed()) {
			if (p.fate.kind === "removed") {
				this.remove(p.object, p.order)
			}
		}
		this.grants()
		this.defaults()
		this.draftRemovals()
		this.comments()
		return { steps: this.orderedSteps(), swaps: this.swaps }
	}

	orderedSteps(): ReadonlyArray<Step> {
		return this.drafted().toSorted(stepOrder)
	}

	/** The checks of the laws that read closed relations alone (violation.ts MigrationCheck), first in Setup, so they run
	 * in the transaction of the folder's first change and a violation leaves the catalog and the ledger as they were:
	 * each law's violation query over the rows the target states, raising with the law's identity when it returns a
	 * row. A law is checked exactly when the previous snapshot does not record its check as it is, so a law that is new,
	 * or whose rows changed, is checked once, and a regenerate checks nothing. */
	migrationChecks(checks: ReadonlyArray<MigrationCheck>): void {
		for (const c of checks) {
			const was = this.input.previous.theory.laws[c.law]
			if (was?.kind === "migration" && was.digest === c.digest) {
				continue
			}
			this.push("setup", { kind: "violation", law: c.law, query: c.query })
		}
	}

	/** The checks of the rules over queries (violation.ts lawChecks), in Validate, once every row the migration writes
	 * is written and before the rules' triggers are created: each rule's violation query over every row, raising with the
	 * rule's identity when it returns a row. A rule is checked exactly when the previous snapshot does not record its
	 * check as it is, so a rule that is new, or whose definition changed, is checked once, and a regenerate checks
	 * nothing. */
	ruleChecks(checks: ReadonlyArray<MigrationCheck>): void {
		for (const c of checks) {
			const was = this.input.previous.theory.laws[c.law]
			if (was?.kind === "trigger" && was.digest === c.digest) {
				continue
			}
			this.push("validate", { kind: "violation", law: c.law, query: c.query })
		}
	}

	/** The materialized views this migration drops first, decided once from the two manifests: each view whose
	 * definition changes, and every installed view above one of them or above a table whose column this migration
	 * converts in place, which PostgreSQL refuses to convert under a view that reads it. PostgreSQL refuses to drop a
	 * relation a view reads, so they go top-down (dropViews): one the target keeps is created again WITH NO DATA, and
	 * one it no longer has cannot outlive what it reads and is dropped with them. */
	viewDropsOf(): ReadonlyArray<ViewDrop> {
		const seeds = new Set<string>()
		for (const o of this.input.target.manifest.objects) {
			const v = installed(o)
			const before = this.prev.get(o.ident)
			if (v.kind === "materializedView" && before !== undefined && !same(o.ddl, before.ddl)) {
				seeds.add(relationKey(v))
			}
		}
		const dropping = new Set([
			...seeds,
			...this.viewsAbove(new Set([...seeds, ...this.convertedTables()]))
		])
		return this.input.previous.manifest.objects.flatMap((o): ReadonlyArray<ViewDrop> => {
			const v = installed(o)
			if (v.kind !== "materializedView") {
				return []
			}
			const key = relationKey(v)
			return dropping.has(key)
				? [
						{
							key,
							view: v,
							fate: this.next.has(o.ident) ? ("recreated" as const) : ("dropped" as const)
						}
					]
				: []
		})
	}

	/** Drafts the drops of the roles' views, world functions and policies (worldChangesOf), each policy before the
	 * function it calls, in reverse install order.
	 *
	 * One the target no longer holds is removed here; one it holds is created again when it is visited. */
	dropWorlds(): void {
		const drops: Array<Drop> = []
		for (const { object: o, fate } of this.previous.toReversed()) {
			if (fate.kind !== "world") {
				continue
			}
			const v = installed(o)
			if (v.kind === "policy") {
				drops.push({
					rank: dropOrder.policy,
					draft: statement({ kind: "dropPolicy", name: v.create.name, table: v.create.table })
				})
			} else if (v.kind === "view") {
				drops.push({
					rank: dropOrder.view,
					draft: statement({ kind: "drop", object: "VIEW", name: v.create.name, ifExists: false })
				})
			} else if (v.kind === "worldFunction") {
				drops.push({
					rank: dropOrder.worldFunction,
					draft: statement({
						kind: "dropFunction",
						name: functionNameOf(v.create),
						ifExists: false
					})
				})
			}
		}
		for (const d of drops.toSorted(byDropOrder)) {
			this.push("structure.drop", d.draft)
		}
	}

	/** Drafts the view drops (viewDropsOf), top-down; the indexes and statistics objects on each go with it (Taken
	 * view), and the target's are created again with a view it keeps. */
	dropViews(): void {
		const order = this.topDown(new Set(this.viewDrops.map((d) => d.key)))
		for (const d of this.viewDrops.toSorted(
			mapInput(compareNumbers, (x: ViewDrop) => order.indexOf(x.key))
		)) {
			this.sql("structure.drop", [dropObject(d.view)])
		}
	}

	/** The previous objects built over a column this migration replaces (ColumnFate converted or redefined), by identity,
	 * each with how and its own drop (Replaced): what is built over the column (objects.ts builtOver: a constraint, an
	 * index, a statistics object, a law column computed from it or a rule trigger fired by its update), and each foreign
	 * key referencing a key over one, which dropReplaced drops before the column is converted or dropped. */
	takenByReplacement(): ReadonlyMap<string, Replaced> {
		const out = new Map<string, Replaced>()
		/** How each of `columns` of `table` is replaced, of those this migration replaces: only a table both hold has
		 * a column replaced. */
		const hows = (
			table: ObjectName,
			columns: ReadonlyArray<string>
		): ReadonlyArray<Replacement> => {
			const kept = this.keptTables.get(tableIdent(table))
			if (kept === undefined) {
				return []
			}
			return columns.flatMap((c) => {
				const how = columnFate(kept, c).kind
				return how === "converted" || how === "redefined" ? [how] : []
			})
		}
		for (const o of this.prev.values()) {
			const over = builtOver(installed(o), (c) => keyOrCheckDefinition(c, this.prev))
			if (over === undefined) {
				continue
			}
			const v = over.part
			const how = strongestReplacement([
				...hows(over.table, over.columns),
				...(v.kind === "foreignKey"
					? hows(
							v.constraint.references,
							v.constraint.referencedColumns.map((k) => k.column)
						)
					: [])
			])
			if (how !== undefined) {
				out.set(o.ident, { how, drop: replacementDrop(v) })
			}
		}
		return out
	}

	/** Drafts the drop of everything a replacement of a column takes away (Taken replaced), each by its own statement, in
	 * structure.drop, before the column is converted in place or dropped and added again: the foreign keys and the rule
	 * triggers first, then the keys and CHECKs, the indexes, the statistics objects and the generated law columns
	 * (dropOrder). Nothing a replacement takes is left to the replacement itself, which converts or drops only the column;
	 * the target's are built again as on any relation that may hold rows. */
	dropReplaced(): void {
		const drops = this.previous
			.flatMap(({ fate }) => (fate.kind === "replaced" ? [fate.drop] : []))
			.toSorted(byDropOrder)
		for (const d of drops) {
			this.push("structure.drop", d.draft)
		}
	}

	/** The installed views that read one of `relations` (table keys), directly or through another view. */
	viewsAbove(relations: ReadonlySet<string>): ReadonlySet<string> {
		const out = new Set<string>()
		for (let grew = true; grew;) {
			const reached = [...this.reads].filter(
				([view, reads]) => !out.has(view) && [...reads].some((r) => relations.has(r) || out.has(r))
			)
			for (const [view] of reached) {
				out.add(view)
			}
			grew = reached.length > 0
		}
		return out
	}

	/** `views` in drop order: every view before the views it reads, and otherwise in the order given. */
	topDown(views: ReadonlySet<string>): ReadonlyArray<string> {
		const order: Array<string> = []
		const seen = new Set<string>()
		const visit = (key: string): void => {
			if (seen.has(key)) {
				return
			}
			seen.add(key)
			for (const reader of views) {
				if (this.reads.get(reader)?.has(key) === true) {
					visit(reader)
				}
			}
			order.push(key)
		}
		for (const key of views) {
			visit(key)
		}
		return order
	}

	/** Keys of relations that may hold rows that this migration attaches.
	 *
	 * A key a conversion took away is added again in Structure, right after it (ownConstraint). */
	markAttached(): void {
		for (const { object: o, arrival } of this.targets) {
			const v = installed(o)
			if ((v.kind !== "primaryKey" && v.kind !== "unique") || !this.mayHoldRows(v.table)) {
				continue
			}
			if (arrival.kind === "replaced" && arrival.how === "converted") {
				continue
			}
			const t = v.table
			const c = keyOrCheckDefinition(v, this.next)
			const before =
				arrival.kind === "follows" ? this.constraintOf(arrival.before, this.prev) : undefined
			if (before === undefined || !same(before, c)) {
				this.attached.add(keyAfter(t, constraintColumns(c)))
			}
		}
	}

	/** Drafts what one object of the target needs, by what it is to this migration (Arrival).
	 *
	 * The refusal function, the isolation guard and the snapshot guard, created in Setup and replaced there in place when
	 * their definition changes: a function's name and signature are its identity, so CREATE OR REPLACE keeps its grants.
	 *
	 * A serial field's advance function, created after its table, and replaced in place when its definition changes (the
	 * sequence it names renamed with its relation or field), which keeps its grants.
	 *
	 * A role's views, world functions and policies: created again when this migration dropped them at the start of
	 * Structure, since it changes them or what they read (worldChangesOf), in install order: at the end of Structure, in the transaction that dropped them, with
	 * their grants, when the role they serve stands before this migration (worldWithin); in Publish, after the
	 * roles and their schemas, when it creates the role.
	 *
	 * A role's schema and a table's row security are created once and never change.
	 *
	 * A role's membership in its login, granted once both roles stand; a role moved to another login leaves the old.
	 *
	 * A table's isolation trigger, created after its table: a renamed table carries it, and it is never altered.
	 * A table's guard, with its table: the ledger's in Setup, a relation's in Structure.
	 *
	 * grants() handles them by role.
	 *
	 * validations() handles them once every domain is visited. */
	visit({ object: o, arrival }: Target): void {
		const before = arrival.kind === "follows" ? arrival.before : undefined
		const v = installed(o)
		switch (v.kind) {
			case "schema":
				this.schemaObject(o, before)
				return
			case "refusalFunction":
			case "isolationFunction":
			case "snapshotGuard":
				if (before === undefined || !same(before.ddl, o.ddl)) {
					this.sql("setup", o.ddl)
				}
				return
			case "databaseDefault":
			case "ledger":
			case "extension":
				if (before === undefined) {
					this.sql("setup", o.ddl)
				} else if (!same(before.ddl, o.ddl)) {
					refuseUnsupported({
						loc: SourceLoc(`object ${o.ident}`, []),
						capability:
							"changing the installed schema, the migration identity or an extension's schema: a new installation"
					})
				}
				return
			case "constant":
				this.constantObject(v, before)
				return
			case "domain":
				this.domainObject(v, before)
				return
			case "table":
				this.tableObject(v)
				return
			case "lawColumn":
				this.lawColumn(v, before)
				return
			case "primaryKey":
			case "unique":
			case "check":
				this.ownConstraint(v, arrival)
				return
			case "foreignKey":
				this.foreignKey(v, before)
				return
			case "materializedView":
				this.view(v, before)
				return
			case "uniqueIndex":
			case "index":
				this.index(v, before)
				return
			case "statistics":
				this.statistics(v, before)
				return
			case "advanceFunction":
				if (before === undefined || !same(before.ddl, o.ddl)) {
					this.sql("structure", o.ddl)
				}
				return
			case "role":
				if (before === undefined) {
					this.roleObject(v)
				} else if (!same(before.ddl, o.ddl)) {
					refuseUnsupported({
						loc: SourceLoc(`object ${o.ident}`, []),
						capability: loginRoleExchange
					})
				}
				return
			case "view":
			case "worldFunction":
			case "policy":
				if (before !== undefined) {
					return
				}
				if (this.worldWithin(v)) {
					this.sql("structure.worlds", o.ddl)
					this.regrantWorld(v)
				} else {
					this.sql("publish.worlds", o.ddl)
				}
				return
			case "roleSchema":
			case "rowSecurity":
				if (before === undefined) {
					this.sql("publish.worlds", o.ddl)
				}
				return
			case "membership":
				if (before === undefined) {
					this.sql("publish.grants", o.ddl)
				} else if (!same(before.ddl, o.ddl)) {
					const was = installed(before)
					this.sql("publish.grants", [
						...(was.kind === "membership" ? [revokeRoleOf(was.grant)] : []),
						...o.ddl
					])
				}
				return
			case "isolationTrigger":
				if (before === undefined) {
					this.sql(o.phase === "setup" ? "setup" : "structure", o.ddl)
				}
				return
			case "lawFunction":
				if (before === undefined || !same(before.ddl, o.ddl)) {
					this.sql("validate", o.ddl)
				}
				return
			case "lawTrigger":
				if (before === undefined) {
					this.sql("validate", o.ddl)
				} else if (!same(before.ddl, o.ddl)) {
					this.sql("validate", [
						{ kind: "dropTrigger", name: v.create.name, table: v.create.table, ifExists: false },
						...o.ddl
					])
				}
				return
			case "privileges":
				return
			case "validation":
				return
		}
	}

	/** Whether a world object can be created again in Structure: a view whose role's schema the previous installation
	 * holds, a policy whose role it holds, and every world function, which names no role (its EXECUTE grant goes to a
	 * role this migration creates in Publish). */
	worldWithin(v: Installed & { readonly kind: "view" | "worldFunction" | "policy" }): boolean {
		switch (v.kind) {
			case "view":
				return this.prev.has(namedIdent("schema", v.create.name.schema))
			case "policy":
				return this.prev.has(namedIdent("role", v.create.role))
			case "worldFunction":
				return true
		}
	}

	/** The grants of a world object created again in Structure: its drop took them, so each grant of the target's
	 * privileges naming it is granted again right after it, to each grantee the previous installation holds (a role
	 * this migration creates is granted in Publish, as every grant is replaced there). */
	regrantWorld(v: Installed & { readonly kind: "view" | "worldFunction" | "policy" }): void {
		if (v.kind === "policy") {
			return
		}
		const key = nameKey(v.create.name)
		const grants = this.input.target.manifest.objects.flatMap((o) =>
			installed(o).kind === "privileges"
				? o.ddl.flatMap((g) => (g.kind === "grant" ? [g] : []))
				: []
		)
		for (const g of grants) {
			const on = g.on
			const to = g.to.filter((t) => t.kind === "role" && this.prev.has(namedIdent("role", t.name)))
			if (!isNonEmpty(to)) {
				continue
			}
			if (v.kind === "view" && on.kind === "TABLE") {
				const names = on.names.filter((n) => nameKey(n) === key)
				if (isNonEmpty(names)) {
					this.sql("structure.worlds", [{ ...g, on: { kind: "TABLE", names }, to }])
				}
			} else if (v.kind === "worldFunction" && on.kind === "FUNCTION") {
				const names = on.names.filter((n) => nameKey(n) === key)
				if (isNonEmpty(names)) {
					this.sql("structure.worlds", [{ ...g, on: { kind: "FUNCTION", names }, to }])
				}
			}
		}
	}

	/** A login's or a theory role's CREATE ROLE, in Publish. grizzle never sets a password, so a login dropped and created
	 * again under another name has none until its operator sets one. */
	roleObject(v: Installed & { readonly kind: "role" }): void {
		this.sql("publish.roles", [v.create])
	}

	/** The installed schema: created by the first migration, under the loss of the abandoned schemas' rows when the
	 * migrations directory holds any, and never changed. */
	schemaObject(o: ManifestObject, before: ManifestObject | undefined): void {
		if (before !== undefined) {
			if (!same(before.ddl, o.ddl)) {
				refuseUnsupported({
					loc: SourceLoc(`object ${o.ident}`, []),
					capability:
						"changing the installed schema, the migration identity or an extension's schema: a new installation"
				})
			}
			return
		}
		const [create, ...rest] = o.ddl
		const abandoned = this.input.abandoned
		if (
			create === undefined ||
			!isNonEmpty(abandoned) ||
			o.ident !== namedIdent("schema", this.schema)
		) {
			this.sql("setup", o.ddl)
			return
		}
		this.push("setup", {
			kind: "loss",
			loses: { kind: "schema", schema: this.schema, abandoned },
			statement: create
		})
		this.sql("setup", rest)
	}

	/** A constant the target installs. Its name is its content's digest, so one the previous installation holds under
	 * its name holds its content: it stands, and a changed content is a new constant, created in Setup before anything
	 * reads it, the previous one dropped once nothing reads it (publish.removed). A function is never replaced in place,
	 * because a domain's planned check keeps the constant it folded. A constant of one name whose statement is another's,
	 * its hex literal or its comment's count and digest, is a snapshot whose name does not digest its content: every
	 * constant has one statement, so equal content prints alike. */
	constantObject(
		v: Installed & { readonly kind: "constant" },
		before: ManifestObject | undefined
	): void {
		if (before === undefined) {
			this.sql("setup", v.object.ddl)
			return
		}
		const was = installed(before)
		if (
			was.kind !== "constant" ||
			!same(was.create, v.create) ||
			!same(before.ddl.slice(1), v.object.ddl.slice(1))
		) {
			refuse(before.ident, "a constant whose name digests what it installs")
		}
	}

	domainObject(
		v: Installed & { readonly kind: "domain" },
		before: ManifestObject | undefined
	): void {
		const { object: o } = v
		const create = v.create
		if (before === undefined) {
			this.sql("setup", o.ddl)
			return
		}
		const was = installed(before)
		if (was.kind !== "domain") {
			refuse(before.ident, "a CREATE DOMAIN")
		}
		if (
			!same(
				{ b: was.create.base, c: was.create.collation },
				{ b: create.base, c: create.collation }
			)
		) {
			refuseUnsupported({
				loc: SourceLoc(`domain ${printObjectName(create.name)}`, []),
				capability:
					"changing the base type of a domain, which changes the type of every column it types: a custom migration"
			})
		}
		/** The domain's one constraint replaced in place under its name: dropped, then added NOT VALID, so a domain never
		 * holds two constraints, and validated against the stored values once Structure has converted what it must. */
		const a = was.constraint
		const b = v.constraint
		if (a !== undefined && b !== undefined && same(a, b)) {
			return
		}
		if (a === undefined && b === undefined) {
			return
		}
		this.reconstrained.add(nameKey(create.name))
		if (a !== undefined) {
			this.sql("structure", [
				{
					kind: "alterDomain",
					name: create.name,
					action: { kind: "dropConstraint", name: a.name }
				}
			])
		}
		if (b !== undefined) {
			this.sql("structure", [
				{
					kind: "alterDomain",
					name: create.name,
					action: { kind: "addConstraint", constraint: b, notValid: true }
				}
			])
			this.sql("validate", [
				{
					kind: "alterDomain",
					name: create.name,
					action: { kind: "validateConstraint", name: b.name }
				}
			])
		}
	}

	/** A kept table as its visit drafts it (KeptPlan): its fields paired by name, a field the target lacks removed, one
	 * the previous declaration lacks added; and each identity sequence of a field both hold whose identity stays, which
	 * the target may name otherwise. A declared rename renamed every field and relation before the diff, so a field of
	 * one name is one field. */
	planKept(kept: KeptTable): KeptPlan {
		const t = kept.create.table
		const old = kept.old.columns
		const before = partsAt(this.prevParts, t).sequence
		const after = partsAt(this.nextParts, t).sequence
		const sequences = [...before.values()].flatMap((was) => {
			const now = [...after.values()].find((s) => s.column === was.column)
			return now !== undefined && columnFate(kept, was.column).kind === "kept" ? [{ was, now }] : []
		})
		return {
			table: kept,
			removed: old.filter((c) => !kept.create.columns.some((x) => x.name === c.name)),
			fields: kept.create.columns.map((c) => {
				const was = old.find((x) => x.name === c.name)
				return was === undefined
					? ({ kind: "added", column: c } as const)
					: ({ kind: "held", column: c, was } as const)
			}),
			sequences
		}
	}

	/** An installation's validation statements, such as the refined constants' casts to their domains: queries that
	 * install nothing, so their statements run whenever what they validate may have changed. That is when the object is
	 * new or its statements changed, such as a closed fact's payload, or when a domain they cast to takes a new
	 * constraint in this migration, a pattern or predicate change that validates the closed facts as well as the
	 * existing rows. They run in Publish, once every constraint is in place, so each constant is judged by the target's
	 * constraints, and one the target refuses fails the Publish transaction with 23514 naming its constraint. They are
	 * drafted once every domain is visited, whatever the manifest's order, so every replaced constraint is known. */
	validations(): void {
		for (const o of this.input.target.manifest.objects) {
			if (o.kind !== "validation") {
				continue
			}
			const before = this.prev.get(o.ident)
			const changed = before === undefined || !same(before.ddl, o.ddl)
			const recast = [...qualifiedNames(o.ddl, this.levelSchemas)].some((k) =>
				this.reconstrained.has(k)
			)
			if (changed || recast) {
				this.sql("publish", o.ddl)
			}
		}
	}

	/** A table: one the previous installation lacks created; one both hold changed field by field (keptTable). */
	tableObject(v: Installed & { readonly kind: "table" }): void {
		const plan = this.keptPlans.get(v.object.ident)
		if (plan === undefined) {
			this.sql("structure", [v.create])
			return
		}
		this.keptTable(plan)
	}

	/** A table both installations hold, as planned (KeptPlan). Each removed column, which the migration declares
	 * dropped, is dropped at the end of the migration, once nothing reads it any longer.
	 *
	 * DROP IDENTITY drops the sequence, and its privileges with it. */
	keptTable({ table: kept, removed, fields, sequences }: KeptPlan): void {
		const t = kept.create.table
		for (const r of removed) {
			this.removal(
				dropOrder.column,
				kept.order,
				statement(alter(t, [{ kind: "dropColumn", column: r.name }]))
			)
		}
		this.sql(
			"structure",
			sequences.flatMap((p): ReadonlyArray<SqlStatement> =>
				changeOf(kept.changes, p.now.column).kind === "kept" &&
				nameKey(p.was.sequence) !== nameKey(p.now.sequence)
					? [{ kind: "rename", object: "SEQUENCE", name: p.was.sequence, to: p.now.name }]
					: []
			)
		)
		for (const f of fields) {
			if (f.kind === "added") {
				this.alter("structure", t, [this.addedField(t, f.column)])
				continue
			}
			this.changeField(t, f.was, f.column, changeOf(kept.changes, f.column.name))
		}
	}

	/** What a field both tables hold drafts for its change from `b` to `c` (fieldChangesOf), besides the rename of its
	 * identity sequence, which its table's visit drafts before its alteration (keptTable): a rewritten field dropped before
	 * anything is converted, in structure.drop, since PostgreSQL refuses to convert a column a generated column reads,
	 * and added again once the conversions ran (rewriteField); a kept one, nothing; otherwise its steps in place
	 * (changeInPlace). */
	changeField(t: ObjectName, b: ColumnDef, c: ColumnDef, change: FieldChange): void {
		if (change.kind === "rewritten") {
			this.rewriteField(t, b, c)
			return
		}
		if (change.kind === "kept") {
			return
		}
		this.changeInPlace(t, b, c, change)
	}

	/** A field of `t` dropped and added again, its writing changed between its caller and a generation, or a generated
	 * field's type changed or a field it reads converted (fieldChange): its drop, in structure.drop, before anything is
	 * converted, the values its caller wrote going as the schema now declares; then its addition in Structure, a
	 * generated field by its expression and one its caller writes by the reviewer's placeholder. Every object built over
	 * the column is dropped before it (dropReplaced) and built again as the target declares it (ColumnFate redefined). */
	rewriteField(t: ObjectName, b: ColumnDef, c: ColumnDef): void {
		this.sql("structure.drop", [alter(t, [{ kind: "dropColumn", column: b.name }])])
		this.alter("structure", t, [this.addedField(t, c)])
	}

	/** The addition of a field to a table that may hold rows: a column its family draws under its placeholder default,
	 * which the backfill overwrites (drawnColumn); a generated field by its expression, which computes every row; any
	 * other by the reviewer's value for every row, at its placeholder. */
	addedField(t: ObjectName, c: ColumnDef): Alteration {
		const drawn = this.drawnColumn(t, c)
		if (drawn !== undefined) {
			return drawn
		}
		return c.generated === undefined
			? { kind: "placeholderColumn", column: c }
			: { kind: "addColumn", column: c }
	}

	/** The ADD COLUMN of a column of `t` its family draws, when `t` may hold rows: under the placeholder default the value
	 * an empty family holds, recorded for the backfill (backfill.ts), which draws it over the stored rows and then drops
	 * the default. A column no family draws, or one added to a table that holds no row, takes none. */
	drawnColumn(t: ObjectName, c: ColumnDef): Alteration | undefined {
		const key = nameKey(t)
		const value = this.drawn.get(key)?.get(c.name)
		if (value === undefined || c.generated !== undefined || !this.mayHoldRows(t)) {
			return undefined
		}
		const had = this.backfilled.get(key)
		this.backfilled.set(key, { table: t, columns: [...(had?.columns ?? []), c.name] })
		return { kind: "addColumnDefault", column: c, default: value }
	}

	/** The backfill of the families new to stored rows (backfill.ts), once every column it draws is added: its UPDATEs,
	 * then each drawn column's DROP DEFAULT, before any constraint that reads them (structure.constraints). */
	backfill(): boolean {
		const previousTables = new Map(
			this.input.previous.manifest.objects.flatMap((o) => {
				const v = installed(o)
				return v.kind === "table" ? [[nameKey(v.create.table), v.create] as const] : []
			})
		)
		const { updates, dropDefaults } = backfillOf({
			installation: this.input.installation,
			previous: this.input.previous.theory,
			previousOperators: (table, column) => {
				const at = previousTables.get(nameKey(objectName(this.input.previous.schema, table)))
				const c = at?.columns.find((x) => x.name === column)
				if (c === undefined) {
					throw defect(
						`the previous snapshot installs the column ${column} its relation ${table} records`
					)
				}
				return columnOperators(c.type, this.prevDomains)
			},
			mayHoldRows: (t) => this.mayHoldRows(t),
			added: this.backfilled
		})
		this.sql("structure.backfill", [...updates, ...dropDefaults])
		return updates.length > 0
	}

	/** Whether Structure holds a data step: a reviewer's UPDATE a placeholder column invites, a fill, or the backfill's
	 * (`backfilled`). Each runs after SET CONSTRAINTS ALL IMMEDIATE (checkedAtOnce, structure.immediate), before which
	 * Structure runs no UPDATE: its drops and its tables' alterations, which write no row. */
	holdsDataSteps(backfilled: boolean): boolean {
		return (
			backfilled ||
			this.fills.size > 0 ||
			[...this.alterations.structure.values()].some((a) =>
				[a.first, ...a.rest].some((x) => x.kind === "placeholderColumn")
			)
		)
	}

	/** The steps of a field's change in place from `b` to `c` (inPlace), its conversion by its cast or its placeholder
	 * (conversion). */
	changeInPlace(t: ObjectName, b: ColumnDef, c: ColumnDef, change: FieldChange): void {
		const planned = inPlace(
			t,
			b,
			c,
			change,
			(column) => this.conversion(b, column),
			(column) => this.addedField(t, column)
		)
		if (planned.kind === "setAside") {
			this.setAside(t, {
				column: c,
				aside: this.temporary(identity.aside(`${t.name}.${c.name}`)),
				reason: planned.reason
			})
			return
		}
		for (const step of planned.steps) {
			this.push("structure", step)
		}
	}

	/** Whether a column's type changes from `was`, read through the previous installation's domains, to `column`, read
	 * through the target's: as spelled, or by the roster its values are handles of (rosterOf), so a set whose domain
	 * keeps its name over a roster that does not continue its own, under a name a rename takes, is converted. */
	retyped(was: ColumnDef, column: ColumnDef): boolean {
		return (
			typeChanged(was, column) ||
			!sameRoster(rosterOf(was.type, this.prevDomains), rosterOf(column.type, this.nextDomains))
		)
	}

	/** Whether the previous column `was` and the target's `column` hold the same values (representationOf), each type
	 * read through its own installation's domains: a cast from one to the other keeps every value. */
	keepsValues(was: ColumnDef, column: ColumnDef): boolean {
		return (
			representationOf(was.type, was.collation, this.prevDomains) ===
			representationOf(column.type, column.collation, this.nextDomains)
		)
	}

	/** The bit length a set grows to, when the column `was` before and `column` after are sets over one roster, the
	 * previous one's roster continuing as the target's (setOf), bit(n) before and bit(n′) after, n′ > n: its codes carry
	 * on and only append, so a set's bit for code c stays at position c, and the roster's new codes are absent from every
	 * stored set. Undefined for any other conversion. */
	grownSet(was: ColumnDef, column: ColumnDef): number | undefined {
		const before = setOf(was.type, this.prevDomains)
		const after = setOf(column.type, this.nextDomains)
		return before !== undefined &&
			after !== undefined &&
			continuesAs(before.roster, after.roster) &&
			after.length > before.length
			? after.length
			: undefined
	}

	/** The conversion in place of the column `column` of `t`, of the previous column `was`, to `column`'s type: by its
	 * cast when the two hold the same values (keepsValues), so only the laws of their domains change and the new ones
	 * judge the stored values as the cast runs; a set over a roster that grew, by its cast to the wider bit(n′), which
	 * pads every stored set with zeros on the right, the new codes absent, before the new domain judges it (grownSet);
	 * otherwise by the expression the reviewer writes at its placeholder, a closed id or a set moved to a roster its own
	 * does not continue as among them, whose codes would otherwise be read as another roster's handles. */
	conversion(was: ColumnDef, column: ColumnDef): ColumnConversion {
		const grown = this.grownSet(was, column)
		if (grown !== undefined) {
			return {
				kind: "alterColumnType",
				column: column.name,
				type: column.type,
				collation: column.collation,
				using: { kind: "expr", expr: cast(tableCol(column.name), types.bit(grown)) }
			}
		}
		if (!this.keepsValues(was, column)) {
			return {
				kind: "placeholderRetype",
				reason:
					rosterOf(was.type, this.prevDomains) === undefined &&
					rosterOf(column.type, this.nextDomains) === undefined
						? "values"
						: "roster"
			}
		}
		return {
			kind: "alterColumnType",
			column: column.name,
			type: column.type,
			collation: column.collation,
			using: { kind: "expr", expr: cast(tableCol(column.name), column.type) }
		}
	}

	/** A column a law adds: added with its table's other objects, kept while its definition is the previous one's, and
	 * dropped and added again when it changes. */
	lawColumn(
		v: Installed & { readonly kind: "lawColumn" },
		before: ManifestObject | undefined
	): void {
		const { object: o, table: t, column } = v
		if (before !== undefined) {
			if (same(before.ddl, o.ddl)) {
				return
			}
			this.sql("structure", [alter(t, [{ kind: "dropColumn", column }])])
		}
		const drawn = this.drawnColumn(t, v.definition)
		if (drawn === undefined) {
			this.sql("structure", o.ddl)
		} else {
			this.alter("structure", t, [drawn])
		}
	}

	/** A primary key, candidate key or CHECK of a table, by what it is to this migration (Arrival).
	 *
	 * A key over a column converted in place, which dropReplaced dropped before the conversion, is added again in the
	 * same Structure transaction after it, under the conversion's lock, so the key holds at every commit: built
	 * concurrently, it would hold no row written between Structure and Validate, a law that held before and after
	 * broken in between. A CHECK added NOT VALID holds every new row already. Both go in structure.constraints, after
	 * the backfill has drawn every value they read (backfill.ts).
	 *
	 * A table holds one primary key: one the target names anew on a table it keeps (an aliased relation's) follows the
	 * removed one (Fate swapped), which it replaces in the same ALTER TABLE, the old dropped before the new is added. */
	ownConstraint(
		v: Installed & { readonly kind: "primaryKey" | "unique" | "check" },
		arrival: Arrival
	): void {
		const { object: o, table: t } = v
		const c = keyOrCheckDefinition(v, this.next)
		if (!this.mayHoldRows(t)) {
			if (v.placement.kind === "own") {
				this.sql("structure", o.ddl)
			}
			return
		}
		if (arrival.kind === "replaced" && arrival.how === "converted" && c.kind !== "check") {
			this.constrainedKeys.add(keyAfter(t, constraintColumns(c)))
			this.sql("structure.constraints", [
				alter(t, [{ kind: "addConstraint", constraint: c, notValid: false }])
			])
			return
		}
		const was = arrival.kind === "follows" ? arrival.before : undefined
		const old = was === undefined ? undefined : this.constraintOf(was, this.prev)
		if (old !== undefined && same(old, c)) {
			return
		}
		const replace = old !== undefined
		const replacingOld = (add: AlterTableAction): NonEmptyReadonlyArray<AlterTableAction> =>
			old === undefined ? [add] : [{ kind: "dropConstraint", name: old.name }, add]
		if (c.kind === "check") {
			this.sql("structure.constraints", [
				alter(
					t,
					replacing(replace, c.name, {
						kind: "addConstraint",
						constraint: c,
						notValid: true
					})
				)
			])
			this.sql("validate", [alter(t, [{ kind: "validateConstraint", name: c.name }])])
			return
		}
		const key = btreeKeyOf(c)
		if (key === undefined) {
			if (was !== undefined) {
				this.unbind(o.ident, was.ident)
			}
			this.sql("validate.attach", [
				alter(
					t,
					replacingOld({
						kind: "addConstraint",
						constraint: c,
						notValid: false
					})
				)
			])
			return
		}
		const index = replace ? this.swapName(t, c.name) : c.name
		this.buildConcurrently({
			kind: "createIndex",
			name: index,
			table: t,
			unique: true,
			method: "btree",
			keys: mapNonEmpty(key.columns, (k) => columnKey(k.column)),
			concurrently: false,
			include: [],
			where: undefined
		})
		if (was !== undefined) {
			this.unbind(o.ident, was.ident)
		}
		this.sql("validate.attach", [
			alter(
				t,
				replacingOld({
					kind: "addConstraintUsingIndex",
					name: c.name,
					constraint: c.kind === "primaryKey" ? "PRIMARY KEY" : "UNIQUE",
					index
				})
			)
		])
	}

	/** The foreign keys that reference the key the target's key `key` swaps in for, the previous `was`, dropped just
	 * before the key is swapped in the same Validate file, since PostgreSQL refuses to drop a key a foreign key depends
	 * on (2BP01): each removed one (Fate unbound), since a removed law cannot be enforced natively once its key is gone,
	 * so it is dropped here rather than in publish.drop; and each one the target keeps unchanged (rebind). A foreign key
	 * the target changes is foreignKey()'s. */
	unbind(key: string, was: string): void {
		for (const { object: o, fate } of this.previous) {
			const v = installed(o)
			if (fate.kind === "unbound" && fate.by === key && v.kind === "foreignKey") {
				this.sql("validate.attach", [alter(v.table, [{ kind: "dropConstraint", name: v.name }])])
			}
		}
		this.rebind(was)
	}

	/** The keys of tables both snapshots install whose index this migration drops in Validate while the table holds
	 * rows, by identity: each removed key, and each the target replaces under its name (ownConstraint), that stands over
	 * the columns of a key the target declares there (keyImage), such as a candidate key that becomes the primary key, or
	 * a primary key moved to other fields while a candidate key takes its old ones. A key a conversion takes away (Taken
	 * replaced) is dropped before the conversion, and is none of them. */
	replacedKeysOf(): ReadonlyMap<string, ReplacedKey> {
		const out = new Map<string, ReplacedKey>()
		for (const { object: o, fate } of this.previous) {
			if (fate.kind === "replaced") {
				continue
			}
			const v = installed(o)
			const kept =
				v.kind === "primaryKey" || v.kind === "unique"
					? this.keptTables.get(tableIdent(v.table))
					: undefined
			if ((v.kind !== "primaryKey" && v.kind !== "unique") || kept === undefined) {
				continue
			}
			const t = v.table
			const c = keyOrCheckDefinition(v, this.prev)
			const now = this.next.get(o.ident)
			if (now !== undefined && same(this.constraintOf(now, this.next), c)) {
				continue
			}
			const targetKeys = new Set(
				[...partsAt(this.nextParts, t).constraint.values()].flatMap((k) =>
					k.constraint.kind === "primaryKey" || k.constraint.kind === "unique"
						? [keyAfter(t, constraintColumns(k.constraint))]
						: []
				)
			)
			const image = this.keyImage(kept, c)
			const beside = new Set(image !== undefined && targetKeys.has(image) ? [image] : [])
			if (beside.size > 0) {
				out.set(o.ident, { before: keyBefore(t, constraintColumns(c)), beside })
			}
		}
		return out
	}

	/** The key over the columns of the previous key `key` of the kept table `kept`, in the target's names: the same
	 * columns, each a field or law column the target holds there (a declared rename renamed every one before the diff);
	 * none when the target holds one of them no longer. */
	keyImage(kept: KeptTable, key: TableConstraint): KeyAfter | undefined {
		const t = kept.create.table
		const tags = partsAt(this.nextParts, t).column
		const columns = constraintColumns(key)
		return columns.every((c) => kept.create.columns.some((x) => x.name === c) || tags.has(c))
			? keyAfter(t, columns)
			: undefined
	}

	/** Whether a key the target declares, over the columns `key` names, may stand beside a key it replaces (replaced). */
	replaces(key: KeyAfter): boolean {
		return [...this.replaced.values()].some((r) => r.beside.has(key))
	}

	/** Whether a foreign key of the previous snapshot references a key the target's replaces (replaced). */
	referencesReplaced(fk: ForeignKey): boolean {
		const key = referencedBefore(fk)
		return [...this.replaced.values()].some((r) => r.before === key)
	}

	/** A removed key of a table both snapshots install that a key the target declares on it may replace (replaced). A
	 * foreign key referencing those columns depends on whichever unique index PostgreSQL found first when it was
	 * created, the old key's included, and then refuses the old key's drop (2BP01). The two keys enforce one uniqueness,
	 * so the old one is dropped in Validate, after the target's is attached and before the foreign keys over those
	 * columns are added (foreignKey): each removed foreign key that references it is dropped before it (remove), and each
	 * one the target keeps unchanged as well (rebind). */
	replacedKey(o: ManifestObject, name: string, t: ObjectName): boolean {
		if (!this.replaced.has(o.ident)) {
			return false
		}
		this.rebind(o.ident)
		this.sql("validate.attach", [alter(t, [{ kind: "dropConstraint", name }])])
		return true
	}

	/** The foreign keys the target keeps unchanged over a key it declares beside the key `ident`, which this migration
	 * drops in Validate (replaced): each may depend on the dropped key's index, which PostgreSQL then refuses to drop
	 * (2BP01), so it is dropped before it and added again after the target's keys are attached, NOT VALID and validated,
	 * so every reference depends on the target's key.
	 *
	 * A foreign key foreignKey() drafts again already follows the target's key. */
	rebind(ident: string): void {
		const replaced = this.replaced.get(ident)
		if (replaced === undefined) {
			return
		}
		for (const x of this.input.target.manifest.objects) {
			const before = this.beforeOf(x)
			const v = installed(x)
			if (
				v.kind !== "foreignKey" ||
				before === undefined ||
				!replaced.beside.has(referencedAfter(v.constraint))
			) {
				continue
			}
			const { table: source, constraint: fk } = v
			if (!same(this.constraintOf(before, this.prev), fk)) {
				continue
			}
			this.sql("validate.attach", [alter(source, [{ kind: "dropConstraint", name: fk.name }])])
			this.sql("validate", [
				alter(source, [{ kind: "addConstraint", constraint: fk, notValid: true }])
			])
			this.sql("validate", [alter(source, [{ kind: "validateConstraint", name: fk.name }])])
		}
	}

	buildConcurrently(index: CreateIndex): void {
		const name = objectName(index.table.schema, index.name)
		this.sql("indexes.concurrent", [
			{ kind: "dropIndex", name, concurrently: true, ifExists: true },
			{ ...index, concurrently: true }
		])
	}

	/** A table that holds no row takes it validated at once, as `addTables` installs it. In structure.constraints it
	 * joins its table's one alteration there, but onto a key that slot adds again (constrainedKeys), whose table's
	 * alteration its own may stand before: then it is its own statement, after the key's, where it is drafted. */
	foreignKey(
		v: Installed & { readonly kind: "foreignKey" },
		before: ManifestObject | undefined
	): void {
		const { table: t, constraint: c } = v
		if (before !== undefined) {
			if (same(this.constraintOf(before, this.prev), c)) {
				return
			}
			this.sql("structure", [alter(t, [{ kind: "dropConstraint", name: c.name }])])
		}
		const add = (notValid: boolean): SqlStatement =>
			alter(t, [{ kind: "addConstraint", constraint: c, notValid }])
		const constrained = (s: SqlStatement): void => {
			if (this.constrainedKeys.has(referencedAfter(c))) {
				this.apart("structure.constraints", s)
			} else {
				this.sql("structure.constraints", [s])
			}
		}
		const afterKey = this.attached.has(referencedAfter(c)) || this.replaces(referencedAfter(c))
		if (!this.mayHoldRows(t) && !afterKey) {
			constrained(add(false))
			return
		}
		if (afterKey) {
			this.sql("validate", [add(true)])
		} else {
			constrained(add(true))
		}
		this.sql("validate", [alter(t, [{ kind: "validateConstraint", name: c.name }])])
	}

	/** A materialized view, created WITH NO DATA when it follows no previous view (Arrival): new, or dropped at the start
	 * of Structure (viewDropsOf). One that stands has the target's definition, since a changed one is dropped. It is
	 * created in structure.views, after every table's fill, so it reads each set-aside field under its name, as the fill
	 * leaves it, never the column the fill drops. */
	view(
		v: Installed & { readonly kind: "materializedView" },
		before: ManifestObject | undefined
	): void {
		if (before === undefined) {
			this.sql("structure.views", v.object.ddl)
		}
	}

	index(
		v: Installed & { readonly kind: "index" | "uniqueIndex" },
		before: ManifestObject | undefined
	): void {
		const { object: o, create } = v
		const t = create.table
		if (before !== undefined && same(before.ddl, o.ddl)) {
			return
		}
		if (!this.mayHoldRows(t)) {
			this.sql(
				o.phase === "structure"
					? this.next.has(viewIdent(t))
						? "structure.views"
						: "structure"
					: "indexes",
				o.ddl
			)
			return
		}
		if (before === undefined) {
			this.buildConcurrently(create)
			return
		}
		/** A changed index on a relation that may hold rows: built under a temporary name, then swapped in. */
		const next = this.swapName(t, create.name)
		this.buildConcurrently({ ...create, name: next })
		this.sql("validate.attach", [
			{
				kind: "dropIndex",
				name: objectName(t.schema, create.name),
				concurrently: false,
				ifExists: false
			},
			{ kind: "rename", object: "INDEX", name: objectName(t.schema, next), to: create.name }
		])
	}

	statistics(
		v: Installed & { readonly kind: "statistics" },
		before: ManifestObject | undefined
	): void {
		const { object: o, create } = v
		if (before !== undefined && same(before.ddl, o.ddl)) {
			return
		}
		if (before !== undefined) {
			this.push("indexes", { kind: "dropStatistics", name: create.name })
		}
		this.sql("indexes", [create])
		if (this.mayHoldRows(create.table)) {
			this.push("indexes", { kind: "analyze", table: create.table })
		}
	}

	/** An object the target no longer has and no step takes away first (Fate removed), dropped in place: in
	 * publish.removed (draftRemovals) at its kind's rank, once nothing of the target reads it; a constraint of a table
	 * that stays in publish.drop, before; and what belongs to a dropped table with no statement of its own.
	 *
	 * Extensions and the database's defaults outlive the schema, which another schema may share them with;
	 * grants are replaced per role in grants().
	 *
	 * Dropped at the start of Structure (dropWorlds).
	 *
	 * Both roles still stand when grants are replaced; a role dropped at the end takes it along anyway.
	 *
	 * A validation installs nothing, so nothing is dropped.
	 *
	 * A stored relation's drop loses its rows, which the migration declares (`--drop`).
	 *
	 * A removed table's own constraints go with it; a reference out of it is dropped first, with every other
	 * removed reference, so no drop of a key it references waits on it: in Validate, before the key, when the
	 * key it references is a removed one the target's replaces (replacedKey), which the removal order, every
	 * foreign key before the keys, drafts first.
	 *
	 *
	 * A table's isolation trigger goes with its table, or is dropped on its own where the target guards its table no
	 * more: every role that writes it is certified READ COMMITTED (physical/ddl/isolation.ts readCommittedRelations). */
	remove(o: ManifestObject, order: number): void {
		const t = objectTable(o)
		const tableGone =
			t !== undefined && !this.next.has(tableIdent(t)) && !this.next.has(viewIdent(t))
		const v = installed(o)
		const drop = (kind: Dropped, d: Action): void => {
			this.removal(dropOrder[kind], order, d)
		}
		switch (v.kind) {
			case "schema":
				if (o.ident === namedIdent("schema", this.schema)) {
					throw new Refusal(
						unsupported(SourceLoc(`object ${o.ident}`, []), "removing the installed schema")
					)
				}
				drop(
					v.kind,
					statement({ kind: "drop", object: "SCHEMA", name: schemaOf(o), ifExists: false })
				)
				return
			case "ledger":
				throw new Refusal(
					unsupported(SourceLoc(`object ${o.ident}`, []), "removing the installed schema's ledger")
				)
			case "extension":
			case "privileges":
			case "databaseDefault":
				return
			case "view":
			case "worldFunction":
			case "policy":
				return
			case "roleSchema":
				drop(
					v.kind,
					statement({ kind: "drop", object: "SCHEMA", name: v.create.name, ifExists: false })
				)
				return
			case "rowSecurity":
				if (!tableGone) {
					drop(v.kind, statement(alter(v.table, [{ kind: "disableRowSecurity" }])))
				}
				return
			case "membership":
				this.sql("publish.grants", [revokeRoleOf(v.grant)])
				return
			case "validation":
				return
			case "domain":
			case "materializedView":
				drop(v.kind, statement(dropObject(v)))
				return
			case "constant":
				drop(
					v.kind,
					statement({ kind: "dropFunction", name: constantName(v.create), ifExists: false })
				)
				return
			case "table":
				drop(v.kind, statement(dropObject(v)))
				return
			case "refusalFunction":
			case "advanceFunction":
			case "isolationFunction":
			case "snapshotGuard":
			case "lawFunction":
				drop(
					v.kind,
					statement({ kind: "dropFunction", name: functionNameOf(v.create), ifExists: false })
				)
				return
			case "lawTrigger":
				if (!tableGone) {
					drop(
						v.kind,
						statement({
							kind: "dropTrigger",
							name: v.create.name,
							table: v.create.table,
							ifExists: false
						})
					)
				}
				return
			case "lawColumn":
				if (!tableGone) {
					drop(v.kind, statement(alter(v.table, [{ kind: "dropColumn", column: v.column }])))
				}
				return
			case "primaryKey":
			case "unique":
			case "check":
			case "foreignKey": {
				if (tableGone && v.kind !== "foreignKey") {
					return
				}
				if (v.kind === "foreignKey" && this.referencesReplaced(v.constraint)) {
					this.sql("validate.attach", [alter(v.table, [{ kind: "dropConstraint", name: v.name }])])
					return
				}
				if (this.replacedKey(o, v.name, v.table)) {
					return
				}
				this.sql("publish.drop", [alter(v.table, [{ kind: "dropConstraint", name: v.name }])])
				return
			}
			case "uniqueIndex":
			case "index": {
				if (tableGone) {
					return
				}
				const s = v.create
				const name = objectName(s.table.schema, s.name)
				drop(v.kind, statement({ kind: "dropIndex", name, concurrently: false, ifExists: false }))
				return
			}
			case "statistics":
				if (!tableGone) {
					drop(v.kind, { kind: "dropStatistics", name: v.create.name })
				}
				return
			case "role":
				drop(
					v.kind,
					statement({ kind: "drop", object: "ROLE", name: v.create.name, ifExists: false })
				)
				return
			case "isolationTrigger":
				if (!tableGone) {
					drop(
						v.kind,
						statement({
							kind: "dropTrigger",
							name: v.create.name,
							table: v.create.table,
							ifExists: false
						})
					)
				}
				return
		}
	}

	/** Drafts the removals in publish.removed: in the drop order (dropOrder), then reverse install order, then (the sort
	 * being stable) as drafted. */
	draftRemovals(): void {
		const ordered = this.removals.toSorted(
			combine(
				mapInput(compareNumbers, (r: Removal) => r.rank),
				mapInput(flip(compareNumbers), (r: Removal) => r.order)
			)
		)
		for (const r of ordered) {
			this.push("publish.removed", r.draft)
		}
	}

	/** Grants, replaced per role, the target's roles in its install order and then the roles only the previous
	 * installation holds in its: every previous grant of a role whose grants change is revoked and every target grant
	 * granted, so grants two objects share survive. Every revoke comes before every grant.
	 *
	 * A column grant is revoked by the table's revoke of its privilege, which PostgreSQL applies to every
	 * column, whatever a rename called it since. */
	grants(): void {
		const byRole = (objects: ReadonlyArray<ManifestObject>) => {
			const out = new Map<string, Array<ManifestObject>>()
			for (const o of objects) {
				const v = installed(o)
				if (v.kind !== "privileges" || o.ident === ledgerPrivilegesIdent(this.schema)) {
					continue
				}
				out.set(v.grantee, [...(out.get(v.grantee) ?? []), o])
			}
			return out
		}
		const before = byRole(this.input.previous.manifest.objects)
		const after = byRole(this.input.target.manifest.objects)
		/** A recreated view, a role's recreated view or world function, or a recreated identity sequence lost its
		 * privileges with its drop: its grants are granted again. */
		const recreated = (g: Grant): boolean =>
			(g.on.kind === "TABLE" &&
				g.on.names.some(
					(n) => this.recreatedViews.has(nameKey(n)) || this.worldGone.has(nameKey(n))
				)) ||
			(g.on.kind === "FUNCTION" && g.on.names.some((n) => this.worldGone.has(nameKey(n)))) ||
			(g.on.kind === "SEQUENCE" &&
				g.on.names.some((n) => this.sequences.get(nameKey(n)) === "recreated"))
		const roles = [...new Set([...after.keys(), ...before.keys()])].flatMap((role) => {
			const a = before.get(role) ?? []
			const b = after.get(role) ?? []
			const namesRecreated = b.some((o) => o.ddl.some((s) => s.kind === "grant" && recreated(s)))
			return same(
				a.map((o) => o.ddl),
				b.map((o) => o.ddl)
			) && !namesRecreated
				? []
				: [{ role, a, b }]
		})
		/** Every previous grant of a role the previous installation holds, a column grant as its table's grant. */
		const previousGrants = roles.flatMap(({ role, a }) =>
			this.prev.has(namedIdent("role", role))
				? a.flatMap((o) =>
						o.ddl.flatMap((g): ReadonlyArray<Grant> =>
							g.kind === "grant"
								? [g]
								: g.kind === "grantColumns"
									? [
											{
												kind: "grant",
												privileges: [g.privilege],
												on: { kind: "TABLE", names: [g.table] },
												to: [{ kind: "role", name: g.to }]
											}
										]
									: []
						)
					)
				: []
		)
		for (const g of previousGrants) {
			this.revokes(g)
		}
		for (const o of roles.flatMap(({ b }) => b)) {
			this.sql("publish.grants", o.ddl)
		}
		const ledgerA = this.prev.get(ledgerPrivilegesIdent(this.schema))
		const ledgerB = this.next.get(ledgerPrivilegesIdent(this.schema))
		if (ledgerA !== undefined && (ledgerB === undefined || !same(ledgerA.ddl, ledgerB.ddl))) {
			const granted = ledgerB === undefined ? [] : ledgerB.ddl
			const holds = (name: string): boolean =>
				granted.some(
					(x) => x.kind === "grant" && x.to.some((y) => y.kind === "role" && y.name === name)
				)
			const revokes = ledgerA.ddl.flatMap((g) => {
				if (g.kind !== "grant") {
					return []
				}
				const gone = g.to.filter((t) => t.kind === "role" && !holds(t.name))
				return isNonEmpty(gone) ? [revokeOf({ ...g, to: gone })] : []
			})
			this.sql("publish.grants", revokes)
		}
		if (ledgerB !== undefined && (ledgerA === undefined || !same(ledgerA.ddl, ledgerB.ddl))) {
			this.sql("publish.grants", ledgerB.ddl)
		}
	}

	/** The revoke of a role's previous grant. A relation or sequence this migration dropped took its privileges with it,
	 * so the revoke leaves it out. */
	revokes(g: Grant): void {
		const r = revokeOf(g)
		const split = (
			names: ReadonlyArray<ObjectName>,
			on: (names: NonEmptyReadonlyArray<ObjectName>) => Revoke
		) => {
			if (isNonEmpty(names)) {
				this.sql("publish.grants", [on(names)])
			}
		}
		switch (r.on.kind) {
			case "SEQUENCE":
				split(
					r.on.names.filter((n) => this.sequences.get(nameKey(n)) !== "dropped"),
					(names) => ({ ...r, on: { kind: "SEQUENCE", names } })
				)
				return
			case "TABLE":
				split(
					r.on.names.filter(
						(n) => !this.dropped.has(nameKey(n)) && !this.worldGone.has(nameKey(n))
					),
					(names) => ({ ...r, on: { kind: "TABLE", names } })
				)
				return
			case "DOMAIN":
				split(r.on.names, (names) => ({ ...r, on: { kind: "DOMAIN", names } }))
				return
			case "FUNCTION": {
				const names = r.on.names.filter((n) => !this.worldGone.has(nameKey(n)))
				if (isNonEmpty(names)) {
					this.sql("publish.grants", [{ ...r, on: { kind: "FUNCTION", names } }])
				}
				return
			}
			case "SCHEMA":
			case "DATABASE":
				this.sql("publish.grants", [r])
				return
		}
	}

	/** The final COMMENT step: the comment of every object of the target this migration creates or renames, or whose
	 * comment the previous snapshot does not hold as the target does (physical/install/comments.ts). */
	comments(): void {
		const touched = touchedTargets(this.drafted().flatMap((s) => draftStatements(s.draft)))
		const before = new Map(
			this.input.previous.manifest.comments.flatMap((c) =>
				c.kind === "comment" ? [[targetKey(c.on), c.text] as const] : []
			)
		)
		for (const c of this.input.target.manifest.comments) {
			if (
				c.kind === "comment" &&
				(touched.has(targetKey(c.on)) || before.get(targetKey(c.on)) !== c.text)
			) {
				this.sql("publish.comments", [c])
			}
		}
	}

	/** Login defaults the target adds or changes, a RESET of each one a kept login no longer carries, and the PUBLIC
	 * revokes whenever they change. A query among the role defaults readies the session for
	 * the settings listed after it (the vector library's load before the search policy's `hnsw.*` settings, which the
	 * migration identity can store or reset only once the library is loaded): it runs, once,
	 * before the first such setting the migration stores or resets.
	 *
	 * An identity sequence created again under its old name starts from its default privileges. */
	defaults(): void {
		const previousDefaults = this.input.previous.manifest.roleDefaults
		const targetDefaults = this.input.target.manifest.roleDefaults
		const ran = new Set<string>()
		const run = (prelude: ReadonlyArray<SqlStatement>, s: SqlStatement) => {
			for (const p of prelude) {
				if (!ran.has(roleDefaultText(p))) {
					ran.add(roleDefaultText(p))
					this.sql("publish.defaults", [p])
				}
			}
			this.sql("publish.defaults", [s])
		}
		/** The parameters each kept role still sets. */
		const kept = new Map<string, Set<string>>()
		for (const { statement: s } of roleSettings(targetDefaults)) {
			const set = kept.get(s.name) ?? new Set<string>()
			if (s.action.kind === "set") {
				set.add(s.action.setting.parameter)
			}
			kept.set(s.name, set)
		}
		for (const { statement: s, prelude } of roleSettings(previousDefaults)) {
			if (s.action.kind === "set" && kept.get(s.name)?.has(s.action.setting.parameter) === false) {
				run(prelude, {
					kind: "alterRole",
					name: s.name,
					action: { kind: "reset", parameter: s.action.setting.parameter }
				})
			}
		}
		const was = new Set(previousDefaults.map(roleDefaultText))
		for (const { statement: s, prelude } of roleSettings(targetDefaults)) {
			if (!was.has(roleDefaultText(s))) {
				run(prelude, s)
			}
		}
		if (
			!same(this.input.previous.manifest.publicRevokes, this.input.target.manifest.publicRevokes)
		) {
			this.sql("publish.defaults", this.input.target.manifest.publicRevokes)
		} else {
			/** A recreated identity sequence took its PUBLIC revoke with its drop: it is revoked again. */
			const again = this.input.target.manifest.publicRevokes.flatMap(
				(r): ReadonlyArray<SqlStatement> => {
					if (!(r.kind === "revoke" && r.on.kind === "SEQUENCE")) {
						return []
					}
					const names = r.on.names.filter((n) => this.sequences.get(nameKey(n)) === "recreated")
					return isNonEmpty(names) ? [{ ...r, on: { kind: "SEQUENCE", names } }] : []
				}
			)
			this.sql("publish.defaults", again)
		}
	}
}

/** Every statement a draft may run: an action's, a confirm's, a loss's. */
const draftStatements = (d: Draft): ReadonlyArray<SqlStatement> => {
	switch (d.kind) {
		case "statement":
		case "loss":
			return [d.statement]
		case "confirm":
			return d.keep
		case "alteration":
			return [alterationStatement(d.table, d.actions)]
		case "fill":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return []
	}
}

/** A refusal a rule decides before it is reached, thrown where it is: UnsupportedOperation at `loc`. */
interface Unsupported {
	readonly loc: SourceLoc
	readonly capability: string
}

/** A function declaration, so that control flow knows a call never returns. */
function refuseUnsupported(u: Unsupported): never {
	throw new Refusal(unsupported(u.loc, u.capability))
}

/** A column list as a key of its set. */
const sortedColumns = (columns: ReadonlyArray<string>): string =>
	[...columns].toSorted(compareStrings).join(",")

/** The identity of a key of a table as a foreign key binds it: the table and the key's columns as a set, since
 * PostgreSQL matches a foreign key's referenced columns to a unique constraint whatever order either lists them in, and
 * a containment may name a key's fields in another order than the key declares them. A key is named in one snapshot's
 * coordinates, by the previous snapshot's names (KeyBefore) or by the target's (KeyAfter), each its own type, so no
 * key of the one is compared with a key of the other: a previous key reaches the target's names only through its image
 * (Differ.keyImage), the declared renames having renamed every column before the diff. */
declare const keyBeforeBrand: unique symbol
declare const keyAfterBrand: unique symbol
type KeyBefore = string & { readonly [keyBeforeBrand]: true }
type KeyAfter = string & { readonly [keyAfterBrand]: true }
const mintKeyBefore = nominal<string, KeyBefore>()
const mintKeyAfter = nominal<string, KeyAfter>()
const keyBefore = (table: ObjectName, columns: ReadonlyArray<string>): KeyBefore =>
	mintKeyBefore(`${nameKey(table)}|${sortedColumns(columns)}`)

const keyAfter = (table: ObjectName, columns: ReadonlyArray<string>): KeyAfter =>
	mintKeyAfter(`${nameKey(table)}|${sortedColumns(columns)}`)

const referencedColumns = (fk: ForeignKey): ReadonlyArray<string> =>
	fk.referencedColumns.map((k) => k.column)

/** The key a foreign key of the previous snapshot references, and the key one of the target references. */
const referencedBefore = (fk: ForeignKey): KeyBefore =>
	keyBefore(fk.references, referencedColumns(fk))
const referencedAfter = (fk: ForeignKey): KeyAfter => keyAfter(fk.references, referencedColumns(fk))

/** A key of a table both snapshots install whose index the migration drops in Validate beside a key the target declares
 * over the same columns (Differ.replaced): the key as the previous snapshot's foreign keys reference it, and the
 * target's keys it may stand beside, over their columns (keyImage). */
interface ReplacedKey {
	readonly before: KeyBefore
	readonly beside: ReadonlySet<KeyAfter>
}

const typeChanged = (a: ColumnDef, b: ColumnDef): boolean =>
	canonicalTextOf({ t: a.type, c: a.collation }) !== canonicalTextOf({ t: b.type, c: b.collation })

/**
 * A domain as a column's values are read through it: a law's, a pattern's or a contract's, which is its base type with
 * a CHECK, so it holds its base's values; or a roster's, its codes' domain or its sets', whose values are handles of the
 * roster its fate names (ir/codes.ts RosterFate), the codes it stores meaning them only under that roster's
 * codes.
 */
type DomainReading =
	| { readonly kind: "law"; readonly create: CreateDomain }
	| { readonly kind: "roster"; readonly roster: RosterFate; readonly create: CreateDomain }

/** Each roster constant of an installation in `schema`, by its function's manifest identifier, with its roster's fate:
 * its names constant and its live-codes constant (physical/ddl/constants.ts rosterConstants), named by the roster's
 * recorded name and codes. A constant is named by its content and never renamed, so it names its roster whatever
 * renames and asides the draft gives the roster's domains. */
const rosterConstantsOf = (
	schema: string,
	rosters: ReadonlyArray<PreviousRoster>
): ReadonlyMap<string, RosterFate> =>
	new Map(
		rosters.flatMap(({ codec, fate }) => {
			const constants = rosterConstants(codec)
			return [constants.names, constants.live].map(
				(id) => [qualifiedIdent("function", schema, identifierOf(id)), fate] as const
			)
		})
	)

/**
 * Each domain a manifest installs, by name key, as a column's values are read through it (DomainReading): a roster's,
 * the domain that reads a roster constant of `constants`, its codes' domain the names constant and its sets' the live
 * constant; a law's, every other.
 */
const domainsOf = (
	manifest: InstallationManifest<SqlStatement>,
	constants: ReadonlyMap<string, RosterFate>
): ReadonlyMap<string, DomainReading> => {
	const readers = new Map(
		manifest.edges.flatMap((e) => {
			const roster = constants.get(e.from)
			return roster === undefined ? [] : [[e.to, roster] as const]
		})
	)
	return new Map(
		manifest.objects.flatMap((o) => {
			const v = installed(o)
			if (v.kind !== "domain") {
				return []
			}
			const roster = readers.get(o.ident)
			const reading: DomainReading =
				roster === undefined
					? { kind: "law", create: v.create }
					: { kind: "roster", roster, create: v.create }
			return [[nameKey(v.create.name), reading] as const]
		})
	)
}

/** The domain of `domains` a column's type names, if it names one. */
const domainOf = (
	type: TypeRef,
	domains: ReadonlyMap<string, DomainReading>
): DomainReading | undefined =>
	type.kind === "named" ? domains.get(nameKey(objectName(type.schema, type.name))) : undefined

/**
 * The schema of the operators that compare two values of a column of `type`, read through each domain of `domains` to
 * its base type: a named type no domain names is an extension's, whose own schema holds its operators (sql/ast.ts
 * TypeSchema); a builtin type's operators are pg_catalog's, none (ir/compare.ts operatorSchemaOf).
 */
const columnOperators = (
	type: TypeRef,
	domains: ReadonlyMap<string, DomainReading>
): TypeSchema | undefined => {
	const domain = domainOf(type, domains)
	return domain !== undefined
		? columnOperators(domain.create.base, domains)
		: type.kind === "named"
			? type.schema
			: undefined
}

/** Whether a previous roster's fate continues it as the target's roster `to`'s: an ended roster continues as none. */
const continuesAs = (from: RosterFate, to: RosterFate): boolean =>
	from.kind === "continued" && to.kind === "continued" && from.as === to.as

/** The roster's domain a column of `type` is read through, past each law's domain of `domains`; none for a type that
 * holds no roster's values. */
const rosterDomainOf = (
	type: TypeRef,
	domains: ReadonlyMap<string, DomainReading>
): Extract<DomainReading, { readonly kind: "roster" }> | undefined => {
	const domain = domainOf(type, domains)
	if (domain === undefined) {
		return undefined
	}
	switch (domain.kind) {
		case "law":
			return rosterDomainOf(domain.create.base, domains)
		case "roster":
			return domain
	}
}

/** The roster a column of `type` holds handles of (rosterDomainOf). */
const rosterOf = (
	type: TypeRef,
	domains: ReadonlyMap<string, DomainReading>
): RosterFate | undefined => rosterDomainOf(type, domains)?.roster

/** Whether a previous column's roster and a target column's are one, or neither holds a roster's values. */
const sameRoster = (before: RosterFate | undefined, after: RosterFate | undefined): boolean =>
	before === undefined || after === undefined ? before === after : continuesAs(before, after)

/** What a column of `type` holds, as canonical text: the type read through each domain of `domains` to its base type,
 * under the collation that applies (the column's own, else its domain's), each roster's domain on the way with its
 * roster (DomainReading). A law's domain is its base type with a CHECK, so two types of one representation hold the
 * same values: a pattern's domain and another pattern's, a contract's and its base, two contracts over one base. A
 * roster's domain holds the handles of its roster alone: two hold the same values only when the previous one's roster
 * continues as the target's (continuesAs), so a code is never cast to another roster's, nor to or from an integer. */
const representationOf = (
	type: TypeRef,
	collation: Collation | undefined,
	domains: ReadonlyMap<string, DomainReading>
): string => {
	const domain = domainOf(type, domains)
	if (domain === undefined) {
		return canonicalTextOf({ t: type, c: collation })
	}
	const base = representationOf(domain.create.base, collation ?? domain.create.collation, domains)
	switch (domain.kind) {
		case "law":
			return base
		case "roster":
			return canonicalTextOf({ roster: domain.roster, base })
	}
}

/** The roster and the n of a set's column type bit(n), its roster's domain's base (rosterDomainOf); undefined for any
 * other type. */
const setOf = (
	type: TypeRef,
	domains: ReadonlyMap<string, DomainReading>
): { readonly roster: RosterFate; readonly length: number } | undefined => {
	const domain = rosterDomainOf(type, domains)
	const base = domain?.create.base
	return domain !== undefined && base?.kind === "builtin" && base.name === "bit"
		? { roster: domain.roster, length: base.length }
		: undefined
}

/** How a migration replaces the physical column of a table both snapshots install (ColumnFate): a field whose type
 * changes is converted in place; a law column whose definition changes, or a field rewritten, is redefined, dropped and
 * added again. Either first drops everything built over the column (dropReplaced). */
type Replacement = "converted" | "redefined"

/** What a replacement of a column does to an object built over it: `how` the column is replaced, and the object's own
 * drop, which dropReplaced drafts before the replacement. */
interface Replaced {
	readonly how: Replacement
	readonly drop: Drop
}

/** The strongest of `hows`: a conversion in place takes more than a law column dropped and added again. */
const strongestReplacement = (hows: ReadonlyArray<Replacement>): Replacement | undefined =>
	hows.includes("converted") ? "converted" : hows.includes("redefined") ? "redefined" : undefined

/** What a migration does to an identity sequence of a table both snapshots install: dropped with the identity that owns
 * it, or dropped and created again under its name, which leaves it with the default privileges. */
type SequenceFate = "dropped" | "recreated"

/** How a column a migration converts in place was drawn: by nothing; by an identity, whose sequence the conversion
 * drops or creates again under its name (SequenceFate); or by its `uuidv7()` default, which the conversion drops first,
 * since PostgreSQL casts a column's default with its values and casts no uuid to another type. */
type DrawnBefore =
	| { readonly kind: "none" }
	| { readonly kind: SequenceFate; readonly sequence: ObjectName }
	| { readonly kind: "uuidv7" }

/** What a migration does to a field of a table both snapshots install, read off its type, its writing and its draw
 * before and after:
 * - converted in place, its type changed, with what becomes of its draw when it was serial;
 * - re-expressed, a generated field whose generation expression changes and whose type does not, by SET EXPRESSION,
 *   which recomputes every row and keeps what is built over the column;
 * - rewritten, dropped and added again: a field whose writing changes between its caller and a generation, a generated
 *   field whose type changes, which PostgreSQL converts by no expression of the reviewer's, or a generated field that
 *   reads a field its table converts in place, which PostgreSQL refuses to convert under it;
 * - otherwise kept, declared serial, or serial no longer, its draw added or dropped in place (inPlace): an integer's
 *   identity, or a uuid's `uuidv7()` default.
 *
 * A serial column converted gives its draw up first, whatever its new type: its identity, which drops the sequence and
 * its privileges, or its default. It takes the target's draw once converted: its identity, its sequence created again
 * under its name, or its default. A field serial before and after keeps its sequence, which its table's pairing renames
 * when the target names it otherwise (KeptPlan sequences). */
type FieldChange =
	| { readonly kind: "kept" }
	| { readonly kind: "converted"; readonly drawn: DrawnBefore }
	| { readonly kind: "reexpressed"; readonly expr: Expr }
	| { readonly kind: "rewritten" }
	| { readonly kind: "serialDeclared"; readonly sequence: ObjectName }
	| { readonly kind: "serialRemoved"; readonly sequence: ObjectName }
	| { readonly kind: "uuidv7Declared" }
	| { readonly kind: "uuidv7Removed" }

/** The identity sequence of a serial column. */
const identitySequence = (c: ColumnDef): ObjectName | undefined =>
	c.generated?.kind === "identity" ? c.generated.sequence : undefined

/** A generated field's generation expression: its column's stored generation, none for a field its caller writes. */
const generationOf = (c: ColumnDef): Expr | undefined =>
	c.generated?.kind === "stored" ? c.generated.expr : undefined

/** Whether a column's type changes between a previous column and a target one (Differ.retyped). */
type Retyped = (b: ColumnDef, c: ColumnDef) => boolean

/** The one reading of a field's change from its column before and after, alone (fieldChangesOf reads a table's), its type
 * changing as `retyped` reads it. */
const fieldChange = (b: ColumnDef, c: ColumnDef, retyped: Retyped): FieldChange => {
	const was = identitySequence(b)
	const now = identitySequence(c)
	const before = generationOf(b)
	const after = generationOf(c)
	if ((before === undefined) !== (after === undefined)) {
		return { kind: "rewritten" }
	}
	if (after !== undefined) {
		if (retyped(b, c)) {
			return { kind: "rewritten" }
		}
		return same(before, after) ? { kind: "kept" } : { kind: "reexpressed", expr: after }
	}
	const wasUuidv7 = b.generated?.kind === "uuidv7"
	const nowUuidv7 = c.generated?.kind === "uuidv7"
	if (retyped(b, c)) {
		return {
			kind: "converted",
			drawn: wasUuidv7
				? { kind: "uuidv7" }
				: was === undefined
					? { kind: "none" }
					: {
							kind: now !== undefined && nameKey(now) === nameKey(was) ? "recreated" : "dropped",
							sequence: was
						}
		}
	}
	if (was !== undefined) {
		return now === undefined ? { kind: "serialRemoved", sequence: was } : { kind: "kept" }
	}
	if (now !== undefined) {
		return { kind: "serialDeclared", sequence: now }
	}
	return wasUuidv7 === nowUuidv7
		? { kind: "kept" }
		: nowUuidv7
			? { kind: "uuidv7Declared" }
			: { kind: "uuidv7Removed" }
}

/** The changes of the fields two declarations of one relation share, by name (fieldChange): a generated field that
 * reads a field converted in place is rewritten, since PostgreSQL refuses to convert a column a generated column reads. */
const fieldChangesOf = (
	old: ReadonlyArray<ColumnDef>,
	create: ReadonlyArray<ColumnDef>,
	retyped: Retyped
): ReadonlyMap<string, FieldChange> => {
	const shared = create.flatMap((c) => {
		const b = old.find((x) => x.name === c.name)
		return b === undefined ? [] : [{ column: c, change: fieldChange(b, c, retyped) }]
	})
	const own = new Map(shared.map(({ column, change }) => [column.name, change] as const))
	return new Map(
		shared.map(({ column, change }): readonly [string, FieldChange] =>
			change.kind !== "rewritten" &&
			generationColumns(column).some((r) => own.get(r)?.kind === "converted")
				? [column.name, { kind: "rewritten" }]
				: [column.name, change]
		)
	)
}

/** How each field of every stored relation `theory` records is written, by column, under the table it is installed as. */
const writingsByTable = (
	theory: SnapshotTheory
): ReadonlyMap<string, ReadonlyMap<string, SnapshotWriting>> => {
	const out = new Map<string, ReadonlyMap<string, SnapshotWriting>>()
	for (const r of Object.values(theory.relations)) {
		if (r.kind === "relation" && !out.has(r.ident)) {
			out.set(r.ident, new Map(r.fields.map((f) => [f.column, f.writing] as const)))
		}
	}
	return out
}

/** The writings of a table no stored relation of it is installed as: none. */
const noWritings: ReadonlyMap<string, SnapshotWriting> = new Map()

/** Whether a field is grizzle's to write: drawn from the nested arrays, or accumulated on the host. */
const isDrawn = (w: SnapshotWriting | undefined): boolean =>
	typeof w === "object" && ("drawn" in w || "accumulated" in w)

/**
 * The field changes of a table with each field the target draws or accumulates otherwise than the previous snapshot
 * records it rewritten: a field its caller wrote, or one drawn or accumulated by another
 * filler (SnapshotWriting), its family, fold, copy or start changed. Its column is added again under its placeholder
 * and backfilled, so its stale values give way to the drawn ones. A field whose filler a declaration only renames, and
 * an ordered family's or a tree's index whose family only changes its group, reads as its previous record
 * (deploy/diff/declared.ts) and is kept. A drawn or accumulated field the target leaves to its
 * caller keeps its column and its values, which are lawful, as the caller's data; its family's law columns and natives
 * go with the family.
 */
const redrawn = (
	changes: ReadonlyMap<string, FieldChange>,
	before: ReadonlyMap<string, SnapshotWriting>,
	after: ReadonlyMap<string, SnapshotWriting>
): ReadonlyMap<string, FieldChange> =>
	new Map(
		[...changes].map(([column, change]): readonly [string, FieldChange] =>
			isDrawn(after.get(column)) && !same(before.get(column), after.get(column))
				? [column, { kind: "rewritten" }]
				: [column, change]
		)
	)

/**
 * A kept table's column fates with its law columns': each its own (kept, redefined or dropped), but a generated law
 * column that reads a column the migration replaces (converted in place, or dropped and added again), through any
 * chain of generated law columns, is redefined: PostgreSQL drops a column only once every generated column that reads
 * it is gone (2BP01), so the migration drops it before the column it reads, with everything built over it, and adds it
 * again where the target holds it (dropReplaced).
 */
const generatedOver = (
	fields: ReadonlyMap<string, ColumnFate>,
	lawColumns: ReadonlyArray<{
		readonly column: string
		readonly reads: ReadonlyArray<string>
		readonly fate: ColumnFate
	}>
): ColumnFates => {
	const fates = new Map<string, ColumnFate>([
		...fields,
		...lawColumns.map((c) => [c.column, c.fate] as const)
	])
	const replaced = (column: string): boolean => {
		const fate = fates.get(column)?.kind
		return fate === "converted" || fate === "redefined"
	}
	for (let grew = true; grew;) {
		const reached = lawColumns.filter((c) => !replaced(c.column) && c.reads.some(replaced))
		for (const c of reached) {
			fates.set(c.column, redefinedColumn)
		}
		grew = reached.length > 0
	}
	return fates
}

/** A field's change in a table's changes (fieldChangesOf): every field both declarations hold has one. */
const changeOf = (changes: ReadonlyMap<string, FieldChange>, column: string): FieldChange => {
	const change = changes.get(column)
	if (change === undefined) {
		throw defect(`the field ${column} both declarations hold has a change`)
	}
	return change
}

/** The steps that change a field of `t` from `b` to `c` in place, by its change (fieldChange), `convert` converting the
 * column to its new type: a serial column gives its draw up before its conversion, and a column serial after takes the
 * target's draw once converted, an identity advanced past the stored maximum or a `uuidv7()` default; a field declared
 * serial takes its draw, an identity advanced the same way, and one serial no longer gives it up; a generated field
 * re-expressed takes its new expression; a field rewritten is dropped and added again by `add`; a field kept as it is
 * takes none. The one reading for a field of a table both install but a rewritten one, which changeField drops before
 * the conversions. A conversion the reviewer's value makes is set aside instead (InPlace setAside), its old column's
 * identity or default leaving with the column. Each alteration joins its table's one ALTER TABLE in Structure
 * (Differ.alter), which PostgreSQL runs pass by pass, every give-up before every conversion and every conversion before
 * every take; an identity's advance reads the values that statement leaves, so it follows it. */
const inPlace = (
	t: ObjectName,
	b: ColumnDef,
	c: ColumnDef,
	change: FieldChange,
	convert: (column: ColumnDef) => ColumnConversion,
	add: (column: ColumnDef) => Alteration
): InPlace => {
	const altering = (a: Alteration): Action => ({ kind: "alteration", table: t, actions: [a] })
	const steps = (list: ReadonlyArray<Action>): InPlace => ({ kind: "steps", steps: list })
	const take = (sequence: ObjectName): ReadonlyArray<Action> => [
		altering({ kind: "addIdentity", column: c.name, sequence }),
		statement(advance(t, c.name, sequence, c.type))
	]
	const giveUp = altering({ kind: "dropIdentity", column: b.name })
	const takeUuidv7 = altering({ kind: "setUuidv7Default", column: c.name })
	const giveUpUuidv7 = altering({ kind: "dropDefault", column: b.name })
	switch (change.kind) {
		case "kept":
			return steps([])
		case "converted": {
			const conversion = convert({ ...c, generated: undefined })
			if (conversion.kind === "placeholderRetype") {
				return { kind: "setAside", reason: conversion.reason }
			}
			const before =
				change.drawn.kind === "none"
					? []
					: change.drawn.kind === "uuidv7"
						? [giveUpUuidv7]
						: [giveUp]
			return steps(
				c.generated?.kind === "identity"
					? [...before, altering(conversion), ...take(c.generated.sequence)]
					: c.generated?.kind === "uuidv7"
						? [...before, altering(conversion), takeUuidv7]
						: [...before, altering(conversion)]
			)
		}
		case "reexpressed":
			return steps([altering({ kind: "setExpression", column: c.name, expr: change.expr })])
		case "rewritten":
			return steps([altering({ kind: "dropColumn", column: b.name }), altering(add(c))])
		case "serialDeclared":
			return steps(take(change.sequence))
		case "serialRemoved":
			return steps([giveUp])
		case "uuidv7Declared":
			return steps([takeUuidv7])
		case "uuidv7Removed":
			return steps([giveUpUuidv7])
	}
}

/** What a field's change in place drafts (inPlace): its steps, or, for a conversion the reviewer's value makes, its
 * setting aside (SetAside), which draws its identity or its uuidv7() default once its fill renames it. */
type InPlace =
	| { readonly kind: "steps"; readonly steps: ReadonlyArray<Action> }
	| { readonly kind: "setAside"; readonly reason: RetypeReason }

/** The identity sequences of the tables both install that a migration drops, by name key, each with its fate, read off
 * each field's change before any object is visited: a serial field converted in place drops its sequence, created again
 * when it takes the target's identity under its name; a field serial no longer drops it. */
const sequenceFatesOf = (kept: Iterable<KeptTable>): ReadonlyMap<string, SequenceFate> => {
	const out = new Map<string, SequenceFate>()
	for (const { changes } of kept) {
		for (const change of changes.values()) {
			if (
				change.kind === "converted" &&
				(change.drawn.kind === "dropped" || change.drawn.kind === "recreated")
			) {
				out.set(nameKey(change.drawn.sequence), change.drawn.kind)
			} else if (change.kind === "serialRemoved") {
				out.set(nameKey(change.sequence), "dropped")
			}
		}
	}
	return out
}

/** The drop of a domain or a relation, which must find it. */
const dropObject = (
	v: Installed & { readonly kind: "domain" | "table" | "materializedView" }
): SqlStatement => {
	const [object, name] =
		v.kind === "table"
			? (["TABLE", v.create.table] as const)
			: v.kind === "materializedView"
				? (["MATERIALIZED VIEW", v.create.name] as const)
				: (["DOMAIN", v.create.name] as const)
	return { kind: "drop", object, name, ifExists: false }
}

/** The PostgreSQL schema a schema object creates, its manifest identity's name. */
const schemaOf = (o: ManifestObject): string => {
	const ident = parseIdent(o.ident)
	if (ident.kind !== "schema") {
		throw defect(`the schema object ${o.ident} is named as a schema`)
	}
	return ident.name
}

/** A constant's signature: its name and its parameters' types, none for a packed constant, which takes none. */
const constantName = (c: CreateConstant | PackConstant): FunctionName =>
	c.kind === "createConstant"
		? { ...c.name, args: c.params.map((p) => p.type) }
		: { ...c.function, args: [] }

/** The table key of a table or a materialized view: the name its definition creates. */
const relationKey = (v: Installed & { readonly kind: "table" | "materializedView" }): string =>
	nameKey(v.kind === "table" ? v.create.table : v.create.name)

/** The keys of every name qualified by one of the installation's level schemas `schemas` that a value holds:
 * relations, types, sequences and functions. */
const qualifiedNames = (value: unknown, schemas: ReadonlySet<string>): ReadonlySet<string> => {
	const out = new Set<string>()
	const walk = (v: unknown): void => {
		if (isList(v)) {
			for (const x of v) {
				walk(x)
			}
			return
		}
		if (!isRecord(v)) {
			return
		}
		const r: { readonly [key: string]: unknown } = v
		const schema = r["schema"]
		if (typeof schema === "string" && schemas.has(schema) && typeof r["name"] === "string") {
			out.add(`${schema}.${r["name"]}`)
		}
		for (const child of Object.values(r)) {
			walk(child)
		}
	}
	walk(value)
	return out
}

/** What each installed materialized view reads, by table key: the previous snapshot's edges, and the relations every
 * installed definition names. A view's query names schema relations only as what it reads, and relations, types and
 * sequences share one namespace, so a qualified name in it is a relation it reads, a type it casts to, or neither; only
 * relation keys are ever looked up. */
const installedReads = (
	previous: DeploySnapshot,
	schemas: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> => {
	const out = new Map<string, Set<string>>()
	const add = (view: string, relation: string): void => {
		if (view === relation) {
			return
		}
		const set = out.get(view) ?? new Set<string>()
		set.add(relation)
		out.set(view, set)
	}
	for (const e of previous.manifest.edges) {
		const from = parseIdent(e.from)
		const to = parseIdent(e.to)
		if (
			to.kind === "materializedView" &&
			(from.kind === "table" || from.kind === "materializedView")
		) {
			add(`${to.schema}.${to.name}`, `${from.schema}.${from.name}`)
		}
	}
	for (const o of previous.manifest.objects) {
		const v = installed(o)
		if (v.kind !== "materializedView") {
			continue
		}
		const view = nameKey(v.create.name)
		if (!out.has(view)) {
			out.set(view, new Set())
		}
		for (const name of qualifiedNames(v.create.query, schemas)) {
			add(view, name)
		}
	}
	return out
}

/** The drop of an object built over a column (objects.ts builtOver), which a replacement of the column takes away, in
 * the drop order (dropOrder): the foreign keys and rule triggers first, then the keys and CHECKs, the indexes, the
 * statistics objects and the law columns whose generation reads the column. */
const replacementDrop = (v: BuiltOver["part"]): Drop => {
	switch (v.kind) {
		case "foreignKey":
		case "check":
		case "primaryKey":
		case "unique":
			return {
				rank: dropOrder[v.kind],
				draft: statement(alter(v.table, [{ kind: "dropConstraint", name: v.name }]))
			}
		case "index":
		case "uniqueIndex":
			return {
				rank: dropOrder[v.kind],
				draft: statement({
					kind: "dropIndex",
					name: objectName(v.create.table.schema, v.create.name),
					concurrently: false,
					ifExists: false
				})
			}
		case "statistics":
			return { rank: dropOrder.statistics, draft: { kind: "dropStatistics", name: v.create.name } }
		case "lawTrigger":
			return {
				rank: dropOrder.lawTrigger,
				draft: statement({
					kind: "dropTrigger",
					name: v.create.name,
					table: v.create.table,
					ifExists: false
				})
			}
		case "lawColumn":
			return {
				rank: dropOrder.lawColumn,
				draft: statement(alter(v.table, [{ kind: "dropColumn", column: v.column }]))
			}
	}
}

const revokeOf = (g: Grant): Revoke => ({
	kind: "revoke",
	privileges: g.privileges,
	on: g.on,
	from: g.to
})

/** The revoke of a role's membership in its login. */
const revokeRoleOf = (g: GrantRole): SqlStatement => ({
	kind: "revokeRole",
	role: g.role,
	from: g.to
})

/** The roles' objects that hold no data and are created again whenever they change: views, world functions, policies. */
const worldKinds: ReadonlySet<PhysicalKind> = new Set(["view", "worldFunction", "policy"])

/** Each table's and materialized view's compile inputs its own DDL does not state, by the relation: what a world object
 * reading it is lowered against (laws/model/catalog.ts evidenceCatalog) beside its CREATE. A table's keys and checks
 * are in its CREATE TABLE; a materialized view's keys are its unique indexes (physical/derived/objects.ts viewObjects);
 * and each foreign key a relation takes part in, referencing or referenced, is a containment the catalog may prove an
 * existence by, whose DDL says whether it holds at every statement, which decides whether a definition may rely on it.
 * Each input by its object, with its DDL. */
const compileInputsOf = (
	manifest: InstallationManifest<SqlStatement>
): ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<SqlStatement>>> => {
	const objects = new Map(manifest.objects.map((o) => [o.ident, o]))
	const inputs = new Map(
		manifest.objects.flatMap(
			(o): ReadonlyArray<readonly [string, Map<string, ReadonlyArray<SqlStatement>>]> =>
				o.kind === "table" || o.kind === "materializedView" ? [[o.ident, new Map()]] : []
		)
	)
	for (const e of manifest.edges) {
		const from = objects.get(e.from)
		const to = objects.get(e.to)
		if (
			to?.kind === "foreignKey" ||
			(from?.kind === "materializedView" && to?.kind === "uniqueIndex")
		) {
			inputs.get(e.from)?.set(e.to, to.ddl)
		}
	}
	return inputs
}

/** Whether a relation's compile inputs are the same objects in two manifests, each with the same DDL. */
const sameInputs = (
	a: ReadonlyMap<string, ReadonlyArray<SqlStatement>>,
	b: ReadonlyMap<string, ReadonlyArray<SqlStatement>>
): boolean =>
	a.size === b.size &&
	[...a].every(([input, ddl]) => {
		const other = b.get(input)
		return other !== undefined && same(ddl, other)
	})

/** The roles' views, world functions and policies a migration drops at the start of Structure and creates again (in
 * Structure or in Publish, Differ.visit): each the target holds whose DDL changes, or that waits for an object the
 * migration changes (one whose DDL changes, one the previous manifest lacks, one the target lacks, one whose compile
 * inputs change, or one `beneath` names, which the migration takes away and builds again without changing its DDL: a
 * materialized view it drops, an object it drops before replacing a column it is built over, a table it converts a
 * column of), read off the target's edges in install order, a world object waiting for every relation, type and
 * function its statements read (`readsOf`); and each the target no longer holds. PostgreSQL refuses to convert, drop or
 * rename what a view, a policy or a function body reads beneath it, so dropping them first leaves every structural
 * change free, and they hold nothing a drop could lose.
 *
 * A world object depends on every compile input of what it reads: the keys its compilation proves uniqueness by and
 * the containments it proves existence by. A table's keys are in its CREATE TABLE, so its DDL changes with them; a
 * materialized view's keys and each relation's foreign keys are objects of their own (`compileInputsOf`), so a relation
 * whose unique indexes or foreign keys differ changes for the world objects waiting for it, though the relation itself
 * is kept. Which world objects a migration creates again then follows from the schema's change, never from whether the
 * optimizer's output for them happens to differ. */
const worldChangesOf = (
	previous: InstallationManifest<SqlStatement>,
	target: InstallationManifest<SqlStatement>,
	beneath: ReadonlySet<string>
): { readonly drops: ReadonlySet<string>; readonly creates: ReadonlySet<string> } => {
	const before = new Map(previous.objects.map((o) => [o.ident, o]))
	const after = new Set(target.objects.map((o) => o.ident))
	const changed = new Set<string>(beneath)
	for (const o of target.objects) {
		const was = before.get(o.ident)
		if (was === undefined || !same(was.ddl, o.ddl)) {
			changed.add(o.ident)
		}
	}
	const inputsBefore = compileInputsOf(previous)
	for (const [relation, inputs] of compileInputsOf(target)) {
		const was = inputsBefore.get(relation)
		if (was !== undefined && !sameInputs(was, inputs)) {
			changed.add(relation)
		}
	}
	for (const o of previous.objects) {
		if (!after.has(o.ident)) {
			changed.add(o.ident)
		}
	}
	const waitsFor = new Map<string, Array<string>>()
	for (const e of target.edges) {
		waitsFor.set(e.to, [...(waitsFor.get(e.to) ?? []), e.from])
	}
	const creates = new Set<string>()
	for (const o of target.objects) {
		if (!worldKinds.has(o.kind)) {
			continue
		}
		if (
			changed.has(o.ident) ||
			(waitsFor.get(o.ident) ?? []).some((from) => changed.has(from) || creates.has(from))
		) {
			creates.add(o.ident)
		}
	}
	const drops = new Set(
		previous.objects.flatMap((o) =>
			worldKinds.has(o.kind) && (!after.has(o.ident) || creates.has(o.ident)) ? [o.ident] : []
		)
	)
	return { drops, creates }
}

/** The sequence advance after declaring an existing field serial: past the stored maximum when it is positive, and
 * nothing on an empty table or one whose values are all below 1, which leaves the new sequence at its start: an
 * identity sequence starts at 1, its minimum, so it is already past every stored value below 1, and setval to one
 * would fall outside its bounds. */
const advance = (
	t: ObjectName,
	column: string,
	sequence: ObjectName,
	type: ColumnDef["type"]
): SqlStatement => {
	const value = col("r1", column)
	const argument =
		type.kind === "builtin" && type.name === "bigint" ? value : cast(value, types.bigint)
	return {
		...provedSelect(
			"oneRow",
			[
				targetAs(
					cast(call("setval", [{ kind: "regclass", relation: sequence }, argument]), types.text),
					"c1"
				)
			],
			[tableFrom(t.schema, t.name, "r1")],
			ge(value, lit.int(1n, types.integer))
		),
		orderBy: [desc(value)],
		limit: lit.int(1n, types.integer)
	}
}

/** The pure diff: previous snapshot plus target snapshot state, producing a phased plan.
 *
 * The diff compares the two manifests object by object, by graph identity, and drafts each
 * object rule below into its slot. It never reads a catalog: the previous snapshot is what the
 * database holds. Objects are visited in the target's install order for what is created or changed and
 * in the previous snapshot's reverse order for what is removed, so every slot lists its statements in dependency order
 * and equal inputs draft byte-identical files. A migration is plain ordered SQL: what the target no longer has is
 * dropped in the same migration, and nothing outlives it.
 *
 * A relation "may hold rows" when the previous snapshot installed it; one this migration creates is empty, so its
 * constraints are declared valid and its indexes built by ordinary CREATE INDEX in a transaction. The
 * rules, with their slots:
 *
 * - Adding a field: ADD COLUMN ... NOT NULL DEFAULT with a marked placeholder, then DROP DEFAULT (structure); a serial
 *   field is ADD COLUMN ... GENERATED ALWAYS AS IDENTITY and needs none.
 * - Removing a field: DROP COLUMN, at the end of Publish (publish.removed), after every statement that may still read
 *   it: the reviewer's data steps; a loss
 *   of its values, which the reviewer decides.
 * - Changing a field's type: the column is set aside (plan.ts SetAside), its new value the SQL the reviewer writes at a
 *   marked placeholder in its table's fill (structure.fill), or converted in place by its cast when the new type
 *   holds the old one's values (keepsValues: a pattern's domain for another pattern's, a contract added, removed or
 *   swapped for another over one base type), since a law's domain is its base type with a law: the cast keeps every
 *   value, and the new type's CHECK judges each as it runs, refusing a stored value with 23514. A roster's domain holds
 *   only its roster's handles, so a closed id or a set keeps its values only on the roster its own continues as
 *   (snapshot/build.ts rosterFates), and takes the placeholder when it moves to another or to or from an integer. What
 *   is built over the column, a constraint, an index or a statistics object, and the foreign keys referencing a key
 *   over it, is
 *   dropped first (structure.drop), since PostgreSQL would carry it across the conversion under its old definition or
 *   refuse the conversion under it, and is built again as the target declares it, as on a relation that may hold rows,
 *   but for a key, which is added again in the same Structure transaction right after the conversion, so it holds at
 *   every commit;
 *   the materialized views over the table are dropped and recreated. A serial column changing type gives its identity
 *   up before the conversion, which drops its sequence, and takes one again after it, advanced past the stored maximum.
 * - Declaring a field serial: ALTER COLUMN ... ADD GENERATED ALWAYS AS IDENTITY and the sequence advanced past the
 *   stored maximum in the same transaction; removing serial: DROP IDENTITY, which drops the sequence and its grants,
 *   so Publish revokes nothing on it (structure).
 * - A generated field: its expression changed, SET EXPRESSION (structure), which recomputes every row; its writing
 *   changed between its caller and a generation, its type changed, or a field it reads converted in place, dropped
 *   (structure.drop, a loss the reviewer decides when its caller wrote it) and added again (structure).
 * - A roster's change: its codes are drafted before the compile (ir/codes.ts draftCodebook), from the codes of the one
 *   roster it continues (snapshot/build.ts rosterFates), so a handle keeps its
 *   code, a removed one leaves a hole, a new or re-added one takes the next code, and a declaration out of the codes'
 *   order is refused before anything is drafted. What changes is content-addressed constants, so a roster's change
 *   rides the rules for objects: its new names constant (and a set's `live`) is a new object, created in Setup; the
 *   roster's domain keeps its name and its CHECK is re-pointed at the new constant, dropped and added NOT VALID
 *   (structure), then validated (validate), which names every row still holding a removed handle's code, its fix a data
 *   step's; a set's domain over bit(n) is re-pointed the same way when the roster loses a handle, and when it grows a
 *   new domain over bit(n′) types the column, converted by its cast to bit(n′), which pads every stored set with zeros
 *   (structure); the role views that read the old constant are dropped and created again (worldChangesOf); and the
 *   old constants and domains are dropped in Publish, RESTRICT, which fails naming any dependent the draft missed.
 * - A closed relation's rows: its constant is content-addressed, so a change is a new constant (Setup) and each table
 *   CHECK that reads it is re-pointed, NOT VALID (structure) then validated (validate), the old one dropped RESTRICT. A
 *   law that reads closed relations alone is discharged by the migration that states them: its violation query runs
 *   first in Setup, raising with the law's identity when the rows break it (migrationChecks).
 * - Changing a contract predicate: the domain's one constraint replaced in place under its name, dropped and added NOT
 *   VALID (structure), then validated (validate). A text pattern's domain is named by its pattern, so changing a
 *   field's pattern changes its type to the new pattern's domain, which holds the old one's values: a conversion by
 *   its cast.
 * - Adding a key to a relation that may hold rows: its unique index built concurrently (indexes), then the constraint
 *   attached USING INDEX (validate); a key with a span field is added directly in Validate, since PostgreSQL attaches
 *   only B-tree indexes. Changing a key builds the new index under a temporary name and swaps it in one statement.
 * - A key of a table both snapshots install that the migration removes or replaces under its name, over columns that
 *   are those of a key the target declares there: PostgreSQL binds a foreign key to the first unique index over its
 *   referenced columns and refuses that index's drop under it, so the key goes in Validate, once the target's keys are
 *   attached and before the foreign keys over those columns are added; the foreign keys that may be bound to it go
 *   before it and are added again after (replacedKey).
 * - Adding a row check or a containment to a relation that may hold rows: NOT VALID (structure), VALIDATE (validate);
 *   a containment that needs a key this migration attaches is added after it, in Validate.
 * - An installation's validation statements, the refined constants' casts to their domains: run in Publish when they
 *   are new or changed, as a pattern change changes the domain they cast to, or when a domain they cast to takes a new
 *   constraint, as a contract's predicate change does, so either validates the closed facts as well as the existing
 *   rows; removing them drops nothing.
 * - Adding a derived relation: its view WITH NO DATA and its unique indexes (structure). Changing a definition drops
 *   and recreates the view and every view above it that reads it, directly or through another, WITH NO DATA, with
 *   their indexes and statistics, and grants their privileges again. A view the target no longer has that reads a
 *   recreated one cannot outlive it, so it is dropped first, here.
 * - Workload changes add indexes and statistics (indexes); an index no law or program justifies any longer is dropped.
 * - World changes: a login's or role's PostgreSQL role created, its grants replaced and its memberships granted or
 *   revoked, a removed one's revoked and its role dropped (publish). A role's views, world functions (filter functions
 *   and key probes) and policies hold no data, so each the migration changes, or that reads anything it changes or
 *   takes away and builds again (a table, a column converted in place, a materialized view it
 *   drops, a relation whose keys or foreign keys it changes, a type, a function, another world object), is dropped at
 *   the start of Structure,
 *   before anything they read is converted or dropped; one the target no longer has is dropped there too
 *   (worldChangesOf). Each is created again
 *   at the end of Structure, in the same transaction, with its grants, when its role stands before the migration, so no
 *   committed state lacks a view or policy an existing role relies on; a role's the migration creates are created in
 *   Publish with the role. A
 *   role's schema is created in Publish and dropped at its end, and a table's row security enabled in Publish or
 *   disabled at its end. A login's rename is declared (`--rename @old=@new`) and carried out before the diff runs
 *   (declared.ts), its role renamed in place with its OID, password and grants, so the diff reads one login that
 *   stands; a login dropped, as declared, and another created are two roles, and the new one has no password until its
 *   operator sets one.
 * - Removing a law drops its native constraints in Publish.
 * - A rename is declared (`--rename`), and carried out before the diff runs (declared.ts): the previous snapshot is
 *   compared as it stands after it, so a renamed relation or field is changed in place like any other, a field whose
 *   type changes converted. Every drop of stored data, a relation with its rows, a field with its values or a roster's
 *   handle, is declared (`--drop`) and drafted as a statement; one no declaration names is refused. A schema's first
 *   migration beside schemas the configuration no longer lists starts the schema under the loss of their rows, a loss
 *   the reviewer decides (`LossDecision`): drafted commented, it runs only once the reviewer writes it in.
 * - A removed relation or domain whose name the target gives an object of the other kind is renamed aside first, in
 *   Setup, under a marker the reviewer confirms, and the diff starts from the previous snapshot as it is after that.
 *   PostgreSQL keeps a table's row type in the types' name space, so no order of statements could otherwise take the
 *   name while its holder stands, and a swap of names between the kinds has no order at all. */
export const diff = (input: DiffInput): Result.Result<MigrationPlan, CompileError> =>
	catchRefusal(() => new Differ(input).run())

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { dependencyOrder } from "@bjornpagen/grizzle-text/base/graph"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import {
	canonicalEquals,
	canonicalTextOf,
	catchRefusal,
	Refusal,
	unwrap
} from "#compiler/core/canonical.ts"
import { CompileError, unsupported } from "#compiler/core/errors.ts"
import {
	type Identity,
	identifierOf,
	identity,
	type TemporaryCensus,
	type TemporaryKind
} from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	type Comparator,
	compareNumbers,
	compareStrings,
	flip,
	mapInput,
	thenBy
} from "#compiler/core/order.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { type Aside, asideStatements } from "#compiler/deploy/diff/aside.ts"
import {
	type BackfilledTable,
	backfillOf,
	placeStart,
	type Carry,
	changedOver,
	type DrawnColumns,
	drawnColumns,
	fillReadsOf,
	replacedClosed
} from "#compiler/deploy/diff/backfill.ts"
import { type Departure, departureDrop } from "#compiler/deploy/diff/departed.ts"
import {
	type AbandonedSchema,
	type Action,
	alterationPass,
	alterTablePasses,
	alterationStatement,
	type ColumnConversion,
	type Draft,
	isTableSlot,
	type KeptView,
	type MigrationPlan,
	type RetypeReason,
	type SetAside,
	type Slot,
	type Step,
	type Swap,
	slots,
	type TableSlot
} from "#compiler/deploy/diff/plan.ts"
import {
	cutGrants,
	type GrantObject,
	type HeldPrivilege,
	heldOf,
	objectKey
} from "#compiler/deploy/diff/privileges.ts"
import {
	type AnyObject,
	type BuiltOver,
	builtOver,
	constraintColumns,
	type Installed,
	installed,
	keyOrCheckDefinition,
	type ManifestObject,
	objectTable,
	type Parts,
	partsAt,
	partsByTable,
	refuse
} from "#compiler/deploy/snapshot/objects.ts"
import {
	type ConstantHeader,
	type DeclaredHeader,
	type RecordedManifest,
	type RecordedObject,
	type RecordedStatement,
	samePrinted,
	sameRecord
} from "#compiler/deploy/snapshot/recorded.ts"
import type {
	DeploySnapshot,
	SnapshotContent,
	SnapshotLaw,
	SnapshotTheory,
	SnapshotWriting
} from "#compiler/deploy/snapshot/types.ts"
import type { LawChecks, MigrationCheck, RuleCheck } from "#compiler/deploy/snapshot/violation.ts"
import {
	keptRosters,
	type PreviousRoster,
	type RosterCodec,
	type RosterFate
} from "#compiler/ir/codes.ts"
import { type Head, headsOf } from "#compiler/ir/instant.ts"
import type { InstallationManifest, PhysicalKind } from "#compiler/ir/products.ts"
import { migrationGenerations } from "#compiler/laws/model/generation.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { guardBracket } from "#compiler/physical/ddl/immutable.ts"
import { headFill } from "#compiler/physical/ddl/stamps.ts"
import { type InlineSubcommand, notInline, wholeTable } from "#compiler/physical/ddl/whole.ts"
import { refreshStatement } from "#compiler/physical/derived/objects.ts"
import { targetKey, touchedTargets } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent, parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import {
	addedColumn,
	type AlterRole,
	type AlterTable,
	type AlterTableAction,
	type Collation,
	type ColumnDef,
	type CreateDomain,
	type CreateIndex,
	type CreateMaterializedView,
	type CreateTable,
	type Expr,
	type ForeignKey,
	type FunctionName,
	type Grant,
	type GrantColumns,
	type Grantee,
	type GrantRole,
	type ObjectName,
	type Revoke,
	type SqlStatement,
	type StoredGeneration,
	type TableConstraint,
	transactionInstant,
	type TypeRef,
	type TypeSchema,
	nameKey,
	type NameKey,
	type StoredColumnKey,
	storedColumnKey
} from "#compiler/sql/ast.ts"

import { dropLiveSlot } from "#compiler/physical/ddl/live.ts"
import {
	cast,
	columnKey,
	functionNameOf,
	objectName,
	tableCol,
	types
} from "#compiler/sql/build.ts"
import { anchorFor, type TableGeneration } from "#compiler/sql/generation.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	type AstHooks,
	generationColumns,
	identityHooks,
	ownColumnHooks,
	transformExpr,
	transformSelect,
	transformStatement
} from "#compiler/sql/transform.ts"

interface DiffInput {
	readonly previous: DeploySnapshot
	readonly target: SnapshotContent
	/** The compiled target, for the violation queries of the laws a migration discharges. */
	readonly installation: Installation
	/** The target's checks (snapshot/violation.ts lawChecks), the ones its snapshot records the identities of. */
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
	/**
	 * The objects of `previous` the database holds otherwise, by identity: a committed snapshot's draft has none; an
	 * upgrade's previous installation, read off the live catalog (render/generate.ts draftUpgrade), records each object
	 * the database holds under the target's identity and names but defines otherwise as the target's, so its drop names
	 * what the database holds, and each is changed as one whose record changed is: replaced, re-expressed, swapped or
	 * created again, by its kind's own rule.
	 */
	readonly stale: ReadonlySet<string>
	/**
	 * The objects the database holds that no object of the target is (departed.ts): none for a committed snapshot's
	 * draft; an upgrade's, in their drop order, each dropped in publish.removed after every removal of the diff's own,
	 * once everything the target creates in their place stands, as a removed object is.
	 */
	readonly departures: ReadonlyArray<Departure>
}

/**
 * Whether the diff changes an object of each kind that the database holds under the target's names but defines
 * otherwise (DiffInput stale), every kind decided here, so a new kind is a type error until it is: one of a kind whose
 * change the diff drafts by its kind's rule, from the target's record alone, which names what the database holds
 * (functions replaced in place, keys swapped, CHECKs and foreign keys redefined NOT VALID and validated, indexes built
 * and swapped in, triggers replaced under their table's lock, generated columns dropped and added again, the roles'
 * objects and materialized views created again, domain constraints replaced, memberships and publications replaced);
 * and none of a kind a draft never changes, or whose change the database holds in its rows (a table, the ledger), which
 * `grizzle upgrade` refuses before anything is drafted (the shell's adapter/admission/upgrade.ts).
 */
export const staleReplaced: { readonly [K in PhysicalKind]: boolean } = {
	schema: false,
	extension: false,
	constant: false,
	domain: true,
	functionOwner: false,
	rowType: false,
	declaredFunction: true,
	table: false,
	liveSecret: false,
	replicaIdentity: false,
	lawColumn: true,
	primaryKey: true,
	unique: true,
	check: true,
	foreignKey: true,
	refusalFunction: true,
	borrowFunction: true,
	head: true,
	isolationFunction: true,
	snapshotGuard: true,
	isolationTrigger: false,
	materializedView: true,
	uniqueIndex: true,
	index: true,
	statistics: true,
	validation: false,
	ruleJudge: true,
	lawFunction: true,
	lawTrigger: true,
	immutableGuard: true,
	immutableTrigger: true,
	role: false,
	decoder: false,
	membership: true,
	roleSchema: false,
	view: true,
	worldFunction: true,
	policy: true,
	rowSecurity: false,
	publication: true,
	privileges: false,
	ledger: false
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

/** What a set-aside holder owns that goes aside with it: a relation's indexes; a type, none. */
const ownedAside = (a: Aside): string =>
	(a.kind === "table" || a.kind === "materializedView") && a.owned.length > 0
		? ", with each index it owns, whose names a relation of its old name would take, renamed aside too"
		: ""

/** What a migration does to a column of a table it keeps (ColumnFates): kept, as it is or re-expressed by Structure's
 * SET EXPRESSION (KeptTable reexpressed); revalued, kept with its values changed in place, a field or law column the
 * backfill draws again (FieldChange redrawn) or a generated column that reads one (generatedOver), which PostgreSQL
 * computes again on each row the backfill writes; converted in place, a field whose type changes; redefined, a law
 * column whose definition changes, a field rewritten (rewrittenOver), or one the target no longer holds whose generation
 * reads a column the migration replaces or revalues (generatedOver), dropped before Structure's alteration and added
 * again where the target holds it; or dropped, at the end of the migration, a field or law column the target no longer
 * holds.
 *
 * A revalued column keeps what is built over it wherever no state the backfill passes through can break it, and the
 * rest is taken away before the backfill and built again after it, as over a replaced column (takenByReplacement):
 * - PostgreSQL maintains an index and a generated column on each row the backfill writes, and keeps a table's declared
 *   statistics through it: kept.
 * - It checks a CHECK on each row it writes, and the backfill writes each row of a table once, with every value it
 *   draws on that table: a CHECK the target keeps as it is reads the row as the backfill leaves it. Kept, but taken
 *   where the target defines it otherwise, since the previous definition would judge the drawn values.
 * - It checks a key that is not deferrable at each row it writes, against the rows not yet written: two rows whose
 *   values the backfill moves into each other's place break it on the way to a state that holds it. Kept only where
 *   the target keeps it as it is and its columns hold a stable key of its table, one the target keeps over columns the
 *   migration keeps as they are, which no two rows share before, during or after the backfill, so no row it writes meets
 *   another holding its key.
 * - It checks a foreign key at the end of each statement that writes a row it reads, on either side: where it reads
 *   revalued columns of two tables, the backfill's UPDATE of the first runs its checks against the second's stale
 *   values. Kept only where the target keeps it as it is, every revalued column it reads is on one table, which one
 *   UPDATE writes whole before its checks run against the table as the backfill leaves it, and the key it references
 *   is kept.
 * - A rule trigger its update fires is taken: its judge reads tables the backfill has yet to write. */
type ColumnFate =
	| { readonly kind: "kept" }
	| { readonly kind: "revalued" }
	| { readonly kind: "converted" }
	| { readonly kind: "redefined" }
	| { readonly kind: "dropped" }

const keptColumn: ColumnFate = { kind: "kept" }
const revaluedColumn: ColumnFate = { kind: "revalued" }
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

/** What a migration drops: an object of every kind but those no step drops (the schema, its ledger, its rule judge,
 * extensions and the database's defaults outlive it, the judge since every session's sentinel's trigger names it and
 * PostgreSQL refuses to drop a function another session's trigger runs; a validation installs nothing; privileges and
 * memberships are revoked, never dropped; an isolation trigger goes with its table), and a column. */
type Dropped =
	| Exclude<
			PhysicalKind,
			"extension" | "validation" | "privileges" | "ledger" | "membership" | "ruleJudge"
	  >
	| "column"

/** The one order in which a migration drops what it drops, by kind, each step that drops several sorting them by it
 * (dropWorlds, dropReplaced, publish.removed): the roles' policies before their views and the world functions they
 * call; the foreign keys before the keys they reference; the keys and CHECKs before the indexes, a row security
 * switched off beside them; then the roles and their schemas, the materialized views before
 * what they read, the functions, the law
 * columns and columns, the tables over the domains they use, the domains and the declared functions' row types over the
 * constants their CHECKs read, and the constants and the function owner last, which RESTRICT refuses to drop while
 * anything still reads one and DROP ROLE while it owns a function. Within a kind, each step keeps its own
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
	replicaIdentity: 5,
	role: 6,
	decoder: 6,
	publication: 6,
	roleSchema: 6,
	statistics: 7,
	materializedView: 9,
	lawTrigger: 3,
	immutableTrigger: 3,
	isolationTrigger: 3,
	refusalFunction: 11,
	borrowFunction: 11,
	head: 11,
	isolationFunction: 11,
	snapshotGuard: 11,
	lawFunction: 11,
	immutableGuard: 11,
	declaredFunction: 11,
	lawColumn: 12,
	column: 13,
	table: 14,
	liveSecret: 14,
	domain: 15,
	rowType: 15,
	constant: 16,
	functionOwner: 16,
	schema: 17
}

/** SET CONSTRAINTS ALL IMMEDIATE, before Structure's first data step (holdsDataSteps): an UPDATE of rows the
 * migration's own transaction wrote (a table rewritten by a generated column's ADD COLUMN or a conversion, or updated
 * by an earlier UPDATE) queues the check of every deferrable foreign key over them until the commit, since
 * PostgreSQL fires a referencing row's check whatever its keys when its own transaction wrote the row (REL_19_0
 * src/backend/utils/adt/ri_triggers.c RI_FKey_fk_upd_check_required at 1524, slot_is_current_xact_tuple at
 * 1596-1597), and refuses to alter a table with a check pending (src/backend/commands/tablecmds.c CheckTableNotInUse at
 * 4462, AfterTriggerPendingOnRel at 4476, 55006 at 4478), as a fill's DROP COLUMN, the backfill's DROP DEFAULT and
 * every constraint added after them do. Under it each check runs at the end of its UPDATE. It holds for the rest of the
 * Structure transaction, which every data step, the reviewer's, a fill's and the backfill's, runs after: Structure's
 * statements before it, its drops and its tables' alterations, write no row. */
const checkedAtOnce: SqlStatement = { kind: "setConstraintsImmediate" }

/**
 * Whether the previous installation held the law of `check` on every row this migration leaves it, as the previous
 * snapshot records it (`was`): by the rule judge under the same check identity, the law's own (violation.ts
 * MigrationCheck), or by its native objects at every write where the law's statement is its meaning (RuleCheck
 * `meaning`), and the migration writes again no column the check reads (`rewritten`, Differ.rewritten), since the
 * proof was of the values it replaces and no write the judge saw wrote the new ones. A law it did not state, or checked
 * once by its migration, it did not hold.
 */
const heldBefore = (
	was: SnapshotLaw | undefined,
	check: RuleCheck,
	rewritten: ReadonlySet<StoredColumnKey>
): boolean => {
	if (was === undefined || [...check.reads].some((column) => rewritten.has(column))) {
		return false
	}
	switch (was.kind) {
		case "trigger":
			return was.digest === check.digest
		case "native":
			return check.meaning === "stated"
		case "migration":
			return false
	}
}

/** A drop drafted with its kind's place in the drop order. */
interface Drop {
	readonly rank: number
	readonly draft: Action
}

const byDropOrder = mapInput(compareNumbers, (d: { readonly rank: number }) => d.rank)

const tableIdent = (name: ObjectName): string => qualifiedIdent("table", name.schema, name.name)

/**
 * The target's stamped heads a migration gives one value on every stored row of a table it adds them to, by their
 * table's key and their column, as the classifier read them (ir/instant.ts Head): each clock, which every stored row
 * takes the migration's instant of, and each unordered place (PlaceOrder `unordered`), which every stored row takes 0
 * of; a place ordered by a field is its backfill's (backfill.ts placeDerivation).
 */
const stampedHeadsOf = (
	installation: Installation
): ReadonlyMap<NameKey, ReadonlyMap<string, Head>> => {
	const out = new Map<NameKey, Map<string, Head>>()
	const put = (head: Head): void => {
		const table = installation.names.relation(head.relation)
		const key = nameKey(objectName(table.schema, table.name))
		const of = out.getOrInsertComputed(key, () => new Map<string, Head>())
		of.set(head.field.column, head)
	}
	for (const head of headsOf(installation.laws.theory.instants)) {
		if (head.kind === "clock" || head.order.kind === "unordered") {
			put(head)
		}
	}
	return out
}

/** Where the target's stored relation `relation` is declared, which a refusal of one of its fields names. */
const relationLoc = (installation: Installation, relation: string): SourceLoc =>
	defined(installation.laws.theory.relations[relation], `the theory holds the relation ${relation}`)
		.loc
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
	/** The columns Structure's alteration of the table re-expresses in place, by SET EXPRESSION: each field re-expressed
	 * (FieldChange reexpressed) and each law column whose STORED generation alone changes (reexpressedLawColumn) that no
	 * replacement takes. PostgreSQL computes each again on every row in that statement and rebuilds every constraint and
	 * index over it there, checking each CHECK, key and foreign key over the rows as the statement leaves them, before
	 * the backfill draws the columns it revalues (Differ.takenByReplacement). */
	readonly reexpressed: ReadonlySet<string>
}

/** The fate of the column `column` of a table both install, the one every part of the previous table is built over
 * has: a column its table lacks is a malformed snapshot. */
const columnFate = (kept: KeptTable, column: string): ColumnFate =>
	kept.fates.get(column) ?? refuse(kept.object.ident, `a table whose columns include ${column}`)

/** A kept table as its visit drafts it, planned before anything is drafted: its fields paired by name. */
interface KeptPlan {
	readonly table: KeptTable
	/** The previous declaration's fields the migration drops, each list in drop order, every field before the fields
	 * its generation reads (dependencyOrder), otherwise in column order: `first`, before Structure's alteration
	 * converts or adds any column, each one dropped and added again or removed over a column the migration replaces
	 * (ColumnFate redefined); `last`, at the end of the migration, every other field the target no longer holds (ColumnFate
	 * dropped). */
	readonly drops: {
		readonly first: ReadonlyArray<ColumnDef>
		readonly last: ReadonlyArray<ColumnDef>
	}
	/** The target's fields in its order, each new or with the previous field of its name. */
	readonly fields: ReadonlyArray<
		| { readonly kind: "added"; readonly column: ColumnDef }
		| { readonly kind: "held"; readonly column: ColumnDef; readonly was: ColumnDef }
	>
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
	readonly key: NameKey
	readonly view: Installed<RecordedObject> & { readonly kind: "materializedView" }
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
	readonly object: RecordedObject
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
	| { readonly kind: "follows"; readonly before: RecordedObject }
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
	readonly first: AlterTableAction
	readonly rest: Array<AlterTableAction>
}

/** Where the plan's steps stand while the visits draft them: a step drafted whole, or the place of a table's one
 * alteration in its slot, which later visits may still add subcommands to (Differ.alter). */
type Drafting =
	| { readonly kind: "step"; readonly step: Step }
	| { readonly kind: "created"; readonly table: CreatedTable }
	| { readonly kind: "alteration"; readonly slot: TableSlot; readonly alteration: TableAlteration }
	| { readonly kind: "fill"; readonly fill: TableFill }

/**
 * A table this migration creates, as the visits draft it: its CREATE TABLE, and the subcommands of its Structure
 * alteration a CREATE TABLE states itself (`inline`), in the order the visits draft them, the install order: its law
 * columns, each a column, and its own keys and CHECKs, each a constraint, so PostgreSQL creates the table whole
 * (physical/ddl/whole.ts wholeTable), as the installation's script creates it (wholeTables); 5.7 s of a fresh pantry
 * install's Structure of 7.7 s on postgres@perfphys were those subcommands as one ALTER TABLE after it.
 */
interface CreatedTable {
	readonly create: CreateTable
	readonly inline: Array<InlineSubcommand>
}

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
	transformExpr(
		e,
		ownColumnHooks((column) => aside.get(column) ?? column)
	)

/** Whether the subcommand `a` adds a column whose generation reads the column `b` adds, so it goes after it
 * (dependencyOrder): an ALTER TABLE adds its columns one by one, each generation read as its column is added. */
const readsAdded = (a: AlterTableAction, b: AlterTableAction): boolean => {
	const reader = addedColumn(a)
	const read = addedColumn(b)
	return (
		reader !== undefined &&
		read !== undefined &&
		generationColumns(reader.generated).includes(read.name)
	)
}

/**
 * A subcommand of a table's Structure alteration, its generated column over a set-aside field generated over the
 * set-aside column instead, which the fill renames into the field's name, so the expression reads the field once the
 * migration ends, PostgreSQL holding its reads by attribute number: a partial projection, NULL wherever it selects
 * nothing, as it is; any other added with no NOT NULL (addColumnUnchecked), since the set-aside column is NULL until the
 * fill, which sets its NOT NULL once the fill has drawn it (`checked`).
 */
const asideSubcommand = (
	a: AlterTableAction,
	aside: AsideColumns
): { readonly alteration: AlterTableAction; readonly checked: ReadonlyArray<string> } => {
	if (
		a.kind !== "addColumn" ||
		a.column.generated === undefined ||
		!generationColumns(a.column.generated).some((c) => aside.has(c))
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
	}
}
/** An alteration's subcommands in PostgreSQL's pass order, the order of drafting within a pass (alterationPass). */
const byPass = mapInput(compareNumbers, (a: AlterTableAction) =>
	alterTablePasses.indexOf(alterationPass(a))
)

/** The draft of a table's alteration, its subcommands in pass order, each added column after the columns its
 * generation reads (readsAdded): the one ALTER TABLE PostgreSQL runs as written. */
const alterationDraft = (a: TableAlteration, aside: AsideColumns): Action => ({
	kind: "alteration",
	table: a.table,
	actions: inPassOrder(a, aside)
})

/** An alteration's subcommands as its one ALTER TABLE runs them (alterationDraft): in pass order, each added column
 * after the columns its generation reads. */
const inPassOrder = (
	a: TableAlteration,
	aside: AsideColumns
): NonEmptyReadonlyArray<AlterTableAction> =>
	sortNonEmpty(
		dependencyOrder(
			mapNonEmpty([a.first, ...a.rest], (x) => asideSubcommand(x, aside).alteration),
			readsAdded
		),
		byPass
	)

/**
 * The steps of a table's fill: the fill itself, its UPDATE at the reviewer's values (Action fill), in structure.fill;
 * then its settling, in structure.settle, after every table's fill, so a fill that joins another table's old column,
 * a field set aside or declared dropped, reads it still standing under its name: the fields' old columns dropped; each
 * set-aside column renamed into its field's name; then one ALTER TABLE setting the NOT NULL of each field and of each
 * generated column over one (asideSubcommand's `checked`, read off the table's Structure alteration `structure`).
 */
const fillSteps = (
	fill: TableFill,
	structure: TableAlteration | undefined,
	aside: AsideColumns,
	generation: TableGeneration
): ReadonlyArray<Step> => {
	const t = fill.table
	const fields = mapNonEmpty([fill.first, ...fill.rest], (f) => f)
	const checked =
		structure === undefined
			? []
			: [structure.first, ...structure.rest].flatMap((a) => asideSubcommand(a, aside).checked)
	const settled = (s: SqlStatement): Step => ({ slot: "structure.settle", draft: statement(s) })
	return [
		{
			slot: "structure.fill",
			draft: {
				kind: "fill",
				table: t,
				fields,
				/** Each generated column over a set-aside field reads its set-aside column, which the fill sets
				 * (asideSubcommand). */
				anchor: anchorFor(
					generation,
					fields.map((f) => f.column.name)
				)
			}
		},
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
				...checked.map((column): AlterTableAction => ({ kind: "setNotNull", column }))
			])
		)
	]
}

/** A draft's alteration of one table, which a slot that alters each table once merges into the table's one: an ALTER
 * TABLE statement's actions, or an alteration's subcommands; any other draft is none. */
const alteredBy = (
	d: Draft
):
	| { readonly table: ObjectName; readonly actions: NonEmptyReadonlyArray<AlterTableAction> }
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
		case "zones":
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
	/** Each table this migration creates, by table key (nameKey): its CREATE TABLE and what it states itself. */
	readonly created = new Map<NameKey, CreatedTable>()
	/** Each table's one alteration in each slot that alters each table once, by table key (nameKey). */
	readonly alterations: { readonly [S in TableSlot]: Map<NameKey, TableAlteration> } = {
		structure: new Map(),
		"structure.constraints": new Map()
	}
	/** The keys structure.constraints adds again after their conversion (ownConstraint): a foreign key onto one is its
	 * own statement after the key's (foreignKey). */
	readonly constrainedKeys = new Set<KeyAfter>()
	/** Each table's fill of its set-aside fields, by table key (setAside). */
	readonly fills = new Map<NameKey, TableFill>()
	/** Each target table's generation as a fill's UPDATE meets it (laws/model/generation.ts). */
	readonly generationOf: (table: ObjectName) => TableGeneration
	readonly prev: ReadonlyMap<string, RecordedObject>
	readonly next: ReadonlyMap<string, ManifestObject>
	/** The parts of every relation of the previous and of the target installation, by name key (partsByTable). */
	readonly prevParts: ReadonlyMap<NameKey, Parts>
	readonly nextParts: ReadonlyMap<NameKey, Parts>
	/** The domains of the previous and the target installation (domainsOf), which a column of each is read through to
	 * what it holds (representationOf). */
	readonly prevDomains: ReadonlyMap<NameKey, DomainReading>
	readonly nextDomains: ReadonlyMap<NameKey, DomainReading>
	/** Each table both installations hold, by identity, with the fate of each of its columns (KeptTable). */
	readonly keptTables: ReadonlyMap<string, KeptTable>
	/** The stored columns whose values this migration writes again (rewrittenColumns): a rule that reads one is checked
	 * again, and a materialized view above its table is created again. */
	readonly rewritten: ReadonlySet<StoredColumnKey>
	/** The materialized views this migration drops at the start of Structure (viewDropsOf). */
	readonly viewDrops: ReadonlyArray<ViewDrop>
	/** What publish.removed drops, gathered while drafting and drafted in order once every removal is known
	 * (draftRemovals). */
	readonly removals: Array<Removal> = []
	/** Keys of relations that may hold rows that this migration attaches in Publish (publish.attach). */
	readonly attached = new Set<KeyAfter>()
	/** Every index this migration builds under a temporary name, as swapName mints it. */
	readonly swaps: Array<Swap> = []
	/** The keys of tables both snapshots install whose index this migration drops in Publish beside a key the target
	 * declares over the same columns, by identity (replacedKeysOf): each goes before the foreign keys over those columns
	 * are added (replacedKey, unbind). */
	readonly replaced: ReadonlyMap<string, ReplacedKey>
	/** Each table both installations hold as its visit drafts it, by identity (KeptPlan). */
	readonly keptPlans: ReadonlyMap<string, KeptPlan>
	/** Recreated materialized views, by table key: their privileges went with their drop. */
	readonly recreatedViews: ReadonlySet<NameKey>
	/** Relations this migration drops at the start of Structure and does not create again, by table key: a view the
	 * target no longer has that reads a recreated relation. Their privileges went with them. */
	readonly dropped: ReadonlySet<NameKey>
	/** What each installed materialized view reads, by table key: the previous snapshot's edges, and the qualified
	 * names of every installed definition. */
	readonly reads: ReadonlyMap<NameKey, ReadonlySet<NameKey>>
	/** The names of the roles' views and world functions this migration drops at the start of Structure, by name key,
	 * whose privileges went with them. */
	readonly worldGone: ReadonlySet<NameKey>
	/** Domains whose constraint this migration replaces, by name key: the validation statements that cast to one run
	 * again in Publish. */
	readonly reconstrained = new Set<NameKey>()
	/** The declared functions this migration drops and creates again under another signature, by name key: their
	 * privileges went with their drop. */
	readonly recreatedFunctions = new Set<NameKey>()
	/** Every object of the previous installation, in its install order, with its fate. */
	readonly previous: ReadonlyArray<Previous>
	/** Every object of the target, in its install order, with what it is to this migration. */
	readonly targets: ReadonlyArray<Target>
	/** What each object of the target that follows a previous one or replaces a taken one is, by identity (arrivalOf). */
	readonly arrivals: ReadonlyMap<string, Arrival>
	/** The columns the target's families draw, each with the placeholder default it is added under to a table that may
	 * hold rows (backfill.ts drawnColumns). */
	readonly drawn: DrawnColumns
	/** The target's stamped heads a migration gives one value on every stored row, by their table's key and their column
	 * (stampedHeadsOf): a clock or an unordered place this migration adds to a table that may hold rows (stampedColumn). */
	readonly stamped: ReadonlyMap<NameKey, ReadonlyMap<string, Head>>
	/** The target's heads by their tables' keys (physical/ddl/stamps.ts), which a head's fill reads its relation by. */
	readonly heads: ReadonlyMap<NameKey, Head>
	/** The drawn columns this migration adds to tables that may hold rows under their placeholders, by table key, in the
	 * order it adds them, which the backfill draws and then drops the default of. */
	readonly backfilled = new Map<
		NameKey,
		{ readonly table: ObjectName; readonly added: ReadonlyArray<string> }
	>()
	/** The columns this migration adds to tables that may hold rows that a containment carries from another table's
	 * stored rows (carryOf), which the backfill draws and then sets NOT NULL. */
	readonly carried: Array<Carry> = []
	/** The privileges Structure grants again right after the world object it creates again (regrantWorld), by key
	 * (privileges.ts HeldPrivilege), which Publish's grants leave out. */
	readonly regranted = new Set<string>()

	constructor(input: DiffInput) {
		this.input = input
		this.schema = input.target.schema
		this.drawn = drawnColumns(input.installation)
		this.stamped = stampedHeadsOf(input.installation)
		this.heads = new Map(
			headsOf(input.installation.laws.theory.instants).map(
				(h) => [nameKey(input.installation.names.head(h.relation, h.field.name)), h] as const
			)
		)
		this.generationOf = migrationGenerations(input.installation.laws, (r) =>
			input.installation.names.relation(r)
		)
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
		this.rewritten = rewrittenColumns(this.keptTables)
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
			...input.stale,
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
		const takenOf = (o: RecordedObject): Taken | undefined => {
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
		const removed = (o: RecordedObject): boolean => !this.next.has(o.ident) && !taken.has(o.ident)
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
			const old = this.redefinedConstraint(arrival.before, keyOrCheckDefinition(v, this.next))
			if (old === undefined) {
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
	 * target holds it no longer; of each law column, kept, redefined where its value changes, or dropped. A column a
	 * family draws whose fill reads a column whose values the migration changes, through any chain of the target's fill
	 * reads (backfill.ts fillReadsOf, changedOver), or whose fill reads a closed relation whose constants the target
	 * replaces (replacedClosed), is drawn again too: a copy of a column drawn again, a fold over one, a fold whose
	 * selection reads a closed relation whose rows changed, over every table, so no drawn value is left stale by what it
	 * was drawn from. */
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
				readonly object: RecordedObject
				readonly column: Installed<RecordedObject> & { readonly kind: "lawColumn" }
			}>
		>()
		for (const p of previousObjects) {
			const w = installed(p)
			if (w.kind !== "lawColumn") {
				continue
			}
			const key = nameKey(w.table)
			lawColumnsByTable.getOrInsertComputed(key, () => []).push({ object: p, column: w })
		}
		const tables = this.input.target.manifest.objects.flatMap((o) => {
			const v = installed(o)
			const at = previousTables.get(o.ident)
			if (v.kind !== "table" || at === undefined) {
				return []
			}
			const create = v.create
			const key = nameKey(create.table)
			const shared = sharedFields(at.old.columns, create.columns)
			const writtenBefore = previousWritings.get(create.table.name) ?? noWritings
			const writtenAfter = targetWritings.get(create.table.name) ?? noWritings
			keyGenerationsKept(o.ident, create.columns, writtenBefore, writtenAfter)
			const own = redrawn(
				fieldChangesOf(shared, (b, c) => this.retyped(b, c)),
				writtenBefore,
				writtenAfter
			)
			const lawColumns = (lawColumnsByTable.get(key) ?? []).map(({ object: p, column: w }) => {
				const now = this.next.get(p.ident)
				const target = now === undefined ? undefined : installed(now)
				/** What the migration does to the column: keeps it, re-expresses it in place (Differ.lawColumn), which
				 * computes it again on every row, rebuilding what is built over it (KeptTable reexpressed), and gives it
				 * other values to every fill that reads it, drops it, or drops it and adds it again. */
				const change =
					now === undefined
						? "dropped"
						: this.unchanged(p, now)
							? "kept"
							: target?.kind === "lawColumn" &&
								  this.reexpressedAs(p, target.definition) !== undefined
								? "reexpressed"
								: "redefined"
				const fate = {
					kept: keptColumn,
					reexpressed: keptColumn,
					redefined: redefinedColumn,
					dropped: droppedColumn
				}[change]
				const reads = builtOver(w, (c) => keyOrCheckDefinition(c, this.prev))?.columns ?? []
				return { column: w.column, reads, fate, change }
			})
			return [{ o, at, create, key, shared, own, lawColumns }]
		})
		const changed = changedOver(fillReadsOf(this.input.installation), [
			...tables.flatMap(({ key, own, lawColumns }) => [
				...[...own].flatMap(([column, change]) =>
					change.kind === "rewritten" || change.kind === "reexpressed" || change.kind === "redrawn"
						? [storedColumnKey(key, column)]
						: []
				),
				...lawColumns.flatMap((c) =>
					c.change === "redefined" || c.change === "reexpressed"
						? [storedColumnKey(key, c.column)]
						: []
				)
			]),
			...replacedClosed(previousObjects, this.input.installation.closed)
		])
		/** Whether the migration draws a column of the table `key` again: one the target's families draw whose values
		 * change. */
		const drawnAgain = (key: NameKey, column: string): boolean =>
			this.drawn.get(key)?.has(column) === true && changed.has(storedColumnKey(key, column))
		return new Map(
			tables.map(
				({
					o,
					at,
					create,
					key,
					shared,
					own: recordedChanges,
					lawColumns: recorded
				}): readonly [string, KeptTable] => {
					const { order } = at
					const old = at.old
					const own = new Map(
						[...recordedChanges].map(([column, change]): readonly [string, FieldChange] => [
							column,
							drawnAgain(key, column) ? drawnAnew(change) : change
						])
					)
					const changes = rewrittenOver(
						shared,
						own,
						shared.some(
							({ was, column }) =>
								changeOf(own, column.name).kind === "converted" &&
								this.conversion(was, { ...column, generated: undefined }).kind !==
									"placeholderRetype"
						)
					)
					const fields = old.columns.flatMap((b): ReadonlyArray<readonly [string, ColumnFate]> => {
						const change = changes.get(b.name)
						if (change === undefined) {
							return []
						}
						return [
							[
								b.name,
								change.kind === "converted"
									? convertedColumn
									: change.kind === "rewritten"
										? redefinedColumn
										: change.kind === "redrawn"
											? revaluedColumn
											: keptColumn
							]
						]
					})
					const removed = old.columns.flatMap((b) =>
						changes.has(b.name)
							? []
							: [{ column: b.name, reads: generationColumns(b.generated), fate: droppedColumn }]
					)
					const lawColumns = recorded.map((c) =>
						c.fate.kind === "kept" && drawnAgain(key, c.column) ? { ...c, fate: revaluedColumn } : c
					)
					const fieldFates = new Map(fields)
					const generatedFields = old.columns.flatMap((b) => {
						const fate = fieldFates.get(b.name)
						const reads = generationColumns(b.generated)
						return fate === undefined || !isNonEmpty(reads) ? [] : [{ column: b.name, reads, fate }]
					})
					const fates = generatedOver(fieldFates, [...generatedFields, ...removed, ...lawColumns])
					/** A re-expressed column whose generation reads a column the migration replaces is dropped and added
					 * again (generatedOver), and is no re-expression. */
					const reexpressed = new Set(
						[
							...[...changes].flatMap(([column, change]) =>
								change.kind === "reexpressed" ? [column] : []
							),
							...recorded.flatMap((c) => (c.change === "reexpressed" ? [c.column] : []))
						].filter((column) => fates.get(column)?.kind !== "redefined")
					)
					return [
						o.ident,
						{
							object: o,
							order,
							old,
							create,
							fates,
							changes,
							reexpressed
						}
					]
				}
			)
		)
	}

	/** The tables a column of which this migration writes again (Differ.rewritten), by table key: a materialized view
	 * above one would keep the rows of the values it replaces, and PostgreSQL refuses a conversion or a drop under it. */
	rewrittenTables(): ReadonlySet<NameKey> {
		return new Set(
			[...this.keptTables.values()].flatMap((k) => {
				const table = nameKey(k.create.table)
				return [...k.fates.keys()].some((column) =>
					this.rewritten.has(storedColumnKey(table, column))
				)
					? [table]
					: []
			})
		)
	}

	/** The tables of which this migration converts a field's column in place or drops and adds one again, by table key:
	 * PostgreSQL refuses either under a view that reads the column. */
	convertedTables(): ReadonlyArray<NameKey> {
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
	alter(
		slot: TableSlot,
		table: ObjectName,
		actions: NonEmptyReadonlyArray<AlterTableAction>
	): void {
		const key = nameKey(table)
		const created = slot === "structure" ? this.created.get(key) : undefined
		const altering = notInline(actions, created?.inline)
		if (!isNonEmpty(altering)) {
			return
		}
		const held = this.alterations[slot].get(key)
		if (held !== undefined) {
			appendAll(held.rest, altering)
			return
		}
		const [first, ...rest] = altering
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
			case "created":
				return [{ slot: "structure", draft: statement(wholeTable(d.table.create, d.table.inline)) }]
			case "alteration":
				return [{ slot: d.slot, draft: alterationDraft(d.alteration, this.asideOf(d)) }]
			case "fill":
				return fillSteps(
					d.fill,
					this.alterations.structure.get(nameKey(d.fill.table)),
					asideColumnsOf(d.fill),
					this.generationOf(d.fill.table)
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
		return unwrap(this.input.temporaries.admit(t))
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
	beforeOf(o: ManifestObject): RecordedObject | undefined {
		const arrival = this.arrivalOf(o)
		return arrival.kind === "follows" ? arrival.before : undefined
	}

	/** The definition of a table object; another kind has none. */
	createTableOf(o: AnyObject): CreateTable | undefined {
		const v = installed(o)
		return v.kind === "table" ? v.create : undefined
	}

	/** The definition of a constraint object of `objects`' manifest: a foreign key's own, or a key's or CHECK's
	 * (keyOrCheckDefinition). Every caller passes a constraint object, so another kind refuses. */
	constraintOf(o: AnyObject, objects: ReadonlyMap<string, AnyObject>): TableConstraint {
		const v = installed(o)
		if (v.kind === "foreignKey") {
			return v.constraint
		}
		if (v.kind !== "primaryKey" && v.kind !== "unique" && v.kind !== "check") {
			return refuse(o.ident, "a table constraint")
		}
		return keyOrCheckDefinition(v, objects)
	}

	/** The previous definition of the constraint `before` where the target's, `now`, defines it otherwise; none where the
	 * target holds it as it is. The one reading of a constraint kept, by its two definitions, each read through its own
	 * installation (constraintOf), never by its two records: an inline constraint's record holds no statement, its
	 * definition its table's CREATE TABLE's, so two records of one inline CHECK are one whatever each defines. Read by
	 * its records, a CHECK the target defines otherwise over a column the backfill draws again was kept through the
	 * backfill (takenByReplacement), its previous definition judging the drawn values, and the backfill refused rows the
	 * target's admits (S7's n_1_sentinel, 23514). */
	redefinedConstraint(before: RecordedObject, now: TableConstraint): TableConstraint | undefined {
		const old = this.constraintOf(before, this.prev)
		return !this.input.stale.has(before.ident) && canonicalEquals(old, now) ? undefined : old
	}

	/** Whether the previous object `before` is the target's `now` as the database holds it: the same record (recorded.ts
	 * sameRecord), and no object the database holds otherwise (DiffInput stale). The one reading of an object kept by its
	 * record. */
	unchanged(before: RecordedObject, now: ManifestObject): boolean {
		return !this.input.stale.has(before.ident) && sameRecord(before, now)
	}

	/** The STORED generation a law column `before` is re-expressed by where only its generation changes
	 * (reexpressedLawColumn); none for one the database holds otherwise (DiffInput stale), which is dropped and added
	 * again, its definition there being none the record states. */
	reexpressedAs(before: RecordedObject, definition: ColumnDef): StoredGeneration | undefined {
		return this.input.stale.has(before.ident) ? undefined : reexpressedLawColumn(before, definition)
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
		this.zoneChecks()
		this.dropWorlds()
		this.dropViews()
		this.dropReplaced()
		this.markAttached()
		for (const t of this.targets) {
			this.visit(t)
		}
		const written = this.dataSteps(this.backfill())
		if (isNonEmpty(written)) {
			this.push("structure.immediate", statement(checkedAtOnce))
			this.unguard()
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
		return { steps: this.orderedSteps(), swaps: this.swaps, keptViews: this.keptViews() }
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

	/**
	 * The check of each zone roster (closed.zones) whose names constant this migration creates, first in Setup beside the
	 * laws over closed relations alone: its handles each read as a time zone by the server, whose tzdata a production
	 * server holds its own of, so a handle that names none refuses the migration before anything changes, and no
	 * Time.wall over the roster raises. A roster whose names constant the previous installation holds was checked when
	 * it was installed, so a regenerate checks nothing, and a roster's handles changed are a new constant, checked once.
	 */
	zoneChecks(): void {
		const { installation, target } = this.input
		for (const roster of rostersOf(installation.owned)) {
			const codec = installation.names.codes.rosters.get(roster.closed)
			if (roster.order !== "zones" || codec === undefined || !isNonEmpty(roster.handles)) {
				continue
			}
			const names = qualifiedIdent(
				"function",
				target.schema,
				identifierOf(rosterConstants(codec).names)
			)
			if (!this.prev.has(names)) {
				this.push("setup", { kind: "zones", roster: roster.closed, zones: roster.handles })
			}
		}
	}

	/** The checks of the laws the rule judge holds (violation.ts lawChecks), in Validate, once every row the migration
	 * writes is written and before the rules' triggers are created: each law's violation query over every row, raising
	 * with the law's identity when it returns a row. A law is checked exactly when the previous installation did not hold
	 * it on every row (`heldBefore`), so a rule that is new, or whose definition changed, is checked once, a regenerate
	 * checks nothing, and neither does a containment its natives held, now discharged whole. */
	ruleChecks(checks: ReadonlyArray<RuleCheck>): void {
		for (const c of checks) {
			if (!heldBefore(this.input.previous.theory.laws[c.law], c, this.rewritten)) {
				this.push("validate", { kind: "violation", law: c.law, query: c.query })
			}
		}
	}

	/** The materialized views this migration drops first, decided once from the two snapshots: each view whose meaning
	 * changes (physical/derived/meaning.ts definitionMeanings), never its SQL alone, so a change of how grizzle lowers a
	 * definition keeps the view its earlier lowering installed, and a change of a field it reads, dropped or renamed, is
	 * a change of its meaning; each one whose installed definition names what the target no longer holds (readsGone);
	 * and every installed view above one of them or above a table whose column this migration converts or rewrites in
	 * place, which PostgreSQL refuses under a view that reads it. So a view the migration keeps reads, under the names it
	 * was installed with, only what the target holds as it was, and the target's snapshot records it as installed
	 * (keptViews). PostgreSQL refuses to drop a relation a view reads, so they go top-down
	 * (dropViews): one the target keeps is created again WITH NO DATA, and one it no longer has cannot outlive what it
	 * reads and is dropped with them. */
	viewDropsOf(): ReadonlyArray<ViewDrop> {
		const was = viewMeanings(this.input.previous)
		const now = viewMeanings(this.input.target)
		const held = qualifiedNames((hooks) => {
			for (const o of this.input.target.manifest.objects) {
				for (const ddl of o.ddl) {
					transformStatement(ddl, hooks)
				}
			}
		}, this.levelSchemas)
		const seeds = new Set<string>()
		for (const o of this.input.target.manifest.objects) {
			const v = installed(o)
			const before = this.prev.get(o.ident)
			if (v.kind !== "materializedView" || before === undefined) {
				continue
			}
			const ran = installed(before)
			if (
				ran.kind !== "materializedView" ||
				this.input.stale.has(o.ident) ||
				was.get(ran.create.name.name) !== now.get(v.create.name.name) ||
				this.readsGone(ran.create, held)
			) {
				seeds.add(relationKey(v))
			}
		}
		const dropping = new Set([
			...seeds,
			...this.viewsAbove(new Set([...seeds, ...this.rewrittenTables()]))
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

	/**
	 * Whether the installed definition `create` names a relation, type or function of the installation's schemas that no
	 * statement of the target names (`held`): one an earlier lowering read and the target's does without, or one the
	 * migration renames, which PostgreSQL refuses to drop under the view, and which a replay of the definition as
	 * installed would not find. A declared rename of a field the view reads changes its meaning (viewDropsOf).
	 */
	readsGone(create: CreateMaterializedView, held: ReadonlySet<NameKey>): boolean {
		return [
			...qualifiedNames((hooks) => {
				transformSelect(create.query, hooks)
			}, this.levelSchemas)
		].some((name) => !held.has(name))
	}

	/** The materialized views this migration keeps, each as it was installed: every view of the target the previous
	 * installation holds and no view drop takes away (viewDropsOf), by the definition the previous installation
	 * records, which the target's snapshot records in place of the target's own (render/generate.ts). */
	keptViews(): ReadonlyArray<KeptView> {
		return this.input.target.manifest.objects.flatMap((o) => {
			const v = installed(o)
			const before = this.prev.get(o.ident)
			if (
				v.kind !== "materializedView" ||
				before === undefined ||
				this.recreatedViews.has(relationKey(v))
			) {
				return []
			}
			const ran = installed(before)
			return ran.kind === "materializedView" ? [{ ident: o.ident, create: ran.create }] : []
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

	/** Drafts the view drops (viewDropsOf), top-down; the indexes and declared statistics on each go with it (Taken
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
	 * index, its table's declared statistics, a law column computed from it or a rule trigger fired by its update), and each foreign
	 * key referencing a key over one, which dropReplaced drops before the column is converted or dropped. Over a column
	 * the backfill revalues in place, what a state the backfill passes through could break (ColumnFate revalued), and
	 * over a column Structure re-expresses, what its SET EXPRESSION could break (KeptTable reexpressed), each dropped
	 * before Structure and built again after it as over a column dropped and added again. */
	takenByReplacement(): ReadonlyMap<string, Replaced> {
		const out = new Map<string, Replaced>()
		/** What this migration does to a column of `table`: only a table both hold has a column it replaces or
		 * revalues. */
		const fateAt = (table: ObjectName, column: string): ColumnFate["kind"] => {
			const kept = this.keptTables.get(tableIdent(table))
			return kept === undefined ? "kept" : columnFate(kept, column).kind
		}
		/** How each of `columns` of `table` is replaced, of those this migration converts or drops and adds again. */
		const replacedAt = (
			table: ObjectName,
			columns: ReadonlyArray<string>
		): ReadonlyArray<Replacement> =>
			columns.flatMap((c): ReadonlyArray<Replacement> => {
				const fate = fateAt(table, c)
				return fate === "converted" || fate === "redefined" ? [fate] : []
			})
		/** Whether the backfill revalues one of `columns` of `table` in place. */
		const revaluedAt = (table: ObjectName, columns: ReadonlyArray<string>): boolean =>
			columns.some((c) => fateAt(table, c) === "revalued")
		/** Whether the target holds the previous constraint `o` as it is: a constraint of its identity it does not define
		 * otherwise (redefinedConstraint). */
		const keptAsIs = (o: RecordedObject): boolean => {
			const now = this.next.get(o.ident)
			return (
				now !== undefined &&
				this.redefinedConstraint(o, this.constraintOf(now, this.next)) === undefined
			)
		}
		/** Each table's keys, by table key, each with its columns; and its stable ones, those the target keeps as they are
		 * over columns this migration keeps as they are, whose values, and so whose uniqueness, stand through the
		 * backfill. */
		const keys = new Map<
			string,
			Array<{ readonly object: RecordedObject; readonly columns: ReadonlyArray<string> }>
		>()
		const stable = new Map<string, Array<ReadonlyArray<string>>>()
		for (const o of this.prev.values()) {
			const v = installed(o)
			if (v.kind !== "primaryKey" && v.kind !== "unique") {
				continue
			}
			const key = nameKey(v.table)
			const columns = constraintColumns(keyOrCheckDefinition(v, this.prev))
			keys.getOrInsertComputed(key, () => []).push({ object: o, columns })
			if (keptAsIs(o) && columns.every((c) => fateAt(v.table, c) === "kept")) {
				stable.getOrInsertComputed(key, () => []).push(columns)
			}
		}
		/** Whether a revaluation takes the key `o` of `table` over `columns`: unless the target keeps it as it is and its
		 * columns hold a stable key of its table, which no two rows share, so no row the backfill writes meets a row
		 * holding its key, whatever the order it writes them in. */
		const takesKey = (
			o: RecordedObject,
			table: ObjectName,
			columns: ReadonlyArray<string>
		): boolean =>
			!keptAsIs(o) ||
			!(stable.get(nameKey(table)) ?? []).some((k) => k.every((c) => columns.includes(c)))
		/** The key of the table the foreign key `fk` references over exactly the columns it references. */
		const referencedKey = (fk: ForeignKey) => {
			const referenced = fk.referencedColumns.map((k) => k.column)
			return (keys.get(nameKey(fk.references)) ?? []).find(
				(k) =>
					k.columns.length === referenced.length && referenced.every((c) => k.columns.includes(c))
			)
		}
		/** Whether a revaluation takes the foreign key `o`: unless the target keeps it as it is, every revalued column
		 * it reads is on one table, which the backfill's one UPDATE of it writes whole before PostgreSQL checks the
		 * foreign key at the end of that statement, and the key it references is kept. */
		const takesForeignKey = (o: RecordedObject, fk: ForeignKey, table: ObjectName): boolean => {
			const from = revaluedAt(table, constraintColumns(fk))
			const onto = revaluedAt(
				fk.references,
				fk.referencedColumns.map((k) => k.column)
			)
			if (!keptAsIs(o) || (from && onto && nameKey(table) !== nameKey(fk.references))) {
				return true
			}
			if (!onto) {
				return false
			}
			const key = referencedKey(fk)
			return key === undefined || takesKey(key.object, fk.references, key.columns)
		}
		/** Whether a revaluation of a column `over` is built over takes `o` away (ColumnFate revalued). */
		const revaluationTakes = (o: RecordedObject, over: BuiltOver<RecordedObject>): boolean => {
			const v = over.part
			switch (v.kind) {
				case "index":
				case "statistics":
				case "lawColumn":
					return false
				case "uniqueIndex":
				case "lawTrigger":
					return true
				case "check":
					return !keptAsIs(o)
				case "primaryKey":
				case "unique":
					return takesKey(o, over.table, over.columns)
				case "foreignKey":
					return takesForeignKey(o, v.constraint, v.table)
			}
		}
		/** Whether Structure's alteration of `table` re-expresses one of `columns` in place (KeptTable reexpressed). */
		const reexpressedAt = (table: ObjectName, columns: ReadonlyArray<string>): boolean => {
			const kept = this.keptTables.get(tableIdent(table))
			return kept !== undefined && columns.some((c) => kept.reexpressed.has(c))
		}
		/** Whether a re-expression of a column `over` is built over takes `o` away, `o` reading `sides`: its own table's
		 * columns and a foreign key's referenced ones. SET EXPRESSION rebuilds every constraint and index over the column
		 * in its statement and checks each CHECK, key and unique index over the rows as it leaves them, before the
		 * backfill draws the columns it revalues. One stands only where the target holds it as it is and the backfill
		 * revalues no column it reads, each then holding its final value; otherwise its previous definition, or a stale
		 * column beside the re-expressed one, judges the new values, and PostgreSQL refuses rows the target admits. A
		 * foreign key, validated there against the key it references, goes too with that key where the re-expression
		 * takes it, the target defining it otherwise. An index and a rule trigger, which a rewrite does not fire, stand;
		 * no law column reads a generated column. A table's declared statistics go with the column's, which SET
		 * EXPRESSION clears (tablecmds.c ATExecSetExpression, RemoveStatistics), and are declared again whole. */
		const reexpressionTakes = (
			o: RecordedObject,
			over: BuiltOver<RecordedObject>,
			sides: ReadonlyArray<readonly [ObjectName, ReadonlyArray<string>]>
		): boolean => {
			const revalued = sides.some(([table, columns]) => revaluedAt(table, columns))
			const v = over.part
			switch (v.kind) {
				case "index":
				case "lawColumn":
				case "lawTrigger":
					return false
				case "statistics":
					return true
				case "uniqueIndex": {
					const now = this.next.get(o.ident)
					return now === undefined || !this.unchanged(o, now) || revalued
				}
				case "check":
				case "primaryKey":
				case "unique":
					return !keptAsIs(o) || revalued
				case "foreignKey": {
					const key = referencedKey(v.constraint)
					return (
						!keptAsIs(o) ||
						revalued ||
						key === undefined ||
						(reexpressedAt(v.constraint.references, key.columns) && !keptAsIs(key.object))
					)
				}
			}
		}
		for (const o of this.prev.values()) {
			const over = builtOver(installed(o), (c) => keyOrCheckDefinition(c, this.prev))
			if (over === undefined) {
				continue
			}
			const v = over.part
			const referenced: ReadonlyArray<readonly [ObjectName, ReadonlyArray<string>]> =
				v.kind === "foreignKey"
					? [[v.constraint.references, v.constraint.referencedColumns.map((k) => k.column)]]
					: []
			const sides = [[over.table, over.columns] as const, ...referenced]
			const how = strongestReplacement([
				...sides.flatMap(([table, columns]) => replacedAt(table, columns)),
				...((sides.some(([table, columns]) => revaluedAt(table, columns)) &&
					revaluationTakes(o, over)) ||
				(sides.some(([table, columns]) => reexpressedAt(table, columns)) &&
					reexpressionTakes(o, over, sides))
					? (["redefined"] as const)
					: [])
			])
			if (how !== undefined) {
				out.set(o.ident, { how, drops: replacementDrops(v) })
			}
		}
		return out
	}

	/** Drafts the drop of everything a replacement of a column takes away (Taken replaced), each by its own statement, in
	 * structure.drop, before the column is converted in place or dropped and added again: the foreign keys and the rule
	 * triggers first, then the keys and CHECKs, the indexes and the generated law columns
	 * (dropOrder). Nothing a replacement takes is left to the replacement itself, which converts or drops only the column;
	 * the target's are built again as on any relation that may hold rows. */
	dropReplaced(): void {
		const drops = this.previous
			.flatMap(({ fate }) => (fate.kind === "replaced" ? fate.drops : []))
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

	/** `views` in drop order: every view before the views it reads, and otherwise in the order given (dependencyOrder). */
	topDown(views: ReadonlySet<NameKey>): ReadonlyArray<NameKey> {
		const keys = [...views]
		return isNonEmpty(keys)
			? dependencyOrder(keys, (key, reader) => this.reads.get(reader)?.has(key) === true)
			: keys
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
			if (arrival.kind !== "follows" || this.redefinedConstraint(arrival.before, c) !== undefined) {
				this.attached.add(keyAfter(t, constraintColumns(c)))
			}
		}
	}

	/** Drafts what one object of the target needs, by what it is to this migration (Arrival).
	 *
	 * The refusal function, the isolation guard and the snapshot guard, created in Setup and replaced there in place when
	 * their definition changes: a function's name and signature are its identity, so CREATE OR REPLACE keeps its grants.
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
			case "borrowFunction":
			case "isolationFunction":
			case "snapshotGuard":
				if (before === undefined || !this.unchanged(before, o)) {
					this.sql("setup", o.ddl)
				}
				return
			case "ledger":
			case "extension":
				if (before === undefined) {
					this.sql("setup", o.ddl)
				} else if (!this.unchanged(before, o)) {
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
			case "head":
				if (before === undefined) {
					this.sql("structure.heads", [...o.ddl, ...this.headFillOf(v.create.table)])
				} else if (!this.unchanged(before, o)) {
					this.head(before, v.create.table, o.ddl)
				}
				return
			case "functionOwner":
				if (before === undefined) {
					this.sql("setup", o.ddl)
				} else if (!this.unchanged(before, o)) {
					this.sql(
						"setup",
						o.ddl.filter((s) => s.kind === "grant")
					)
				}
				return
			case "rowType":
				if (before === undefined) {
					this.sql("setup", o.ddl)
				}
				return
			case "declaredFunction":
				if (before === undefined) {
					this.sql("setup", o.ddl)
				} else if (!this.unchanged(before, o)) {
					this.declaredFunction(before, v.create, o.ddl)
				}
				return
			case "role":
				if (before === undefined) {
					this.roleObject(v)
				} else if (!this.unchanged(before, o)) {
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
				} else if (!this.unchanged(before, o)) {
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
			case "ruleJudge":
			case "lawFunction":
				if (before === undefined || !this.unchanged(before, o)) {
					this.sql("validate", o.ddl)
				}
				return
			case "immutableGuard":
				if (before === undefined) {
					this.sql("validate", o.ddl)
				} else if (!this.unchanged(before, o)) {
					this.sql(
						"validate",
						o.ddl.filter((s) => s.kind !== "revoke")
					)
				}
				return
			case "immutableTrigger":
			case "lawTrigger":
				if (before === undefined) {
					this.sql("validate", o.ddl)
				} else if (!this.unchanged(before, o)) {
					this.sql("validate", [
						{
							kind: "lockTable",
							tables: [v.create.table],
							mode: "SHARE ROW EXCLUSIVE",
							wait: "wait"
						}
					])
					this.sql("validate.retrigger", [
						{ kind: "dropTrigger", name: v.create.name, table: v.create.table, ifExists: false },
						...o.ddl
					])
				}
				return
			case "liveSecret":
			case "replicaIdentity":
				if (before === undefined) {
					this.sql("structure", o.ddl)
				}
				return
			case "publication":
				if (before !== undefined && !this.unchanged(before, o)) {
					this.sql("structure.drop", [{ kind: "dropPublication", name: v.create.name }])
				}
				if (before === undefined || !this.unchanged(before, o)) {
					this.sql("publish", o.ddl)
				}
				return
			case "decoder":
				if (before === undefined) {
					this.sql("publish.roles", o.ddl)
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
		const [world] = grantObjectsOf(v)
		if (world === undefined) {
			return
		}
		const key = objectKey(world)
		const grants = this.input.target.manifest.objects.flatMap((o) =>
			installed(o).kind === "privileges"
				? o.ddl.flatMap((g) => (g.kind === "grant" ? [g] : []))
				: []
		)
		const again = (h: HeldPrivilege): boolean =>
			objectKey(h.object) === key &&
			h.grantee.kind === "role" &&
			this.prev.has(namedIdent("role", h.grantee.name))
		for (const g of grants) {
			for (const h of heldOf(g)) {
				if (again(h)) {
					this.regranted.add(h.key)
				}
			}
		}
		this.sql("structure.worlds", cutGrants(grants, again))
	}

	/** A login's or a theory role's CREATE ROLE, in Publish. grizzle never sets a password, so a login dropped and created
	 * again under another name has none until its operator sets one. */
	/**
	 * A head whose table or stamp function changes (physical/ddl/stamps.ts): dropped, its function first, which returns
	 * its table's rows, then its table, and created again and filled from its relation in structure.heads, after every
	 * data step, so its children's heads start above every row the migration leaves stored, as a new head's do; the
	 * function's grants went with it, so they are granted again (recreatedFunctions).
	 */
	head(before: RecordedObject, table: ObjectName, ddl: ManifestObject["ddl"]): void {
		const previous = installed(before)
		if (previous.kind !== "head") {
			throw defect(`the head ${before.ident} was recorded as a head`)
		}
		this.recreatedFunctions.add(nameKey(previous.stamp.name))
		this.sql("structure.heads", [
			{ kind: "dropFunction", name: functionNameOf(previous.stamp), ifExists: false },
			{ kind: "drop", object: "TABLE", name: previous.create.table, ifExists: false },
			...ddl,
			...this.headFillOf(table)
		])
	}

	/**
	 * The fill of the head whose table the target names `table` (physical/ddl/stamps.ts headFill), where its relation's
	 * table may hold rows: a new relation's holds none, so its head starts empty, as a fresh installation's.
	 */
	headFillOf(table: ObjectName): ReadonlyArray<SqlStatement> {
		const head = defined(this.heads.get(nameKey(table)), `the head of the table ${table.name}`)
		return this.mayHoldRows(this.input.installation.names.relation(head.relation))
			? [headFill(this.input.installation.names, head)]
			: []
	}

	/**
	 * A declared function whose definition changes: replaced in place by CREATE OR REPLACE where its arguments' types and
	 * its result stand, which keeps its owner and its grants, as a body's change alone does; dropped first where either
	 * changed, since CREATE OR REPLACE would make a second function of the name or refuse a changed result (42P13), and
	 * handed over again by its own statements, its grants granted again (recreatedFunctions).
	 */
	declaredFunction(
		before: RecordedObject,
		create: DeclaredHeader,
		ddl: ManifestObject["ddl"]
	): void {
		const previous = installed(before)
		const recreated =
			previous.kind === "declaredFunction" &&
			(!canonicalEquals(functionNameOf(previous.create), functionNameOf(create)) ||
				!canonicalEquals(previous.create.returns, create.returns))
		if (recreated) {
			this.recreatedFunctions.add(nameKey(create.name))
		}
		this.sql("setup", [
			...(recreated
				? [
						{
							kind: "dropFunction",
							name: functionNameOf(previous.create),
							ifExists: false
						} as const
					]
				: []),
			...ddl
		])
	}

	roleObject(v: Installed & { readonly kind: "role" }): void {
		this.sql("publish.roles", [v.create])
	}

	/** The installed schema: created by the first migration, under the loss of the abandoned schemas' rows when the
	 * migrations directory holds any, and never changed. */
	schemaObject(o: ManifestObject, before: RecordedObject | undefined): void {
		if (before !== undefined) {
			if (!this.unchanged(before, o)) {
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
		before: RecordedObject | undefined
	): void {
		if (before === undefined) {
			this.sql("setup", v.object.ddl)
			return
		}
		const was = installed(before)
		if (was.kind !== "constant" || !this.unchanged(before, v.object)) {
			refuse(before.ident, "a constant whose name digests what it installs")
		}
	}

	domainObject(
		v: Installed & { readonly kind: "domain" },
		before: RecordedObject | undefined
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
			!canonicalEquals(
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
		 * holds two constraints, and validated against the stored values once Structure has converted what it must and
		 * every column the target no longer has is dropped (publish.validate), since PostgreSQL validates a domain over
		 * every column it types. */
		const a = was.constraint
		const b = v.constraint
		if (
			a !== undefined &&
			b !== undefined &&
			canonicalEquals(a, b) &&
			!this.input.stale.has(before.ident)
		) {
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
			this.sql("publish.validate", [
				{
					kind: "alterDomain",
					name: create.name,
					action: { kind: "validateConstraint", name: b.name }
				}
			])
		}
	}

	/** A kept table as its visit drafts it (KeptPlan): its fields paired by name, a field the target lacks removed, one
	 * the previous declaration lacks added. A declared rename renamed every field and relation before the diff, so a
	 * field of one name is one field. */
	planKept(kept: KeptTable): KeptPlan {
		const old = kept.old.columns
		/** The fields of fate `fate`, in drop order. */
		const dropped = (fate: "redefined" | "dropped"): ReadonlyArray<ColumnDef> => {
			const columns = old.filter((c) => columnFate(kept, c.name).kind === fate)
			return isNonEmpty(columns)
				? dependencyOrder(columns, (read, reader) =>
						generationColumns(reader.generated).includes(read.name)
					)
				: columns
		}
		return {
			table: kept,
			drops: { first: dropped("redefined"), last: dropped("dropped") },
			fields: kept.create.columns.map((c) => {
				const was = old.find((x) => x.name === c.name)
				return was === undefined
					? ({ kind: "added", column: c } as const)
					: ({ kind: "held", column: c, was } as const)
			})
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
			const changed = before === undefined || !this.unchanged(before, o)
			const recast = [
				...qualifiedNames((hooks) => {
					for (const ddl of o.ddl) {
						transformStatement(ddl, hooks)
					}
				}, this.levelSchemas)
			].some((k) => this.reconstrained.has(k))
			if (changed || recast) {
				this.sql("publish", o.ddl)
			}
		}
	}

	/** A table: one the previous installation lacks created; one both hold changed field by field (keptTable). */
	tableObject(v: Installed & { readonly kind: "table" }): void {
		const plan = this.keptPlans.get(v.object.ident)
		if (plan === undefined) {
			const created: CreatedTable = { create: v.create, inline: [] }
			this.created.set(nameKey(v.create.table), created)
			this.drafting.push({ kind: "created", table: created })
			return
		}
		this.keptTable(plan)
	}

	/** A table both installations hold, as planned (KeptPlan). Each field dropped and added again, or removed over a
	 * column the migration replaces, is dropped in structure.drop, before anything is converted or added; each other
	 * removed column, which the migration declares dropped, is dropped at the end of the migration, once nothing reads
	 * it any longer. */
	keptTable({ table: kept, drops, fields }: KeptPlan): void {
		const t = kept.create.table
		const drop = (c: ColumnDef): Action =>
			statement(alter(t, [{ kind: "dropColumn", column: c.name }]))
		for (const c of drops.first) {
			this.push("structure.drop", drop(c))
		}
		for (const c of drops.last) {
			this.removal(dropOrder.column, kept.order, drop(c))
		}
		for (const f of fields) {
			if (f.kind === "added") {
				this.alter("structure", t, [this.addedField(t, f.column)])
				continue
			}
			this.changeField(t, f.was, f.column, changeOf(kept.changes, f.column.name))
		}
	}

	/** What a field both tables hold drafts for its change from `b` to `c` (fieldChangesOf): a rewritten field dropped before
	 * anything is converted, in structure.drop, since PostgreSQL refuses to convert a column a generated column reads,
	 * and added again once the conversions ran (rewriteField); a kept one, nothing, nor a redrawn one, whose values the
	 * backfill draws again in place (backfill); otherwise its steps in place (changeInPlace). */
	changeField(t: ObjectName, b: ColumnDef, c: ColumnDef, change: FieldChange): void {
		if (change.kind === "rewritten") {
			this.rewriteField(t, c)
			return
		}
		if (change.kind === "kept" || change.kind === "redrawn") {
			return
		}
		this.changeInPlace(t, b, c, change)
	}

	/** A field of `t` dropped and added again, its writing changed between its caller and a generation, or a generated
	 * field's type changed or a field it reads converted (rewrittenOver): its drop, in structure.drop, before anything is
	 * converted, the values its caller wrote going as the schema now declares, which its table's visit drafts with the
	 * table's other drops there (keptTable); then its addition in Structure, a generated field by its expression and one
	 * its caller writes by the reviewer's placeholder. Every object built over the column is dropped before it
	 * (dropReplaced) and built again as the target declares it (ColumnFate redefined). */
	rewriteField(t: ObjectName, c: ColumnDef): void {
		this.alter("structure", t, [this.addedField(t, c)])
	}

	/** The addition of a field to a table that may hold rows: a column its family draws or a place, under its
	 * placeholder default, which the backfill overwrites (drawnColumn); a column a containment carries from rows its
	 * previous containment named, with no NOT NULL until the backfill draws it (carryOf); a generated field by its
	 * expression, which computes every row; any other by the reviewer's value for every row, at its placeholder. */
	addedField(t: ObjectName, c: ColumnDef): AlterTableAction {
		const drawn = this.drawnColumn(t, c)
		if (drawn !== undefined) {
			return drawn
		}
		const carry = this.carryOf(t, c)
		if (carry !== undefined) {
			this.carried.push(carry)
			return { kind: "addColumnUnchecked", column: c }
		}
		const stamped = this.stampedColumn(t, c)
		if (stamped !== undefined) {
			return stamped
		}
		return c.generated === undefined
			? { kind: "addColumnPlaceholder", column: c }
			: { kind: "addColumn", column: c }
	}

	/**
	 * The ADD COLUMN of a stamped head this migration adds to `t`, a table that may hold rows (stampedHeadsOf), under the
	 * DEFAULT of the one value every stored row takes at once, which the backfill's DROP DEFAULT then gives up
	 * (backfill.ts dropDefaults), so the column is the database's alone from its first row: a clock's, the migration's
	 * instant, the transaction's reading of the database's clock in its unit; an unordered place's, 0, the place of a
	 * group's first row. One value on every stored row keeps them apart at the new primary key exactly when that key holds
	 * the old one beside the column: else the column is refused, a clock's InstantRefused and a place's PlaceRefused
	 * `addedOverRows`, naming both keys. None for any other column, or one of a table that holds no row.
	 */
	stampedColumn(t: ObjectName, c: ColumnDef): AlterTableAction | undefined {
		const head = this.stamped.get(nameKey(t))?.get(c.name)
		const kept = this.keptTables.get(tableIdent(t))
		if (head === undefined || kept === undefined || !this.mayHoldRows(t)) {
			return undefined
		}
		const key = mapNonEmpty(kept.create.primaryKey.columns, (k) => k.column)
		const held = mapNonEmpty(kept.old.primaryKey.columns, (k) => k.column)
		if (!held.every((column) => column !== c.name && key.includes(column))) {
			const at = relationLoc(this.input.installation, head.relation)
			const rule = { kind: "addedOverRows", key, held } as const
			throw new Refusal(
				head.kind === "clock"
					? CompileError.make({
							_tag: "InstantRefused",
							at,
							relation: head.relation,
							field: head.field.name,
							rule
						})
					: CompileError.make({
							_tag: "PlaceRefused",
							at,
							relation: head.relation,
							field: head.field.name,
							rule
						})
			)
		}
		const tableKey = nameKey(t)
		this.backfilled.set(tableKey, {
			table: t,
			added: [...(this.backfilled.get(tableKey)?.added ?? []), c.name]
		})
		return {
			kind: "addColumnDefault",
			column: c,
			default:
				head.kind === "clock"
					? {
							kind: "clock",
							of: { kind: "stamp" },
							instant: transactionInstant,
							unit: "micros",
							type: types.bigint
						}
					: placeStart(this.input.installation, head)
		}
	}

	/**
	 * The carry of `c`, a column this migration adds to `t`, a table that may hold rows (Carry): a foreign key of the
	 * target from `t` holds `c` paired with a column of a table `s` that may hold rows, and a foreign key of the previous
	 * installation from `t` into `s` holds every other pair of the target's and not `c`, over columns its tables keep
	 * standing through the backfill, none generated. Every stored row of `t` then names one row of `s` by the previous
	 * key, the one it was contained in, and takes that row's value, so the target's containment holds of it at the row it
	 * named before; none where no such pair of keys is, and `c` is the reviewer's.
	 */
	carryOf(t: ObjectName, c: ColumnDef): Carry | undefined {
		const kept = this.keptPlans.get(tableIdent(t))
		if (c.generated !== undefined || kept === undefined || !this.mayHoldRows(t)) {
			return undefined
		}
		const key = nameKey(t)
		const pairsOf = (fk: ForeignKey): ReadonlyArray<readonly [string, string]> =>
			fk.columns.map(
				(k, i) => [k.column, defined(fk.referencedColumns[i], "a paired column").column] as const
			)
		/** Whether `columns` of `table` stand through the backfill, each a field of its stored rows, none generated. */
		const standing = (table: ObjectName, columns: ReadonlyArray<string>): boolean => {
			const plan = this.keptPlans.get(tableIdent(table))
			return (
				plan !== undefined &&
				columns.every(
					(name) =>
						plan.table.old.columns.some((o) => o.name === name && o.generated === undefined) &&
						!plan.drops.first.some((d) => d.name === name)
				)
			)
		}
		for (const o of this.next.values()) {
			const v = installed(o)
			if (v.kind !== "foreignKey" || nameKey(v.table) !== key) {
				continue
			}
			const target = pairsOf(v.constraint)
			const at = target.find(([from]) => from === c.name)
			const source = v.constraint.references
			if (at === undefined || !this.mayHoldRows(source)) {
				continue
			}
			const others = target.filter(([from]) => from !== c.name)
			for (const p of this.prev.values()) {
				const w = installed(p)
				if (
					w.kind !== "foreignKey" ||
					nameKey(w.table) !== key ||
					nameKey(w.constraint.references) !== nameKey(source)
				) {
					continue
				}
				const before = pairsOf(w.constraint)
				const met =
					!before.some(([from]) => from === c.name) &&
					others.every(([from, to]) => before.some(([f, r]) => f === from && r === to)) &&
					standing(
						t,
						before.map(([from]) => from)
					) &&
					standing(
						source,
						before.map(([, to]) => to)
					)
				const [first, ...rest] = before
				if (!met || first === undefined) {
					continue
				}
				const keyed: NonEmptyReadonlyArray<readonly [string, string]> = [first, ...rest]
				return {
					table: t,
					column: c.name,
					base: baseOf(c.type, this.nextDomains),
					source,
					value: at[1],
					targetKey: mapNonEmpty(keyed, ([from]) => from),
					sourceKey: mapNonEmpty(keyed, ([, to]) => to)
				}
			}
		}
		return undefined
	}

	/** The ADD COLUMN of a column of `t` its family draws, when `t` may hold rows: under the placeholder default the value
	 * an empty family holds, recorded for the backfill (backfill.ts), which draws it over the stored rows and then drops
	 * the default. A column no family draws, or one added to a table that holds no row, takes none. */
	drawnColumn(t: ObjectName, c: ColumnDef): AlterTableAction | undefined {
		const key = nameKey(t)
		const drawn = this.drawn.get(key)?.get(c.name)
		if (drawn === undefined || c.generated !== undefined || !this.mayHoldRows(t)) {
			return undefined
		}
		this.backfilled.set(key, {
			table: t,
			added: [...(this.backfilled.get(key)?.added ?? []), c.name]
		})
		return { kind: "addColumnDefault", column: c, default: drawn.placeholder }
	}

	/** The backfill of the families new to stored rows and of the columns drawn again (backfill.ts), once every column it
	 * draws is added: its UPDATEs, then each added column's DROP DEFAULT, before any constraint that reads them
	 * (structure.constraints). It draws, on each table both install, every column of it a family draws that this
	 * migration revalues in place (ColumnFate revalued) beside those it adds. The tables its UPDATEs write. */
	backfill(): ReadonlyArray<ObjectName> {
		const drawn = new Map<NameKey, BackfilledTable>(
			[...this.backfilled].map(
				([key, { table, added }]) => [key, { table, added, redrawn: [] }] as const
			)
		)
		for (const k of this.keptTables.values()) {
			const table = k.create.table
			const key = nameKey(table)
			const of = this.drawn.get(key)
			const redrawn = [...k.fates].flatMap(([column, fate]) =>
				fate.kind === "revalued" && of?.has(column) === true ? [column] : []
			)
			if (redrawn.length > 0) {
				drawn.set(key, { table, added: drawn.get(key)?.added ?? [], redrawn })
			}
		}
		const { checks, updates, dropDefaults, notNulls } = backfillOf({
			installation: this.input.installation,
			previous: this.input.previous.theory,
			mayHoldRows: (t) => this.mayHoldRows(t),
			drawn,
			carried: this.carried
		})
		for (const c of checks) {
			this.push("structure.backfill", { kind: "violation", law: c.law, query: c.query })
		}
		this.sql("structure.backfill", [...updates, ...dropDefaults, ...notNulls])
		return updates.flatMap((u) => (u.kind === "update" ? [u.table] : []))
	}

	/** The tables Structure's data steps write rows of: each a reviewer's UPDATE a placeholder column invites, a fill or
	 * the backfill's (`backfilled`) writes, each once, none where Structure holds no data step. Each runs after SET
	 * CONSTRAINTS ALL IMMEDIATE (checkedAtOnce, structure.immediate), before which Structure runs no UPDATE: its drops
	 * and its tables' alterations, which write no row. */
	dataSteps(backfilled: ReadonlyArray<ObjectName>): ReadonlyArray<ObjectName> {
		const tables = new Map<NameKey, ObjectName>()
		for (const t of [
			...backfilled,
			...[...this.fills.values()].map((f) => f.table),
			...[...this.alterations.structure.values()].flatMap((a) =>
				[a.first, ...a.rest].some((x) => x.kind === "addColumnPlaceholder") ? [a.table] : []
			)
		]) {
			tables.set(nameKey(t), t)
		}
		return [...tables.values()]
	}

	/**
	 * The bracket of Structure's data steps (physical/ddl/immutable.ts guardBracket), where it holds one: every guard the
	 * previous installation holds on a table the target keeps, its trigger dropped at the end of Structure, before SET
	 * CONSTRAINTS ALL IMMEDIATE and the first data step, and created again as the previous installation created it in
	 * structure.constraints, after the last, in Structure's one transaction, so what Validate drafts of the guard reads
	 * the previous installation's trigger standing, as it would with no bracket. Every such table, never only those the
	 * draft's own steps write: a reviewer's data step written at that place (README, Migrations) writes what it writes, a
	 * guarded table's rows a removed code holds among them, which the guard would refuse as a change of a fixed field; no
	 * other transaction sees a table without its guard, nor any committed state holds one so. A table the previous
	 * installation does not guard takes its guard in Validate, after every data step.
	 */
	unguard(): void {
		const kept = new Set(
			[...this.next.values()].flatMap((o) => {
				const v = installed(o)
				return v.kind === "table" ? [nameKey(v.create.table)] : []
			})
		)
		const guards = [...this.prev.values()].flatMap((o) => {
			const v = installed(o)
			return v.kind === "immutableTrigger" && kept.has(nameKey(v.create.table)) ? [v.create] : []
		})
		const bracket = guardBracket(guards)
		this.sql("structure", bracket.drop)
		this.sql("structure.constraints", bracket.create)
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

	/** A column a law adds: added with its table's other objects, kept while its definition is the previous one's,
	 * re-expressed in place where its STORED generation alone changes (reexpressedLawColumn), in its table's one ALTER
	 * TABLE of Structure, and dropped and added again when anything else of it changes. */
	lawColumn(
		v: Installed & { readonly kind: "lawColumn" },
		before: RecordedObject | undefined
	): void {
		const { object: o, table: t, column } = v
		if (before !== undefined) {
			if (this.unchanged(before, o)) {
				return
			}
			const generation = this.reexpressedAs(before, v.definition)
			if (generation !== undefined) {
				this.alter("structure", t, [{ kind: "setExpression", column, generation }])
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
		const old = was === undefined ? undefined : this.redefinedConstraint(was, c)
		if (was !== undefined && old === undefined) {
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
			this.sql("publish.attach", [
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
		this.sql("publish.attach", [
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
	 * before the key is swapped in the same Publish file, since PostgreSQL refuses to drop a key a foreign key depends
	 * on (2BP01): each removed one (Fate unbound), since a removed law cannot be enforced natively once its key is gone,
	 * so it is dropped here rather than in publish.drop; and each one the target keeps unchanged (rebind). A foreign key
	 * the target changes is foreignKey()'s. */
	unbind(key: string, was: string): void {
		for (const { object: o, fate } of this.previous) {
			const v = installed(o)
			if (fate.kind === "unbound" && fate.by === key && v.kind === "foreignKey") {
				this.sql("publish.attach", [alter(v.table, [{ kind: "dropConstraint", name: v.name }])])
			}
		}
		this.rebind(was)
	}

	/** The keys of tables both snapshots install whose index this migration drops in Publish while the table holds
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
			const target = now === undefined ? undefined : this.constraintOf(now, this.next)
			if (target !== undefined && this.redefinedConstraint(o, target) === undefined) {
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
	 * so the old one is dropped in Publish, after the target's is attached and before the foreign keys over those
	 * columns are added (foreignKey): each removed foreign key that references it is dropped before it (remove), and each
	 * one the target keeps unchanged as well (rebind). */
	replacedKey(o: RecordedObject, name: string, t: ObjectName): boolean {
		if (!this.replaced.has(o.ident)) {
			return false
		}
		this.rebind(o.ident)
		this.sql("publish.attach", [alter(t, [{ kind: "dropConstraint", name }])])
		return true
	}

	/** The foreign keys the target keeps unchanged over a key it declares beside the key `ident`, which this migration
	 * drops in Publish (replaced): each may depend on the dropped key's index, which PostgreSQL then refuses to drop
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
			if (this.redefinedConstraint(before, fk) !== undefined) {
				continue
			}
			this.sql("publish.attach", [alter(source, [{ kind: "dropConstraint", name: fk.name }])])
			this.sql("publish.references", [
				alter(source, [{ kind: "addConstraint", constraint: fk, notValid: true }])
			])
			this.sql("revalidate", [alter(source, [{ kind: "validateConstraint", name: fk.name }])])
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
		before: RecordedObject | undefined
	): void {
		const { table: t, constraint: c } = v
		if (before !== undefined) {
			const old = this.redefinedConstraint(before, c)
			if (old === undefined) {
				return
			}
			if (!this.input.stale.has(before.ident) && this.deferralAlone(old, c)) {
				this.sql("publish.attach", [
					alter(t, [{ kind: "alterConstraintDeferral", name: c.name, deferrable: c.deferrable }])
				])
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
			this.sql("publish.references", [add(true)])
			this.sql("revalidate", [alter(t, [{ kind: "validateConstraint", name: c.name }])])
			return
		}
		constrained(add(true))
		this.sql("validate", [alter(t, [{ kind: "validateConstraint", name: c.name }])])
	}

	/**
	 * Whether a foreign key the target keeps changes its deferral alone, over a key no part of this migration attaches or
	 * replaces: ALTER CONSTRAINT then changes it in place, in Publish (publish.attach), a catalog update that reads no row
	 * and keeps every reference it holds, where a drop, a NOT VALID addition and a VALIDATE would read every row again.
	 * A key attached or replaced here takes the foreign key with it (foreignKey, rebind).
	 */
	deferralAlone(old: TableConstraint, c: ForeignKey): boolean {
		return (
			old.kind === "foreignKey" &&
			old.deferrable !== c.deferrable &&
			canonicalEquals({ ...old, deferrable: c.deferrable }, c) &&
			!this.attached.has(referencedAfter(c)) &&
			!this.replaces(referencedAfter(c)) &&
			!this.referencesReplaced(old)
		)
	}

	/** A materialized view, created WITH NO DATA when it follows no previous view (Arrival): new, or dropped at the start
	 * of Structure (viewDropsOf). One that stands means what the target's definition means, since one whose meaning
	 * changed is dropped. It is created in structure.views, after every table's fill, so it reads each set-aside field
	 * under its name, as the fill leaves it, never the column the fill drops, and populated in structure.refresh, after
	 * the backfill writes the last row it reads and after every view below it, which install order visits first, so the
	 * migration that creates a view leaves it populated. */
	view(
		v: Installed & { readonly kind: "materializedView" },
		before: RecordedObject | undefined
	): void {
		if (before === undefined) {
			this.sql("structure.views", v.object.ddl)
			this.sql("structure.refresh", [refreshStatement(v.create.name, false)])
		}
	}

	index(
		v: Installed & { readonly kind: "index" | "uniqueIndex" },
		before: RecordedObject | undefined
	): void {
		const { object: o, create } = v
		const t = create.table
		if (before !== undefined && this.unchanged(before, o)) {
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
		this.sql("publish.attach", [
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
		before: RecordedObject | undefined
	): void {
		const { object: o, create } = v
		if (before !== undefined && this.unchanged(before, o)) {
			return
		}
		this.sql("indexes", [create])
	}

	/** An object the target no longer has and no step takes away first (Fate removed), dropped in place by a statement
	 * of its own, whatever else the migration drops: in publish.removed (draftRemovals) at its kind's rank, once nothing
	 * of the target reads it, so it goes before what it depends on (dropOrder), a rule trigger before its function and
	 * its table; a constraint in publish.drop, before.
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
	 * A removed reference is dropped with every other removed reference, so no drop of a key it references waits on it:
	 * in Publish, before the key, when the key it references is a removed one the target's replaces (replacedKey);
	 * otherwise in publish.drop, which drafts every foreign key before the keys, in the reverse install order.
	 *
	 * A table's isolation trigger is dropped with its table's other objects, or on its own where the target guards its
	 * table no more: every role that writes it is certified READ COMMITTED (physical/ddl/isolation.ts
	 * readCommittedRelations). */
	remove(o: RecordedObject, order: number): void {
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
			case "ruleJudge":
				throw new Refusal(
					unsupported(
						SourceLoc(`object ${o.ident}`, []),
						"removing the rule judge, which every installation holds"
					)
				)
			case "extension":
			case "privileges":
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
				drop(v.kind, statement(alter(v.table, [{ kind: "disableRowSecurity" }])))
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
			case "head":
				drop(
					v.kind,
					statement({ kind: "dropFunction", name: functionNameOf(v.stamp), ifExists: false })
				)
				drop(
					v.kind,
					statement({ kind: "drop", object: "TABLE", name: v.create.table, ifExists: false })
				)
				return
			case "refusalFunction":
			case "borrowFunction":
			case "isolationFunction":
			case "snapshotGuard":
			case "lawFunction":
			case "immutableGuard":
				drop(
					v.kind,
					statement({ kind: "dropFunction", name: functionNameOf(v.create), ifExists: false })
				)
				return
			case "declaredFunction":
				drop(
					v.kind,
					statement({
						kind: "dropFunction",
						name: functionNameOf(v.create),
						ifExists: false
					})
				)
				return
			case "rowType":
				drop(
					v.kind,
					statement({ kind: "drop", object: "TYPE", name: v.create.name, ifExists: false })
				)
				return
			case "functionOwner":
				for (const g of o.ddl) {
					if (g.kind === "grant") {
						this.removal(
							dropOrder.role,
							order,
							statement({ kind: "revoke", privileges: g.privileges, on: g.on, from: g.to })
						)
					}
				}
				drop(
					v.kind,
					statement({ kind: "drop", object: "ROLE", name: v.create.name, ifExists: false })
				)
				return
			case "immutableTrigger":
			case "lawTrigger":
				drop(
					v.kind,
					statement({
						kind: "dropTrigger",
						name: v.create.name,
						table: v.create.table,
						ifExists: false
					})
				)
				return
			case "lawColumn":
				drop(v.kind, statement(alter(v.table, [{ kind: "dropColumn", column: v.column }])))
				return
			case "primaryKey":
			case "unique":
			case "check":
			case "foreignKey": {
				if (v.kind === "foreignKey" && this.referencesReplaced(v.constraint)) {
					this.sql("publish.attach", [alter(v.table, [{ kind: "dropConstraint", name: v.name }])])
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
				const s = v.create
				const name = objectName(s.table.schema, s.name)
				drop(v.kind, statement({ kind: "dropIndex", name, concurrently: false, ifExists: false }))
				return
			}
			case "statistics":
				return
			case "role":
			case "decoder":
				drop(
					v.kind,
					statement({ kind: "drop", object: "ROLE", name: v.create.name, ifExists: false })
				)
				return
			case "liveSecret":
				drop(
					v.kind,
					statement({ kind: "drop", object: "TABLE", name: v.create.table, ifExists: false })
				)
				return
			case "replicaIdentity":
				drop(v.kind, statement(alter(v.table, [{ kind: "replicaIdentity", identity: "default" }])))
				return
			case "publication":
				this.sql("structure.drop", [
					{ kind: "dropPublication", name: v.create.name },
					dropLiveSlot(v.create.name)
				])
				return
			case "isolationTrigger":
				drop(
					v.kind,
					statement({
						kind: "dropTrigger",
						name: v.create.name,
						table: v.create.table,
						ifExists: false
					})
				)
				return
		}
	}

	/** Drafts the removals in publish.removed: in the drop order (dropOrder), then reverse install order, then (the sort
	 * being stable) as drafted. */
	draftRemovals(): void {
		const ordered = this.removals.toSorted(
			thenBy(
				mapInput(compareNumbers, (r: Removal) => r.rank),
				mapInput(flip(compareNumbers), (r: Removal) => r.order)
			)
		)
		for (const r of ordered) {
			this.push("publish.removed", r.draft)
		}
		for (const d of this.input.departures) {
			this.sql("publish.removed", [departureDrop(d)])
		}
	}

	/**
	 * The privileges this migration changes, one privilege of one grantee on one object at a time (privileges.ts): every
	 * privilege a previous `privileges` object states and no target one does is revoked, and every privilege a target
	 * one states and no previous one does is granted; a privilege both state is neither, so an object a migration leaves
	 * alone keeps its grants, whatever changes beside it. An object this migration creates again (a materialized view, a
	 * role's view or world function) lost its privileges with its drop, so it is granted again
	 * every privilege the target states on it, but those Structure granted again right after it (regrantWorld); and an
	 * object it drops takes its privileges with it, so it revokes none on it, but from a grantee it drops too, which
	 * PostgreSQL drops only once it holds nothing (publish.removed drops roles before tables and functions). A column grant
	 * is one unit of its grantee, privilege and table, its columns its value: one that changes is revoked by the table's
	 * revoke of its privilege, which PostgreSQL applies to every column whatever a rename called it since, and granted
	 * again, beside the table-level grant of that privilege where the target states one. Every revoke comes before every
	 * grant, and the grants run in the target's statements' order, a column grant beside its table's grants, so each
	 * object's grants run in the order a fresh installation runs them.
	 */
	grants(): void {
		const stated = (
			objects: ReadonlyArray<AnyObject>
		): ReadonlyArray<SqlStatement | RecordedStatement> =>
			objects.flatMap((o): ReadonlyArray<SqlStatement | RecordedStatement> =>
				installed(o).kind === "privileges" ? o.ddl : []
			)
		const before = stated(this.input.previous.manifest.objects)
		const after = stated(this.input.target.manifest.objects)
		const grantsOf = (ddl: ReadonlyArray<SqlStatement | RecordedStatement>): ReadonlyArray<Grant> =>
			ddl.flatMap((g) => (g.kind === "grant" ? [g] : []))
		const columnsOf = (
			ddl: ReadonlyArray<SqlStatement | RecordedStatement>
		): ReadonlyMap<string, GrantColumns> =>
			new Map(
				ddl.flatMap((g) =>
					g.kind === "grantColumns"
						? [[`${g.to}\u0000${g.privilege}\u0000${nameKey(g.table)}`, g] as const]
						: []
				)
			)
		const heldIn = (grants: ReadonlyArray<Grant>): ReadonlySet<string> =>
			new Set(grants.flatMap((g) => heldOf(g).map((h) => h.key)))
		const wasHeld = heldIn(grantsOf(before))
		const isHeld = heldIn(grantsOf(after))
		const reset = this.resetObjects()
		const dropped = this.droppedObjects()
		const roles = new Set(
			this.input.target.manifest.objects.flatMap((o) => {
				const v = installed(o)
				return v.kind === "role" || v.kind === "decoder" ? [v.create.name] : []
			})
		)
		const kept = (g: Grantee): boolean => g.kind === "PUBLIC" || roles.has(g.name)
		const columnsBefore = columnsOf(before)
		const columnsAfter = columnsOf(after)
		const regranted = (c: GrantColumns): boolean =>
			reset.has(objectKey({ kind: "TABLE", name: c.table }))
		const changedColumns = new Set(
			[...new Set([...columnsBefore.keys(), ...columnsAfter.keys()])].filter((key) => {
				const was = columnsBefore.get(key)
				const now = columnsAfter.get(key)
				return was === undefined || now === undefined || !canonicalEquals(was.columns, now.columns)
			})
		)
		/** The table-level privilege a changed column grant's revoke takes away beside it, which the target holds. */
		const columnRevoked = new Set(
			[...changedColumns].flatMap((key) => {
				const was = columnsBefore.get(key)
				return was === undefined
					? []
					: heldOf({
							kind: "grant",
							privileges: [was.privilege],
							on: { kind: "TABLE", names: [was.table] },
							to: [{ kind: "role", name: was.to }]
						}).map((h) => h.key)
			})
		)
		const revoked = (h: HeldPrivilege): boolean =>
			!isHeld.has(h.key) &&
			!reset.has(objectKey(h.object)) &&
			!(dropped.has(objectKey(h.object)) && kept(h.grantee))
		const granted = (h: HeldPrivilege): boolean =>
			!this.regranted.has(h.key) &&
			(!wasHeld.has(h.key) || reset.has(objectKey(h.object)) || columnRevoked.has(h.key))
		for (const g of cutGrants(grantsOf(before), revoked)) {
			this.sql("publish.grants", [revokeOf(g)])
		}
		for (const key of changedColumns) {
			const was = columnsBefore.get(key)
			const table = was === undefined ? undefined : ({ kind: "TABLE", name: was.table } as const)
			if (
				was !== undefined &&
				table !== undefined &&
				!reset.has(objectKey(table)) &&
				!(dropped.has(objectKey(table)) && roles.has(was.to))
			) {
				this.sql("publish.grants", [
					{
						kind: "revoke",
						privileges: [was.privilege],
						on: { kind: "TABLE", names: [was.table] },
						from: [{ kind: "role", name: was.to }]
					}
				])
			}
		}
		for (const g of after) {
			if (g.kind === "grant") {
				this.sql("publish.grants", cutGrants([g], granted))
			} else if (g.kind === "grantColumns") {
				const key = `${g.to}\u0000${g.privilege}\u0000${nameKey(g.table)}`
				if (changedColumns.has(key) || regranted(g)) {
					this.sql("publish.grants", [g])
				}
			}
		}
	}

	/** The keys of the objects whose privileges Structure takes away before Publish grants (privileges.ts objectKey): each
	 * materialized view it drops, recreated or not, each role's view and world function it drops at its start, and each
	 * declared function it drops and creates again for a changed signature or result (recreatedFunctions). Publish
	 * revokes nothing on one, and grants again every privilege the target states on one it holds. */
	resetObjects(): ReadonlySet<string> {
		const reset = (x: GrantObject): boolean => {
			switch (x.kind) {
				case "TABLE": {
					const key = nameKey(x.name)
					return this.recreatedViews.has(key) || this.dropped.has(key) || this.worldGone.has(key)
				}
				case "FUNCTION": {
					const key = nameKey(x.name)
					return this.worldGone.has(key) || this.recreatedFunctions.has(key)
				}
				case "DOMAIN":
				case "TYPE":
				case "SCHEMA":
				case "DATABASE":
					return false
			}
		}
		return new Set(
			[...this.input.previous.manifest.objects, ...this.input.target.manifest.objects].flatMap(
				(o) => grantObjectsOf(installed(o)).flatMap((x) => (reset(x) ? [objectKey(x)] : []))
			)
		)
	}

	/** The keys of the objects of the previous installation this migration drops in Publish, which take their privileges
	 * with them: each object the target no longer holds. */
	droppedObjects(): ReadonlySet<string> {
		const held = new Set(
			this.input.target.manifest.objects.flatMap((o) => grantObjectsOf(installed(o)).map(objectKey))
		)
		return new Set(
			this.input.previous.manifest.objects.flatMap((o) =>
				grantObjectsOf(installed(o)).flatMap((x) => {
					const key = objectKey(x)
					return held.has(key) ? [] : [key]
				})
			)
		)
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
	 * before the first such setting the migration stores or resets. */
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
			const set = kept.getOrInsertComputed(s.name, () => new Set<string>())
			if (s.action.kind === "set") {
				set.add(s.action.setting.parameter)
			}
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
		const previousRevokes = this.input.previous.manifest.publicRevokes
		/** The PUBLIC revokes the previous installation ran, each privilege by its key, and its default privileges. */
		const wasRevoked = new Set(
			previousRevokes.flatMap((r) =>
				r.kind === "revoke" ? heldOf(grantOf(r)).map((h) => h.key) : []
			)
		)
		const wasDefault = new Set(
			previousRevokes.flatMap((r) =>
				r.kind === "alterDefaultPrivileges" ? [canonicalTextOf(r)] : []
			)
		)
		/** A privilege PUBLIC loses again: one no previous revoke took. */
		const again = (h: HeldPrivilege): boolean => !wasRevoked.has(h.key)
		for (const r of this.input.target.manifest.publicRevokes) {
			if (r.kind === "revoke") {
				this.sql("publish.defaults", cutGrants([grantOf(r)], again).map(revokeOf))
			} else if (r.kind !== "alterDefaultPrivileges" || !wasDefault.has(canonicalTextOf(r))) {
				this.sql("publish.defaults", [r])
			}
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
		case "zones":
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

/** A table's key (NameKey) with a set of its columns: each column after a NUL, in one order. */
const sortedColumns = (table: ObjectName, columns: ReadonlyArray<string>): string =>
	[nameKey(table), ...[...columns].toSorted(compareStrings)].join("\u0000")

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
	mintKeyBefore(sortedColumns(table, columns))

const keyAfter = (table: ObjectName, columns: ReadonlyArray<string>): KeyAfter =>
	mintKeyAfter(sortedColumns(table, columns))

const referencedColumns = (fk: ForeignKey): ReadonlyArray<string> =>
	fk.referencedColumns.map((k) => k.column)

/** The key a foreign key of the previous snapshot references, and the key one of the target references. */
const referencedBefore = (fk: ForeignKey): KeyBefore =>
	keyBefore(fk.references, referencedColumns(fk))
const referencedAfter = (fk: ForeignKey): KeyAfter => keyAfter(fk.references, referencedColumns(fk))

/** A key of a table both snapshots install whose index the migration drops in Publish beside a key the target declares
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
 * recorded name and codes, and, for a roster continued under another name, by that name too, the name a declared
 * rename gives a constant it keeps (deploy/diff/declared.ts pairedConstants). So a constant names its roster whatever
 * renames and asides the draft gives the roster's domains. A constant's name is its roster's name and its content, so
 * a roster continued under the name of a roster that ends or moves away, of the same live codes or names (a take, a
 * swap), restates a constant that roster holds as its own; the name stays that roster's, whose domains read it, since
 * a declared rename keeps a constant only under a name the previous installation does not hold (pairedConstants). */
const rosterConstantsOf = (
	schema: string,
	rosters: ReadonlyArray<PreviousRoster>
): ReadonlyMap<string, RosterFate> => {
	const named = (codec: RosterCodec, fate: RosterFate) => {
		const constants = rosterConstants(codec)
		return [constants.names, constants.live].map(
			(id) => [qualifiedIdent("function", schema, identifierOf(id)), fate] as const
		)
	}
	return new Map([
		...rosters.flatMap(({ codec, fate }) =>
			fate.kind === "continued" && fate.as !== codec.roster
				? named({ ...codec, roster: fate.as }, fate)
				: []
		),
		...rosters.flatMap(({ codec, fate }) => named(codec, fate))
	])
}

/**
 * Each domain a manifest installs, by name key, as a column's values are read through it (DomainReading): a roster's,
 * the domain that reads a roster constant of `constants`, its codes' domain and its sets' the live constant (a record
 * before the live constant held its codes' domain reading the names constant); a law's, every other.
 */
const domainsOf = (
	manifest: {
		readonly objects: ReadonlyArray<AnyObject>
		readonly edges: RecordedManifest["edges"]
	},
	constants: ReadonlyMap<string, RosterFate>
): ReadonlyMap<NameKey, DomainReading> => {
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
	domains: ReadonlyMap<NameKey, DomainReading>
): DomainReading | undefined =>
	type.kind === "named" ? domains.get(nameKey(objectName(type.schema, type.name))) : undefined

/** The type a column of `type` stores its values as, read through each domain of `domains` to the type it is over. */
const baseOf = (type: TypeRef, domains: ReadonlyMap<NameKey, DomainReading>): TypeRef => {
	const domain = domainOf(type, domains)
	return domain === undefined ? type : baseOf(domain.create.base, domains)
}

/**
 * The schema of the operators that compare two values of a column of `type`, read through each domain of `domains` to
 * its base type: a named type no domain names is an extension's, whose own schema holds its operators (sql/ast.ts
 * TypeSchema); a builtin type's operators are pg_catalog's, none (ir/compare.ts operatorSchemaOf).
 */
const columnOperators = (
	type: TypeRef,
	domains: ReadonlyMap<NameKey, DomainReading>
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
	domains: ReadonlyMap<NameKey, DomainReading>
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
	domains: ReadonlyMap<NameKey, DomainReading>
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
	domains: ReadonlyMap<NameKey, DomainReading>
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
	domains: ReadonlyMap<NameKey, DomainReading>
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
	/** Its drops: one statement for an object the catalog holds, none for a table's declared statistics, which hold no
	 * catalog object and are declared again whole where the target keeps them. */
	readonly drops: ReadonlyArray<Drop>
}

/** The strongest of `hows`: a conversion in place takes more than a law column dropped and added again. */
const strongestReplacement = (hows: ReadonlyArray<Replacement>): Replacement | undefined =>
	hows.includes("converted") ? "converted" : hows.includes("redefined") ? "redefined" : undefined

/** What a migration does to a field of a table both snapshots install, read off its type, its writing and its draw
 * before and after:
 * - converted in place, its type changed;
 * - re-expressed, a generated field whose generation expression changes and whose type does not, by SET EXPRESSION,
 *   which recomputes every row and rebuilds what is built over the column, checking each constraint over it on the
 *   rows as it leaves them (KeptTable reexpressed);
 * - redrawn, a field the target draws or accumulates whose values the migration draws again, its filler or what its
 *   fill reads changed (redrawn, keptTablesOf drawnAgain), and whose column is otherwise kept: the same column, its
 *   values drawn again in place by the backfill, which writes only the rows whose values change (backfill.ts passes),
 *   and what is built over it kept but what a revaluation takes (ColumnFate revalued);
 * - rewritten, dropped and added again: a field whose writing changes between its caller and a generation, a generated
 *   field whose type changes, which PostgreSQL converts by no expression of the reviewer's, or a generated field that
 *   reads a field its table converts in place, which PostgreSQL refuses to convert under it;
 * - otherwise kept. */
type FieldChange =
	| { readonly kind: "kept" }
	| { readonly kind: "converted" }
	| { readonly kind: "reexpressed"; readonly generation: StoredGeneration }
	| { readonly kind: "redrawn" }
	| { readonly kind: "rewritten" }

/**
 * The STORED generation a law column takes in place of its previous one, where the two differ in it alone: the same
 * column of the same type and collation, both STORED, one expression for another of the same meaning (its canonical
 * text moved, so PostgreSQL's operand order did), or a generated field it reads re-expressed. SET EXPRESSION rewrites
 * its table once with every other column the table's one ALTER TABLE re-expresses, and rebuilds the indexes and
 * constraints over it in that statement (PostgreSQL's tablecmds.c, AT_SetExpression), checking each constraint over the
 * rows as it leaves them, where a drop and an addition would drop and build again everything over it: what the
 * re-expression could break is taken before it (Differ.takenByReplacement). None for any other change.
 */
const reexpressedLawColumn = (
	before: RecordedObject,
	now: ColumnDef
): StoredGeneration | undefined => {
	const was = installed(before)
	if (was.kind !== "lawColumn") {
		return undefined
	}
	const old = was.definition.generated
	const next = now.generated
	return (old?.kind === "stored" || old?.kind === "partial") &&
		(next?.kind === "stored" || next?.kind === "partial") &&
		old.kind === next.kind &&
		canonicalEquals({ ...was.definition, generated: undefined }, { ...now, generated: undefined })
		? next
		: undefined
}

/** A generated field's generation expression: its column's stored generation, none for a field its caller writes. */
const generationOf = (c: ColumnDef): Expr | undefined =>
	c.generated?.kind === "stored" ? c.generated.expr : undefined

/** Whether a column's type changes between a previous column and a target one (Differ.retyped). */
type Retyped = (b: ColumnDef, c: ColumnDef) => boolean

/** The one reading of a field's change from its column before and after, alone (fieldChangesOf reads a table's), its type
 * changing as `retyped` reads it. */
const fieldChange = (b: ColumnDef, c: ColumnDef, retyped: Retyped): FieldChange => {
	const before = generationOf(b)
	const after = generationOf(c)
	if ((before === undefined) !== (after === undefined)) {
		return { kind: "rewritten" }
	}
	if (after !== undefined) {
		if (retyped(b, c)) {
			return { kind: "rewritten" }
		}
		return canonicalEquals(before, after)
			? { kind: "kept" }
			: { kind: "reexpressed", generation: { kind: "stored", expr: after } }
	}
	return retyped(b, c) ? { kind: "converted" } : { kind: "kept" }
}

/** The fields two declarations of one relation share, each before and after. */
type SharedField = { readonly was: ColumnDef; readonly column: ColumnDef }

/** The fields `create` shares with `old`, in `create`'s order. */
const sharedFields = (
	old: ReadonlyArray<ColumnDef>,
	create: ReadonlyArray<ColumnDef>
): ReadonlyArray<SharedField> =>
	create.flatMap((column) => {
		const was = old.find((x) => x.name === column.name)
		return was === undefined ? [] : [{ was, column }]
	})

/** Each shared field's own change, by name (fieldChange). */
const fieldChangesOf = (
	shared: ReadonlyArray<SharedField>,
	retyped: Retyped
): ReadonlyMap<string, FieldChange> =>
	new Map(
		shared.map(({ was, column }) => [column.name, fieldChange(was, column, retyped)] as const)
	)

/**
 * The shared fields' changes `own` (fieldChangesOf, redrawn) with each generated field rewritten where PostgreSQL could
 * not keep its column through the other fields' changes: where its target generation reads a field converted, in
 * place or set aside, which it then reads through the conversion (asideSubcommand); where its previous generation
 * reads a field converted or rewritten, which PostgreSQL converts or drops only once no generated column reads it
 * (0A000, 2BP01), before Structure's alteration could set another expression; and where it is re-expressed on a table
 * `convertsInPlace`, since PostgreSQL 19 fails one ALTER TABLE that both converts a NOT NULL column and sets an
 * expression (XX000, "cache lookup failed for constraint").
 */
const rewrittenOver = (
	shared: ReadonlyArray<SharedField>,
	own: ReadonlyMap<string, FieldChange>,
	convertsInPlace: boolean
): ReadonlyMap<string, FieldChange> => {
	const changed =
		(...kinds: ReadonlyArray<FieldChange["kind"]>) =>
		(column: string): boolean => {
			const change = own.get(column)
			return change !== undefined && kinds.includes(change.kind)
		}
	return new Map(
		shared.map(({ was, column }): readonly [string, FieldChange] => {
			const change = changeOf(own, column.name)
			const rewrite =
				change.kind !== "rewritten" &&
				(generationColumns(column.generated).some(changed("converted")) ||
					generationColumns(was.generated).some(changed("converted", "rewritten")) ||
					(change.kind === "reexpressed" && convertsInPlace))
			return [column.name, rewrite ? { kind: "rewritten" } : change]
		})
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

/** Whether a field is a key generation (ir/law.ts FieldWriting keyGenerated), by its record. */
const isKeyGeneration = (w: SnapshotWriting | undefined): boolean =>
	typeof w === "object" && "keyGenerated" in w

/**
 * A table that stands keeps each key generation it holds as it was, refused (UnsupportedOperation) otherwise: a key
 * generation added to it, one gone from it, or its generation changed. A key generation is a column of its primary key
 * that grizzle writes as its generation's value over each row, so any change of it is a change of the key every stored
 * row is known by, its values computed again, which this migration drafts for a table created afresh alone.
 */
const keyGenerationsKept = (
	table: string,
	columns: ReadonlyArray<ColumnDef>,
	before: ReadonlyMap<string, SnapshotWriting>,
	after: ReadonlyMap<string, SnapshotWriting>
): void => {
	const named = new Set([...before.keys(), ...after.keys(), ...columns.map((c) => c.name)])
	for (const column of [...named].toSorted(compareStrings)) {
		const was = before.get(column)
		const now = after.get(column)
		if ((isKeyGeneration(was) || isKeyGeneration(now)) && !canonicalEquals(was, now)) {
			refuseUnsupported({
				loc: SourceLoc(`object ${table}`, ["columns", column]),
				capability: `migrate: the key generation ${column} of a table that stands, declared, dropped or generated otherwise; a key generation is part of the primary key every stored row is known by, so it changes only with a table created afresh`
			})
		}
	}
}

/** Whether a field is grizzle's to write: drawn from the nested arrays, or accumulated on the host. */
const isDrawn = (w: SnapshotWriting | undefined): boolean =>
	typeof w === "object" && ("drawn" in w || "accumulated" in w)

/**
 * The field changes of a table with each field the target draws or accumulates otherwise than the previous snapshot
 * records it drawn anew (drawnAnew): a field its caller wrote, or one drawn or accumulated by another filler
 * (SnapshotWriting), its family, fold, copy or start changed, so its stale values give way to the drawn ones. A field
 * whose filler a declaration only renames, and an ordered family's or a tree's index whose family only changes its
 * group, reads as its previous record (deploy/diff/declared.ts) and is kept. A drawn or accumulated field the target
 * leaves to its caller keeps its column and its values, which are lawful, as the caller's data; its family's law columns
 * and natives go with the family.
 */
const redrawn = (
	changes: ReadonlyMap<string, FieldChange>,
	before: ReadonlyMap<string, SnapshotWriting>,
	after: ReadonlyMap<string, SnapshotWriting>
): ReadonlyMap<string, FieldChange> =>
	new Map(
		[...changes].map(([column, change]): readonly [string, FieldChange] =>
			isDrawn(after.get(column)) && !canonicalEquals(before.get(column), after.get(column))
				? [column, drawnAnew(change)]
				: [column, change]
		)
	)

/** A field the backfill draws again, from its own change: redrawn in place where its column is otherwise kept, since a
 * column of its type holds the drawn values as it holds the stale ones; dropped and added again (rewritten) where its
 * column is converted or rewritten besides. */
const drawnAnew = (change: FieldChange): FieldChange => {
	switch (change.kind) {
		case "kept":
		case "redrawn":
			return { kind: "redrawn" }
		case "converted":
		case "reexpressed":
		case "rewritten":
			return { kind: "rewritten" }
	}
}

/**
 * A kept table's column fates: those of the fields the target holds, read off their changes (rewrittenOver), and those
 * of the columns whose fate what they read decides, the generated fields, the fields the target no longer holds and the
 * law columns: each its own (kept, revalued, redefined or dropped), but one whose generation reads a column the
 * migration replaces (converted in place, or dropped and added again), through any chain of generated columns, is
 * redefined: PostgreSQL drops or converts a column only once every generated column that reads it is gone (2BP01,
 * 0A000), so the migration drops it before the column it reads, with everything built over it (dropReplaced,
 * keptTable), and adds it again where the target holds it. One the target holds whose generation reads a column the
 * backfill draws again in place is revalued, since PostgreSQL computes it again on each row the backfill writes; and one
 * the target no longer holds is redefined, dropped before the backfill with what is built over it, so nothing over it
 * reads the values the backfill would give it.
 */
const generatedOver = (
	fields: ReadonlyMap<string, ColumnFate>,
	generated: ReadonlyArray<{
		readonly column: string
		readonly reads: ReadonlyArray<string>
		readonly fate: ColumnFate
	}>
): ColumnFates => {
	const fates = new Map<string, ColumnFate>([
		...fields,
		...generated.map((c) => [c.column, c.fate] as const)
	])
	const kindOf = (column: string): ColumnFate["kind"] | undefined => fates.get(column)?.kind
	const replaced = (column: string): boolean => {
		const fate = kindOf(column)
		return fate === "converted" || fate === "redefined"
	}
	const revalued = (column: string): boolean => kindOf(column) === "revalued"
	/** The fate a generated column moves to from what it reads, none where it stays. */
	const moved = (c: (typeof generated)[number]): ColumnFate | undefined => {
		const now = kindOf(c.column)
		if (replaced(c.column)) {
			return undefined
		}
		if (c.reads.some(replaced)) {
			return redefinedColumn
		}
		if (now !== "revalued" && c.reads.some(revalued)) {
			return now === "dropped" ? redefinedColumn : revaluedColumn
		}
		return undefined
	}
	for (let grew = true; grew;) {
		const reached = generated.flatMap((c) => {
			const fate = moved(c)
			return fate === undefined ? [] : [{ column: c.column, fate }]
		})
		for (const c of reached) {
			fates.set(c.column, c.fate)
		}
		grew = reached.length > 0
	}
	return fates
}

/** Whether a column's fate gives it other values: converted, dropped and added again, or computed again from a column
 * the backfill draws again (a field drawn again itself among them, keptTablesOf). */
const revalues = (fate: ColumnFate): boolean => {
	switch (fate.kind) {
		case "converted":
		case "redefined":
		case "revalued":
			return true
		case "kept":
		case "dropped":
			return false
	}
}

/**
 * The stored columns whose values a migration writes again, of the tables both installations hold (`kept`): each column
 * whose fate gives it other values (revalues), and each field re-expressed in place, whose column is kept but whose
 * every row SET EXPRESSION computes again. The one reading of "this migration rewrites that column": a rule over a
 * query that reads one is checked again (heldBefore), and a materialized view above its table is created again
 * (Differ.viewDropsOf), since a proof of the old values, and rows computed from them, no longer stand.
 */
const rewrittenColumns = (kept: ReadonlyMap<string, KeptTable>): ReadonlySet<StoredColumnKey> =>
	new Set(
		[...kept.values()].flatMap((k) => {
			const table = nameKey(k.create.table)
			return [...k.fates].flatMap(([column, fate]) =>
				revalues(fate) || k.changes.get(column)?.kind === "reexpressed"
					? [storedColumnKey(table, column)]
					: []
			)
		})
	)

/** A field's change in a table's changes (fieldChangesOf): every field both declarations hold has one. */
const changeOf = (changes: ReadonlyMap<string, FieldChange>, column: string): FieldChange => {
	const change = changes.get(column)
	if (change === undefined) {
		throw defect(`the field ${column} both declarations hold has a change`)
	}
	return change
}

/** The steps that change a field of `t` from `b` to `c` in place, by its change (fieldChange), `convert` converting the
 * column to its new type; a generated field re-expressed takes its new expression; a field rewritten is dropped and
 * added again by `add`; a field kept as it is takes none. The one reading for a field of a table both install but a
 * rewritten one, which changeField drops before the conversions. A conversion the reviewer's value makes is set aside
 * instead (InPlace setAside). Each alteration joins its table's one ALTER TABLE in Structure (Differ.alter), which
 * PostgreSQL runs pass by pass. */
const inPlace = (
	t: ObjectName,
	b: ColumnDef,
	c: ColumnDef,
	change: FieldChange,
	convert: (column: ColumnDef) => ColumnConversion,
	add: (column: ColumnDef) => AlterTableAction
): InPlace => {
	const altering = (a: AlterTableAction): Action => ({ kind: "alteration", table: t, actions: [a] })
	const steps = (list: ReadonlyArray<Action>): InPlace => ({ kind: "steps", steps: list })
	switch (change.kind) {
		case "kept":
			return steps([])
		case "converted": {
			const conversion = convert({ ...c, generated: undefined })
			if (conversion.kind === "placeholderRetype") {
				return { kind: "setAside", reason: conversion.reason }
			}
			return steps([altering(conversion)])
		}
		case "reexpressed":
			return steps([
				altering({ kind: "setExpression", column: c.name, generation: change.generation })
			])
		case "redrawn":
			return steps([])
		case "rewritten":
			return steps([altering({ kind: "dropColumn", column: b.name }), altering(add(c))])
	}
}

/** What a field's change in place drafts (inPlace): its steps, or, for a conversion the reviewer's value makes, its
 * setting aside (SetAside). */
type InPlace =
	| { readonly kind: "steps"; readonly steps: ReadonlyArray<Action> }
	| { readonly kind: "setAside"; readonly reason: RetypeReason }

/** The drop of a domain or a relation, which must find it. */
const dropObject = (
	v: Installed<AnyObject> & { readonly kind: "domain" | "table" | "materializedView" }
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
const schemaOf = (o: AnyObject): string => {
	const ident = parseIdent(o.ident)
	if (ident.kind !== "schema") {
		throw defect(`the schema object ${o.ident} is named as a schema`)
	}
	return ident.name
}

/** A constant's signature: its name and its parameters' types, none for a packed constant, which takes none. */
const constantName = (c: ConstantHeader): FunctionName => ({
	...c.name,
	args: c.params.map((p) => p.type)
})

/** The key of a table or a materialized view: the name its definition creates. */
const relationKey = (
	v: Installed<AnyObject> & { readonly kind: "table" | "materializedView" }
): NameKey => nameKey(v.kind === "table" ? v.create.table : v.create.name)

/** Each materialized view's meaning a snapshot records, by the view's identifier (types.ts SnapshotRelation). */
const viewMeanings = (snapshot: DeploySnapshot | SnapshotContent): ReadonlyMap<string, string> =>
	new Map(
		Object.values(snapshot.theory.relations).flatMap((r) =>
			r.kind === "derived" ? [[r.ident, r.meaning] as const] : []
		)
	)

/** The keys of every name qualified by one of the installation's level schemas `schemas` that a walk of the AST meets
 * (sql/transform.ts AstHooks): the relations, sequences and indexes it names, the types it casts to and the functions
 * it calls. */
const qualifiedNames = (
	walk: (hooks: AstHooks) => void,
	schemas: ReadonlySet<string>
): ReadonlySet<NameKey> => {
	const out = new Set<NameKey>()
	const add = (name: ObjectName): void => {
		if (schemas.has(name.schema)) {
			out.add(nameKey(name))
		}
	}
	walk({
		...identityHooks,
		objectName: (name) => {
			add(name)
			return name
		},
		typeRef: (type) => {
			if (type.kind === "named") {
				add(type)
			}
			return type
		},
		functionRef: (fn) => {
			add(fn)
			return fn
		}
	})
	return out
}

/** What each installed materialized view reads, by table key: the previous snapshot's edges, and the relations every
 * installed definition names. A view's query names schema relations only as what it reads, and relations, types and
 * sequences share one namespace, so a qualified name in it is a relation it reads, a type it casts to, or neither; only
 * relation keys are ever looked up. */
const installedReads = (
	previous: DeploySnapshot,
	schemas: ReadonlySet<string>
): ReadonlyMap<NameKey, ReadonlySet<NameKey>> => {
	const out = new Map<NameKey, Set<NameKey>>()
	const add = (view: NameKey, relation: NameKey): void => {
		if (view === relation) {
			return
		}
		const set = out.getOrInsertComputed(view, () => new Set<NameKey>())
		set.add(relation)
	}
	for (const e of previous.manifest.edges) {
		const from = parseIdent(e.from)
		const to = parseIdent(e.to)
		if (
			to.kind === "materializedView" &&
			(from.kind === "table" || from.kind === "materializedView")
		) {
			add(nameKey(to), nameKey(from))
		}
	}
	for (const o of previous.manifest.objects) {
		const v = installed(o)
		if (v.kind !== "materializedView") {
			continue
		}
		const view = nameKey(v.create.name)
		out.getOrInsertComputed(view, () => new Set())
		for (const name of qualifiedNames((hooks) => {
			transformSelect(v.create.query, hooks)
		}, schemas)) {
			add(view, name)
		}
	}
	return out
}

/** The drops of an object built over a column (objects.ts builtOver), which a replacement of the column takes away, in
 * the drop order (dropOrder): the foreign keys and rule triggers first, then the keys and CHECKs, the indexes and the
 * law columns whose generation reads the column; none for a table's declared statistics, which PostgreSQL clears of a
 * converted or re-expressed column itself (tablecmds.c RemoveStatistics), and which are declared again whole. */
const replacementDrops = (v: BuiltOver<AnyObject>["part"]): ReadonlyArray<Drop> => {
	switch (v.kind) {
		case "foreignKey":
		case "check":
		case "primaryKey":
		case "unique":
			return [
				{
					rank: dropOrder[v.kind],
					draft: statement(alter(v.table, [{ kind: "dropConstraint", name: v.name }]))
				}
			]
		case "index":
		case "uniqueIndex":
			return [
				{
					rank: dropOrder[v.kind],
					draft: statement({
						kind: "dropIndex",
						name: objectName(v.create.table.schema, v.create.name),
						concurrently: false,
						ifExists: false
					})
				}
			]
		case "statistics":
			return []
		case "lawTrigger":
			return [
				{
					rank: dropOrder.lawTrigger,
					draft: statement({
						kind: "dropTrigger",
						name: v.create.name,
						table: v.create.table,
						ifExists: false
					})
				}
			]
		case "lawColumn":
			return [
				{
					rank: dropOrder.lawColumn,
					draft: statement(alter(v.table, [{ kind: "dropColumn", column: v.column }]))
				}
			]
	}
}

const revokeOf = (g: Grant): Revoke => ({
	kind: "revoke",
	privileges: g.privileges,
	on: g.on,
	from: g.to
})

/** The grant a revoke takes back: its privileges, on its objects, to its grantees. */
const grantOf = (r: Revoke): Grant => ({
	kind: "grant",
	privileges: r.privileges,
	on: r.on,
	to: r.from
})

/**
 * The objects a GRANT may name that an installed object is (privileges.ts GrantObject): a table, the ledger, a role's
 * view and a materialized view as a TABLE; a domain; a declared function's row type as a TYPE; every function,
 * constant and declared function by its name and argument types; a level's schema and a role's; none for any other.
 */
const grantObjectsOf = (v: Installed<AnyObject>): ReadonlyArray<GrantObject> => {
	switch (v.kind) {
		case "table":
		case "ledger":
			return [{ kind: "TABLE", name: v.create.table }]
		case "head":
			return [
				{ kind: "TABLE", name: v.create.table },
				{ kind: "FUNCTION", name: functionNameOf(v.stamp) }
			]
		case "view":
		case "materializedView":
			return [{ kind: "TABLE", name: v.create.name }]
		case "domain":
			return [{ kind: "DOMAIN", name: v.create.name }]
		case "rowType":
			return [{ kind: "TYPE", name: v.create.name }]
		case "declaredFunction":
			return [{ kind: "FUNCTION", name: functionNameOf(v.create) }]
		case "constant":
		case "refusalFunction":
		case "borrowFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "ruleJudge":
		case "lawFunction":
		case "immutableGuard":
		case "worldFunction":
			return [{ kind: "FUNCTION", name: functionNameOf(v.create) }]
		case "roleSchema":
			return [{ kind: "SCHEMA", name: v.create.name }]
		case "schema": {
			const ident = parseIdent(v.object.ident)
			return ident.kind === "schema" ? [{ kind: "SCHEMA", name: ident.name }] : []
		}
		case "index":
		case "uniqueIndex":
		case "statistics":
		case "isolationTrigger":
		case "immutableTrigger":
		case "lawTrigger":
		case "role":
		case "functionOwner":
		case "membership":
		case "privileges":
		case "policy":
		case "rowSecurity":
		case "replicaIdentity":
		case "liveSecret":
		case "publication":
		case "decoder":
		case "lawColumn":
		case "primaryKey":
		case "unique":
		case "check":
		case "foreignKey":
		case "extension":
		case "validation":
			return []
	}
}

/** The revoke of a role's membership in its login. */
const revokeRoleOf = (g: GrantRole): SqlStatement => ({
	kind: "revokeRole",
	role: g.role,
	from: g.to
})

/** The roles' objects that hold no data and are created again whenever they change: views, world functions, policies. */
const worldKinds: ReadonlySet<PhysicalKind> = new Set(["view", "worldFunction", "policy"])

/**
 * Whether a role's object reads a previous object as it reads the target's: one whose statements print alike, what
 * PostgreSQL holds of it (recorded.ts samePrinted), so a world object whose compile states a proof of its rows where it
 * stated none is the same object; or a table whose columns keep their names, types and collations, whose generations
 * and constraints alone change. PostgreSQL keeps every view, function and policy over a column a SET EXPRESSION
 * re-expresses and a table whose CHECK is replaced, and a column a migration converts or rebuilds takes the table
 * beneath (worldChangesOf's `beneath`).
 */
const sameRead = (was: RecordedObject, now: ManifestObject): boolean => {
	if (samePrinted(was, now)) {
		return true
	}
	const [before] = was.ddl
	const [after] = now.ddl
	const columns = (s: RecordedStatement | SqlStatement | undefined) =>
		s?.kind === "createTable"
			? s.columns.map((c) => ({ name: c.name, type: c.type, collation: c.collation }))
			: undefined
	const read = columns(before)
	return (
		read !== undefined &&
		was.ddl.length === 1 &&
		now.ddl.length === 1 &&
		before?.kind === "createTable" &&
		after?.kind === "createTable" &&
		canonicalEquals(before.table, after.table) &&
		canonicalEquals(read, columns(after))
	)
}

/** The roles' views, world functions and policies a migration drops at the start of Structure and creates again (in
 * Structure or in Publish, Differ.visit): each the target holds whose DDL changes, or that waits for an object the
 * migration changes (one whose DDL changes what they read, sameRead, one the previous manifest lacks, one the target lacks, or one `beneath`
 * names, which the migration takes away and builds again without changing its DDL: a
 * materialized view it drops, an object it drops before replacing a column it is built over, a table it converts a
 * column of), read off the target's edges in install order, a world object waiting for every relation, type and
 * function its statements read (`readsOf`); and each the target no longer holds. PostgreSQL refuses to convert, drop or
 * rename what a view, a policy or a function body reads beneath it, so dropping them first leaves every structural
 * change free, and they hold nothing a drop could lose.
 *
 * A world object is identified by its own statement, as PostgreSQL holds it, and what it waits for, nothing else. What
 * its compile relies on of what it reads, a key it proves uniqueness by or a containment it proves existence by, is in
 * its statement where it changes what the statement says, a DISTINCT dropped or a join left out, and a proof that prints
 * nothing changes nothing PostgreSQL holds (sameRead); and PostgreSQL records no dependency of a view, policy or function on a foreign key
 * or a unique index, so a foreign key added, changed or dropped, or a materialized view's key, takes nothing away
 * beneath it. A materialized view whose keys change means something else and is created again (viewDropsOf), which
 * `beneath` names. */
const worldChangesOf = (
	previous: RecordedManifest,
	target: InstallationManifest<SqlStatement>,
	beneath: ReadonlySet<string>
): { readonly drops: ReadonlySet<string>; readonly creates: ReadonlySet<string> } => {
	const before = new Map(previous.objects.map((o) => [o.ident, o]))
	const after = new Set(target.objects.map((o) => o.ident))
	const changed = new Set<string>(beneath)
	for (const o of target.objects) {
		const was = before.get(o.ident)
		if (was === undefined || !sameRead(was, o)) {
			changed.add(o.ident)
		}
	}
	for (const o of previous.objects) {
		if (!after.has(o.ident)) {
			changed.add(o.ident)
		}
	}
	const waitsFor = new Map<string, Array<string>>()
	for (const e of target.edges) {
		waitsFor.getOrInsertComputed(e.to, () => []).push(e.from)
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
 * - Adding a field: ADD COLUMN ... NOT NULL DEFAULT with a marked placeholder, then DROP DEFAULT (structure).
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
 *   is built over the column, a constraint, an index or its table's declared statistics, and the foreign keys referencing a key
 *   over it, is
 *   dropped first (structure.drop), since PostgreSQL would carry it across the conversion under its old definition or
 *   refuse the conversion under it, and is built again as the target declares it, as on a relation that may hold rows,
 *   but for a key, which is added again in the same Structure transaction right after the conversion, so it holds at
 *   every commit;
 *   the materialized views over the table are dropped and recreated.
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
 * - Adding a key to a relation that may hold rows: its unique index built concurrently (indexes), which enforces it
 *   from then, then the constraint attached USING INDEX (publish), whose ACCESS EXCLUSIVE no long read runs under; a
 *   key with a span field is added directly in Publish, since PostgreSQL attaches only B-tree indexes. Changing a key
 *   builds the new index under a temporary name and swaps it in one statement.
 * - A key of a table both snapshots install that the migration removes or replaces under its name, over columns that
 *   are those of a key the target declares there: PostgreSQL binds a foreign key to the first unique index over its
 *   referenced columns and refuses that index's drop under it, so the key goes in Publish, once the target's keys are
 *   attached and before the foreign keys over those columns are added; the foreign keys that may be bound to it go
 *   before it and are added again after (replacedKey), NOT VALID, and validated in a transaction of their own
 *   (revalidate).
 * - Adding a row check or a containment to a relation that may hold rows: NOT VALID (structure), VALIDATE (validate);
 *   a containment that needs a key this migration attaches is added NOT VALID after it, in Publish, and validated in
 *   revalidate, enforced on every write from its addition.
 * - An installation's validation statements, the refined constants' casts to their domains: run in Publish when they
 *   are new or changed, as a pattern change changes the domain they cast to, or when a domain they cast to takes a new
 *   constraint, as a contract's predicate change does, so either validates the closed facts as well as the existing
 *   rows; removing them drops nothing.
 * - Adding a derived relation: its view WITH NO DATA and its unique indexes (structure), populated by a REFRESH once
 *   every row it reads is written (structure.refresh). Changing what a definition means drops and recreates the view
 *   and every view above it that reads it, directly or through another, WITH NO DATA, with their indexes and
 *   declared statistics, refreshes each bottom-up, and grants their privileges again. A view the target no longer has that reads a
 *   recreated one cannot outlive it, so it is dropped first, here.
 * - Workload changes add indexes and declare each table's statistics anew (indexes); an index no law or program
 *   justifies any longer is dropped.
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

import { sameOrder, appendAll } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
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
import { compileBudgets } from "#compiler/core/policy.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import type * as Result from "#compiler/core/result.ts"
import { type Aside, asideStatements } from "#compiler/deploy/diff/aside.ts"
import {
	type AbandonedSchema,
	type Action,
	type Candidate,
	type Choice,
	type ColumnConversion,
	type ColumnHint,
	candidateLabel,
	type Draft,
	draftCandidates,
	endsOf,
	type FieldCandidate,
	type FieldRequires,
	headOf,
	type LoginCandidate,
	type LossDecision,
	type MigrationPlan,
	type NestedFieldCandidate,
	type NestedRename,
	type Offer,
	type PlainOffer,
	type PlainSlot,
	type RelationCandidate,
	type RelationRename,
	type RelationStep,
	type RootRename,
	rivals,
	type SealedStep,
	type Step,
	slots,
	type TopOffer,
	type TypeCandidate
} from "#compiler/deploy/diff/plan.ts"
import { ledgerPrivilegesIdent } from "#compiler/deploy/ledger/ledger.ts"
import {
	addedPart,
	builtOver,
	constraintColumns,
	type Installed,
	indexColumns,
	inRelations,
	installed,
	inTypes,
	keyOrCheckDefinition,
	type LawUnit,
	lawUnitsOf,
	type ManifestObject,
	nameKey,
	objectParts,
	objectTable,
	type Part,
	type PartKind,
	type PartOf,
	type Parts,
	partKinds,
	type QualifiedNames,
	relationParts,
	refuse,
	refuseLaw,
	renameStatement,
	same,
	sameHeading,
	triggerColumns
} from "#compiler/deploy/snapshot/objects.ts"
import type { SnapshotContent } from "#compiler/deploy/snapshot/types.ts"

import type {
	DeploySnapshot,
	SnapshotResidual,
	SnapshotTheory
} from "#compiler/deploy/snapshot/types.ts"
import type { ResidualLaw } from "#compiler/ir/law.ts"
import type { InstallationManifest, PhysicalKind, PhysicalReason } from "#compiler/ir/products.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { targetKey, touchedTargets } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { namedIdent, parseIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	AlterRole,
	AlterTable,
	AlterTableAction,
	Collation,
	ColumnDef,
	CreateConstraintTrigger,
	CreateDomain,
	CreateEnum,
	CreateIndex,
	CreateTable,
	ForeignKey,
	Grant,
	Grantee,
	GrantRole,
	ObjectName,
	Revoke,
	SqlStatement,
	TableConstraint,
	TypeRef
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
	namedType,
	objectName,
	simpleSelect,
	table as tableFrom,
	tableCol,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { printObjectName, printType, quoteIdent, quoteString } from "#compiler/sql/print.ts"

interface DiffInput {
	readonly previous: DeploySnapshot
	readonly target: SnapshotContent
	/** The compiled target, for the violation queries of the residual laws a migration validates. */
	readonly installation: Installation
	/** The holders `previous` already has set aside, whose renames the plan drafts first. */
	readonly asides: ReadonlyArray<Aside>
	/** The schemas the migrations directory holds that the configuration no longer lists, when `previous` is the empty
	 * snapshot: the schema's creation then leaves their rows behind (`Loss`). */
	readonly abandoned: ReadonlyArray<AbandonedSchema>
}

/** A candidate rename as the differ plans it: the reviewer keeps the drafted drop and add, or replaces the addition
 * with the commented alternative. Choosing the alternative changes what other drafted statements must do, so every
 * statement it touches is offered what it becomes (markRenameCandidates): a statement that creates on the added
 * relation what the alternative brought across, or tears down on the removed relation what the alternative already
 * renamed or dropped, is deleted; any other statement naming what the alternative renamed runs under the new names. A
 * later candidate's alternative that drops a part this one drops or renames is offered the same (droppedOnce). Its
 * `candidate` is the plan's immutable record, which every offer and loss of it names. */
type Planned = {
	/** The schema-qualified names the alternative renames: a relation and its identity sequences, or a field's sequence,
	 * in the relations' namespace; or a type, in the types'. */
	readonly qualified: QualifiedNames
	/** The parts of previous tables its alternative drops before what it changes (PreviousPart): a relation's foreign
	 * keys of other relations that reference a key it drops, and its own constraints and law triggers it does not bring
	 * across (Pairs); a field's what PostgreSQL refuses to convert its column under (conversionDrops); none for a type's
	 * or a login's. A later drop of one, drafted or in a later alternative, goes. */
	readonly drops: ReadonlyArray<PreviousPart>
} & (
	| {
			readonly kind: "relation"
			readonly candidate: RelationCandidate
			/** What the alternative does with each part of the removed relation that stands when it runs (Pairs). */
			readonly pairs: Pairs
	  }
	| {
			readonly kind: "field"
			readonly candidate: FieldCandidate | NestedFieldCandidate
			/** The relation the alternative renames the column on: a kept one, or the added relation of the rename the
			 * candidate is nested in, which that rename has renamed already. */
			readonly table: ObjectName
			readonly keys: ReadonlyArray<CarriedKey>
	  }
	| { readonly kind: "type"; readonly candidate: TypeCandidate }
	| { readonly kind: "login"; readonly candidate: LoginCandidate }
)

type PlannedType = Planned & { readonly kind: "type" }
type PlannedField = Planned & { readonly kind: "field" }

const labelOf = (x: Planned): string => candidateLabel(x.candidate)

/** A field's candidate rename as its builder offers it on the addition: the added column it names, the offer, the
 * removed column it renames and the candidate. */
interface FieldOffer<O extends RootRename | NestedRename> {
	readonly added: ColumnDef
	readonly offer: O
	readonly removed: ColumnDef
	readonly candidate: PlannedField
}

/** A part of a previous table: a constraint, in the table's namespace of constraints, a law trigger, in its namespace
 * of triggers, or a stored tag's column, in its columns, by the table it is on and its name in the previous snapshot. It
 * is the one object it was, whatever names a candidate's alternative has given the table or the part since (partFate). */
interface PreviousPart {
	readonly kind: "constraint" | "lawTrigger" | "column"
	readonly table: ObjectName
	readonly name: string
}

/** The drop of a part of `kind` named `name` on `table`, each as named where the drop runs. */
const partDrop = (kind: PreviousPart["kind"], table: ObjectName, name: string): SqlStatement => {
	switch (kind) {
		case "constraint":
			return alter(table, [{ kind: "dropConstraint", name }])
		case "lawTrigger":
			return { kind: "dropTrigger", name, table, ifExists: false }
		case "column":
			return alter(table, [{ kind: "dropColumn", column: name }])
	}
}

/** Whether the alternative of `x` drops the part of `kind` named `name` on `table` first (Candidate drops), by their
 * previous names. */
const dropsPart = (
	x: Planned,
	kind: PreviousPart["kind"],
	table: ObjectName,
	name: string
): boolean =>
	x.drops.some((d) => d.kind === kind && nameKey(d.table) === nameKey(table) && d.name === name)

/** How a marker names a previous part. */
const partText = (kind: PreviousPart["kind"], table: ObjectName, name: string): string =>
	`the ${kind === "constraint" ? "constraint" : kind === "lawTrigger" ? "law trigger" : "column"} ${quoteIdent(name)} of ${printObjectName(table)}`

/** What a candidate's alternative makes of a previous part a later alternative drops (partFate): drops it; renames it,
 * to the part named `name` on `table`; or leaves it as it is. */
type PartFate =
	| { readonly kind: "dropped" }
	| { readonly kind: "renamed"; readonly table: ObjectName; readonly name: string }
	| { readonly kind: "left" }

const leftPart: PartFate = { kind: "left" }

/** What the alternative of `x` makes of the previous part `p`: drops it, one of the parts it drops first (Candidate
 * drops); renames it, a part of the relation a relation's rename renames, which goes along with its table under its own
 * name or the target's it is brought across as (Pairs), or a key a field's rename renames (CarriedKey); or leaves it. */
const partFate = (x: Planned, p: PreviousPart): PartFate => {
	if (dropsPart(x, p.kind, p.table, p.name)) {
		return { kind: "dropped" }
	}
	switch (x.kind) {
		case "relation": {
			if (nameKey(p.table) !== nameKey(x.candidate.removed)) {
				return leftPart
			}
			const paired =
				p.kind === "constraint" ? x.pairs.constraint.find((c) => c.was.name === p.name) : undefined
			return {
				kind: "renamed",
				table: x.candidate.added,
				name: paired?.kind === "brought" ? paired.pair.name : p.name
			}
		}
		case "field": {
			const key =
				p.kind === "constraint" && nameKey(p.table) === nameKey(x.table)
					? x.keys.find((k) => k.from === p.name)
					: undefined
			return key === undefined ? leftPart : { kind: "renamed", table: x.table, name: key.to }
		}
		case "type":
		case "login":
			return leftPart
	}
}

/** The offers of `x` on a later alternative's drop of the previous part `p`, by what its alternative makes of the part
 * (partFate): the drop's deletion where it dropped the part, the part's drop under its new names where it renamed it,
 * none where it left it. */
const dropOffers = (x: Planned, p: PreviousPart): ReadonlyArray<PlainOffer> => {
	const dropped = partText(p.kind, p.table, p.name)
	const fate = partFate(x, p)
	switch (fate.kind) {
		case "left":
			return []
		case "dropped":
			return [
				{
					kind: "delete",
					candidate: x.candidate,
					note: `the statement below drops ${dropped}, which ${labelOf(x)} drops first`
				}
			]
		case "renamed":
			return [
				{
					kind: "rewrite",
					candidate: x.candidate,
					note: `the statement below drops ${dropped}, which ${labelOf(x)} renames to ${partText(p.kind, fate.table, fate.name)} first`,
					statements: [partDrop(p.kind, fate.table, fate.name)]
				}
			]
	}
}

/** What a candidate's conversion drops first of a previous object built over the converted column (`column`), or over a
 * stored tag computed from it (`tag`), in the drop order; none for a kind it never drops. PostgreSQL refuses the
 * conversion under a foreign key, a CHECK, a law trigger's UPDATE OF and a stored tag computed from the column, and
 * converts a key with it; the tag's DROP COLUMN takes every key over the tag along, so each is dropped first by name, as
 * every foreign key referencing one is (2BP01). */
const clearedOf = (
	v: Installed,
	over: "column" | "tag"
): { readonly part: PreviousPart; readonly rank: number } | undefined => {
	switch (v.kind) {
		case "foreignKey":
		case "check":
			return {
				part: { kind: "constraint", table: v.table, name: v.name },
				rank: dropOrder[v.kind]
			}
		case "primaryKey":
		case "unique":
			return over === "tag"
				? { part: { kind: "constraint", table: v.table, name: v.name }, rank: dropOrder[v.kind] }
				: undefined
		case "lawTrigger":
			return {
				part: { kind: "lawTrigger", table: v.create.table, name: v.create.name },
				rank: dropOrder.lawTrigger
			}
		case "storedTag":
			return over === "column"
				? { part: { kind: "column", table: v.table, name: v.column }, rank: dropOrder.storedTag }
				: undefined
		case "databaseDefault":
		case "schema":
		case "extension":
		case "enum":
		case "domain":
		case "table":
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
		case "isolationTrigger":
		case "materializedView":
		case "index":
		case "uniqueIndex":
		case "statistics":
		case "validation":
		case "role":
		case "membership":
		case "privileges":
		case "roleSchema":
		case "view":
		case "worldFunction":
		case "policy":
		case "rowSecurity":
		case "ledger":
			return undefined
	}
}

/** Why a field's rename takes a drafted statement or an action of it: it builds or drops a key the rename renames
 * (`key`), or drops what the rename drops before it converts the column (`cleared`). */
type Taking = "key" | "cleared"

/** The candidates among `offers` that rename `removed`, which carry its values instead of its drop. */
const carriersOf = (
	offers: ReadonlyArray<FieldOffer<RootRename | NestedRename>>,
	removed: ColumnDef
): ReadonlyArray<Candidate> =>
	offers.flatMap((f): ReadonlyArray<Candidate> =>
		f.removed === removed ? [f.candidate.candidate] : []
	)

/** The drop of a removed field of `relation`, the relation that held it in the previous snapshot, by its table as
 * `table` names it where the drop runs: a loss of its values that the candidates in `carriers` carry instead. */
const fieldLoss = (
	relation: ObjectName,
	table: ObjectName,
	column: string,
	carriers: ReadonlyArray<Candidate>
): LossDecision => ({
	kind: "loss",
	loses: { kind: "field", relation, field: column },
	statement: alter(table, [{ kind: "dropColumn", column }]),
	carriers
})

/** What a drafted statement becomes when the reviewer chooses a candidate: the same; deleted, the rename having done what
 * it does; or rewritten into the statements it becomes. */
type Becomes =
	| { readonly kind: "same" }
	| { readonly kind: "deleted" }
	| { readonly kind: "rewritten"; readonly statements: NonEmptyReadonlyArray<SqlStatement> }

const unchanged: Becomes = { kind: "same" }
const deleted: Becomes = { kind: "deleted" }

/** An ALTER TABLE left with the `rest` of its actions, under `renamed`, or deleted when none is left. */
const withActions = (
	s: AlterTable,
	rest: ReadonlyArray<AlterTableAction>,
	renamed: (statement: SqlStatement) => SqlStatement
): Becomes =>
	isNonEmpty(rest) ? { kind: "rewritten", statements: [renamed({ ...s, actions: rest })] } : deleted

/** The offers of candidate `x` on a statement that becomes `b`, each with its note: none when it stays as it is. */
const offersOf = (
	x: Planned,
	b: Becomes,
	rewrite: string,
	deletion: string
): ReadonlyArray<PlainOffer> => {
	switch (b.kind) {
		case "same":
			return []
		case "deleted":
			return [{ kind: "delete", candidate: x.candidate, note: deletion }]
		case "rewritten":
			return [{ kind: "rewrite", candidate: x.candidate, note: rewrite, statements: b.statements }]
	}
}

/** How a marker names a holder's kind. */
const holdingText: { readonly [K in Aside["kind"]]: string } = {
	table: "relation",
	materializedView: "derived relation",
	enum: "closed relation's type",
	domain: "contract's domain"
}

/** Why a marker says a holder is set aside: the kind of object taking its name, or where its identity may move. */
const asideWhy = (a: Aside): string => {
	switch (a.cause.kind) {
		case "taken":
			return `the removed ${holdingText[a.kind]} ${printObjectName(a.name)} holds the name the ${holdingText[a.cause.taker.kind]} ${printObjectName(a.name)} takes`
		case "moved":
			return `the ${holdingText[a.kind]} ${printObjectName(a.name)} holds the heading the target gives ${a.cause.toward.map(printObjectName).join(" and ")}, and the target gives its name another heading: it may be renamed, its name taken by another relation`
	}
}

/** What a set-aside holder owns that goes aside with it: a relation's indexes, sequences and statistics; a type, none. */
const ownedAside = (a: Aside): string =>
	(a.kind === "table" || a.kind === "materializedView") && a.owned.length > 0
		? ", with each index, identity sequence and statistics object it owns, whose names a relation of its old name would take, renamed aside too"
		: ""

/** A key a field's rename carries across: the removed field's key, renamed to the target's over the added field. */
interface CarriedKey {
	readonly from: string
	readonly to: string
}

/** A part of the removed relation of a relation's rename, brought across as the part of the added relation it is under
 * the new names, or dropped. */
type Paired<P extends Part> =
	| { readonly kind: "brought"; readonly was: P; readonly pair: P }
	| { readonly kind: "dropped"; readonly was: P }

/** The one rule by which a relation's rename brings the removed relation's parts of a kind across: in the removed
 * relation's order, each part the rename can carry (`carried`) is the first part of the added relation not yet paired
 * whose definition it has under the new names (`is`); every other part pairs with none. A part is matched by its
 * definition, never by its spelling, so a name the compiler truncated and digested is paired too. */
const pairParts = <P extends Part>(
	removed: ReadonlyMap<string, P>,
	added: ReadonlyMap<string, P>,
	carried: (was: P) => boolean,
	is: (was: P, target: P) => boolean
): ReadonlyArray<Paired<P>> => {
	const unpaired = new Map(added)
	return [...removed.values()].map((was): Paired<P> => {
		const pair = carried(was) ? [...unpaired.values()].find((target) => is(was, target)) : undefined
		if (pair === undefined) {
			return { kind: "dropped", was }
		}
		unpaired.delete(pair.name)
		return { kind: "brought", was, pair }
	})
}

/** What a relation's rename does with each part of the removed relation that stands when it runs (pairParts): each
 * constraint, index, statistics object, stored tag and identity sequence brought across as a part of the added relation
 * or dropped; and the law triggers it drops, those over a column it drops, converts or retags, which PostgreSQL refuses
 * to drop or convert under them. Every other law trigger goes along with its table, and its law's drafted statements
 * replace it under the new names. */
interface Pairs {
	readonly constraint: ReadonlyArray<Paired<PartOf<"constraint">>>
	readonly index: ReadonlyArray<Paired<PartOf<"index">>>
	readonly statistics: ReadonlyArray<Paired<PartOf<"statistics">>>
	readonly column: ReadonlyArray<Paired<PartOf<"column">>>
	readonly sequence: ReadonlyArray<Paired<PartOf<"sequence">>>
	readonly lawTrigger: ReadonlyArray<PartOf<"lawTrigger">>
}

/** Whether a relation's rename drops the identity sequence `name` with the field it is of (Pairs). */
const dropsSequence = (pairs: Pairs, name: string): boolean =>
	pairs.sequence.some((p) => p.kind === "dropped" && p.was.name === name)

/** Whether a relation's rename brings a part of `kind` across under the name `name` (Pairs). */
const brings = (
	pairs: Pairs,
	kind: "constraint" | "index" | "statistics" | "column",
	name: string
): boolean => pairs[kind].some((p) => p.kind === "brought" && p.pair.name === name)

/** What a migration does to a column of a table it keeps, or of a relation a candidate renames (ColumnFates): kept as
 * it is; converted in place, a field whose type changes, by the field's visit (`field`), by the rebuild of the enum it
 * was of, while that type stands (`rebuild`), or by the candidate's alternative (`candidate`); retagged, a stored tag
 * whose value changes, dropped and added again; or dropped, a field or stored tag the target no longer holds. */
type ColumnFate =
	| { readonly kind: "kept" }
	| { readonly kind: "converted"; readonly by: "field" | "rebuild" | "candidate" }
	| { readonly kind: "retagged" }
	| { readonly kind: "dropped" }

const keptColumn: ColumnFate = { kind: "kept" }
const droppedColumn: ColumnFate = { kind: "dropped" }
const retaggedColumn: ColumnFate = { kind: "retagged" }

/** The fate of each column of a table, fields and stored tags, by name. */
type ColumnFates = ReadonlyMap<string, ColumnFate>

/** Whether a rename carries a part of each kind built over a column of each fate across as the part it is, the one rule
 * for every rename: PostgreSQL converts a column in place with each index and statistics object over it, but a rename
 * drops every constraint over a converted column first, since a foreign key compares only once both its sides are
 * converted, and the target adds it again; and a column dropped, or retagged, takes everything over it along. An
 * identity sequence goes with its column kept, and a column converted gives its identity up first, the sequence with it
 * (inPlace); a law trigger's UPDATE OF pins its columns, so
 * PostgreSQL refuses to convert or drop one under it. A stored tag is built over no column, so it is carried by its
 * definition alone. */
const carriedOver: {
	readonly [K in Exclude<PartKind, "column">]: { readonly [F in ColumnFate["kind"]]: boolean }
} = {
	constraint: { kept: true, converted: false, retagged: false, dropped: false },
	index: { kept: true, converted: true, retagged: false, dropped: false },
	statistics: { kept: true, converted: true, retagged: false, dropped: false },
	sequence: { kept: true, converted: false, retagged: false, dropped: false },
	lawTrigger: { kept: true, converted: false, retagged: false, dropped: false }
}

/** Whether a rename carries a part of `kind` built over `columns` across, each column's fate read by `fate`. */
const carries = (
	kind: Exclude<PartKind, "column">,
	columns: ReadonlyArray<string>,
	fate: (column: string) => ColumnFate
): boolean => columns.every((c) => carriedOver[kind][fate(c).kind])

/** The temporary name an index, or a key's index, is built under before it is swapped in for `name`: the naming
 * door's (identity.swap), never a name of a live object, so the build's DROP INDEX ... IF EXISTS can never drop one. */
export const swapName = (name: string): string => identifierOf(identity.swap(name))

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
			| "databaseDefault"
			| "schema"
			| "extension"
			| "validation"
			| "privileges"
			| "ledger"
			| "membership"
			| "isolationTrigger"
	  >
	| "column"

/** The one order in which a migration drops what it drops, by kind, each step that drops several sorting them by it
 * (dropWorlds, dropReplaced, an enum rebuild, publish.removed): the roles' policies before their views and the world
 * functions they call; the foreign keys before the keys they reference; the keys and CHECKs before the indexes, a row
 * security switched off beside them; then the roles and their schemas, the statistics objects, the law triggers before
 * the law functions they call, the materialized views before what they read, the law functions, the other functions,
 * the stored tags and columns, the tables over the types they use, and the types last. Within a kind, each step keeps
 * its own order: publish.removed the reverse install order, so a materialized view goes before the lower one it reads
 * and a table before one it references. */
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
	lawTrigger: 8,
	materializedView: 9,
	lawFunction: 10,
	refusalFunction: 11,
	advanceFunction: 11,
	isolationFunction: 11,
	snapshotGuard: 11,
	storedTag: 12,
	column: 13,
	table: 14,
	domain: 15,
	enum: 16
}

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

/** How the conversions of `count` columns convert them, as a note says it, `casts` of them by their casts. */
const conversionsBy = (count: number, casts: number): string =>
	casts === 0
		? `by the expression written at ${count === 1 ? "its placeholder" : "their placeholders"}`
		: casts === count
			? `by ${count === 1 ? "its cast, which keeps" : "their casts, which keep"} every value`
			: "each by its cast where its new type holds its old values, else by the expression written at its placeholder"

/** An action under the offers of the candidates that decide it, or the action itself when none does. */
const offered = <O extends Offer>(offers: ReadonlyArray<O>, keep: Action): Choice<O> | Action =>
	isNonEmpty(offers) ? { kind: "choice", offers, keep } : keep

/** What holds a field a candidate renames, and so what its candidate and its offer are: a table the target keeps,
 * whose rename carries the keys over the field across (carriedKeys) and whose conversion in place drops first what
 * PostgreSQL refuses to convert it under (conversionDrops), its candidate a root `field` offered at the top of the file;
 * or a relation's rename, whose alternative the candidate is nested in and has brought across or dropped every part
 * over it already, its candidate a `nested field` under that rename, offered in its alternative. `table` is the relation
 * the alternative renames the column on, `was` the one that held it in the previous snapshot. */
interface FieldHolder<
	C extends FieldCandidate | NestedFieldCandidate,
	O extends RootRename | NestedRename
> {
	readonly table: ObjectName
	readonly was: ObjectName
	readonly candidate: (removed: string, added: string, requires: FieldRequires) => C
	readonly offer: (candidate: C, note: string, alternative: ReadonlyArray<SealedStep>) => O
}

const keptHolder = (table: ObjectName): FieldHolder<FieldCandidate, RootRename> => ({
	table,
	was: table,
	candidate: (removed, added, requires) => ({
		kind: "field",
		relation: table,
		removed,
		added,
		requires
	}),
	offer: (candidate, note, alternative) => ({ kind: "rename", candidate, note, alternative })
})

const nestedHolder = (
	parent: RelationCandidate
): FieldHolder<NestedFieldCandidate, NestedRename> => ({
	table: parent.added,
	was: parent.removed,
	candidate: (removed, added, requires) => ({
		kind: "nested field",
		parent,
		removed,
		added,
		requires
	}),
	offer: (candidate, note, alternative) => ({ kind: "nested rename", candidate, note, alternative })
})

/** Where the removed field a field's candidate renames goes, as its notes say it. */
const removedBy = (c: FieldCandidate | NestedFieldCandidate): string => {
	switch (c.kind) {
		case "field":
			return "is dropped by this migration"
		case "nested field":
			return `the rename of ${printObjectName(c.parent.removed)} drops`
	}
}

/** A removed field an added one may be renamed from as it is: of the added one's type, or of a type a type's candidate
 * rename makes the added one's, which the field's rename then requires; with the keys over it the rename carries
 * across (carriedKeys). */
interface Pairing {
	readonly column: ColumnDef
	readonly via:
		| { readonly kind: "same type" }
		| { readonly kind: "renamed type"; readonly candidate: PlannedType }
	readonly keys: ReadonlyArray<CarriedKey>
}

/** A removed field an added one may be renamed from with its type changed, with the keys over it the rename carries
 * across (carriedKeys). */
interface Retyping {
	readonly column: ColumnDef
	readonly keys: ReadonlyArray<CarriedKey>
}

/** A field of the target's declaration of a relation, by the previous one's: added, with the removed fields it may be
 * renamed from, as they are (pairings), or, with none such, renamed with its type changed (`retypes`: each removed field
 * of another type, neither generated); or held under its name, as it was. */
type PairedField =
	| {
			readonly kind: "added"
			readonly column: ColumnDef
			readonly renames: ReadonlyArray<Pairing>
			readonly retypes: ReadonlyArray<Retyping>
	  }
	| { readonly kind: "held"; readonly column: ColumnDef; readonly was: ColumnDef }

/** Two declarations of a relation, field by field (Differ.fieldPairs): the fields only the previous one has, and the
 * target's fields in its order, paired. The one statement of the candidate renames a draft offers between them, which
 * also says what a removed key may stand over once they are chosen (Differ.keyImages). */
interface FieldPairs {
	readonly removed: ReadonlyArray<ColumnDef>
	readonly fields: ReadonlyArray<PairedField>
}

type AddedField = Extract<PairedField, { readonly kind: "added" }>
const addedFields = (pairs: FieldPairs): ReadonlyArray<AddedField> =>
	pairs.fields.flatMap((f) => (f.kind === "added" ? [f] : []))

/** How many added fields may be the removed field `r` renamed as it is, and renamed with its type changed. */
const renamingsOf = (pairs: FieldPairs, r: ColumnDef): number =>
	addedFields(pairs).filter((a) => a.renames.some((p) => p.column === r)).length

const retypingsOf = (pairs: FieldPairs, r: ColumnDef): number =>
	addedFields(pairs).filter((a) => a.retypes.some((x) => x.column === r)).length

/** The added fields a candidate may rename the removed field named `removed` to, as it is or with its type changed. */
const renamedTo = (pairs: FieldPairs, removed: string): ReadonlyArray<string> =>
	addedFields(pairs).flatMap((a) =>
		a.renames.some((p) => p.column.name === removed) ||
		a.retypes.some((r) => r.column.name === removed)
			? [a.column.name]
			: []
	)

/** The keys a candidate that renames the removed field `from` to the added field `to` carries across, as the pairs
 * record them (carriedKeys). */
const keysCarried = (pairs: FieldPairs, from: string, to: string): ReadonlyArray<CarriedKey> =>
	addedFields(pairs).flatMap((a) =>
		a.column.name === to
			? [...a.renames, ...a.retypes].flatMap((r) => (r.column.name === from ? r.keys : []))
			: []
	)

/** No key: a relation's rename drops each key it does not bring across, so a field's rename inside it carries none. */
const noKeys = (): ReadonlyArray<CarriedKey> => []

const noHint: ColumnHint = { kind: "none" }

/** The hint naming the dropped columns a new column may be computed from, the generated ones left out. */
const droppedHint = (removed: ReadonlyArray<ColumnDef>): ColumnHint => {
	const plain = removed.filter((r) => r.generated === undefined)
	return isNonEmpty(plain) ? { kind: "dropped", removed: plain } : noHint
}

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

/** A capacity's partial unique index, which enforces its law: removed from a table the target keeps, it goes with the
 * law's other native objects in publish.drop. */
const lawIndex = (o: ManifestObject): boolean =>
	o.kind === "uniqueIndex" && o.reasons.some((r: PhysicalReason) => r.kind === "law")

/** A primary key or candidate key a B-tree index implements, one with no span; none for any other constraint. */
const btreeKeyOf = (
	c: TableConstraint
): Extract<TableConstraint, { readonly kind: "primaryKey" | "unique" }> | undefined =>
	(c.kind === "primaryKey" || c.kind === "unique") && !c.columns.some((k) => k.withoutOverlaps)
		? c
		: undefined

/** A table both installations hold, read once before anything is drafted: the target's object, the previous table's
 * position in the install order (publish.removed drops objects of one kind in reverse order), the previous and the
 * target declaration, and the fate of each column of the previous table, its fields' and its stored tags'
 * (ColumnFates). */
interface KeptTable {
	readonly object: ManifestObject
	readonly order: number
	readonly old: CreateTable
	readonly create: CreateTable
	readonly fates: ColumnFates
}

/** The fate of the column `column` of a table both install, the one every part of the previous table is built over
 * has: a column its table lacks is a malformed snapshot. */
const columnFate = (kept: KeptTable, column: string): ColumnFate =>
	kept.fates.get(column) ?? refuse(kept.object.ident, `a table whose columns include ${column}`)

/** A kept table as its visit drafts it, planned before anything is drafted: its fields paired (FieldPairs), the
 * candidate renames of its added fields (FieldOffer), and its identity sequences paired by column, one the target names
 * otherwise renamed. */
interface KeptPlan {
	readonly table: KeptTable
	readonly pairs: FieldPairs
	readonly offers: ReadonlyArray<FieldOffer<RootRename>>
	readonly sequences: ReadonlyArray<Paired<PartOf<"sequence">>>
}

/** A candidate's conversion of a removed column that an enum rebuild converts (RebuiltColumn removed): offered at the
 * rebuild's own conversion of the column, under the old names, so the column is converted once whichever way the
 * reviewer decides (conversionIn). */
interface RebuildOffer {
	readonly table: ObjectName
	readonly column: string
	readonly offer: PlainOffer
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
 * indexes and statistics objects on it along (dropViews); an enum rebuild, which drops what its conversion would fail
 * under (planRebuild); or the replacement of a column it is built over (takenByReplacement). */
type Taken =
	| { readonly kind: "world" }
	| { readonly kind: "view" }
	| { readonly kind: "rebuild" }
	| { readonly kind: "replaced"; readonly how: Replacement }

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

/** Whether an object of a fate stands when the renames run, in Structure: every one Structure takes away first does
 * not; a kept or removed one does until Validate or Publish. */
const standsAtRenames = (fate: Fate): boolean => {
	switch (fate.kind) {
		case "world":
		case "view":
		case "rebuild":
		case "replaced":
			return false
		case "kept":
		case "removed":
		case "swapped":
		case "unbound":
			return true
	}
}

/** An object of the previous installation with its position in the install order and its fate. */
interface Previous {
	readonly object: ManifestObject
	readonly order: number
	readonly fate: Fate
}

/** What an object of the target is to this migration, read off the previous object it follows: new, created by its
 * visit, when the previous installation lacks it or a view's or the roles' drop took it away; following `before`, which
 * stands until its visit drafts the change: the previous object of its identity, or, for a primary key on a table both
 * install, the removed one it swaps in for (Fate `swapped`); created again by its visit once a replacement took the
 * previous one away (`replaced`); or created again by the enum rebuild that dropped it (`rebuild`). */
type Arrival =
	| { readonly kind: "new" }
	| { readonly kind: "follows"; readonly before: ManifestObject }
	| { readonly kind: "replaced"; readonly how: Replacement }
	| { readonly kind: "rebuild" }

const arrivedNew: Arrival = { kind: "new" }

/** What the target's object of an identity whose previous object `taken` took away is: new after a view's or the roles'
 * drop, which create it as they create a new one; created again by its rebuild or after its replacement. */
const arrivalAfter = (taken: Taken): Arrival => {
	switch (taken.kind) {
		case "world":
		case "view":
			return arrivedNew
		case "rebuild":
			return { kind: "rebuild" }
		case "replaced":
			return { kind: "replaced", how: taken.how }
	}
}

/** An object of the target with what it is to this migration. */
interface Target {
	readonly object: ManifestObject
	readonly arrival: Arrival
}

/** The run order of the steps: by slot, then (the sort being stable) as drafted. A residual law's steps are drafted
 * together, law by law, in the target's install order of the laws' unit triggers (`laws()`), which orders them by
 * the laws' identities. */
const stepOrder: Comparator<Step> = mapInput(compareNumbers, (s: Step) => slots.indexOf(s.slot))

const domainShape = (d: CreateDomain) => ({
	base: d.base,
	collation: d.collation,
	predicates: d.constraints.map((c) => c.predicate)
})

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

class Differ {
	readonly input: DiffInput
	readonly schema: string
	readonly steps: Array<Step> = []
	readonly prev: ReadonlyMap<string, ManifestObject>
	readonly next: ReadonlyMap<string, ManifestObject>
	/** The domains of the previous and the target installation (domainsOf), which a column of each is read through to
	 * what it holds (representationOf). */
	readonly prevDomains: ReadonlyMap<string, CreateDomain>
	readonly nextDomains: ReadonlyMap<string, CreateDomain>
	/** The enums whose rosters this migration rebuilds, by name key (planRebuild): a field of one whose type changes is
	 * converted by the rebuild, while the old type stands (fieldChange). */
	readonly rebuiltEnums: ReadonlySet<string>
	/** Each table both installations hold, by identity, with the fate of each of its columns (KeptTable). */
	readonly keptTables: ReadonlyMap<string, KeptTable>
	/** The materialized views this migration drops at the start of Structure (viewDropsOf). */
	readonly viewDrops: ReadonlyArray<ViewDrop>
	/** What publish.removed drops, gathered while drafting and drafted in order once every removal is known
	 * (draftRemovals). */
	readonly removals: Array<Removal> = []
	/** The enum rebuilds this migration plans (planRebuild), in the target's install order. */
	readonly rebuilds: ReadonlyArray<PlannedRebuild>
	/** The conversions candidates offer at an enum rebuild's conversion of a removed column, in the order they are
	 * planned (conversionIn). */
	readonly rebuildOffers: Array<RebuildOffer> = []
	/** Keys of relations that may hold rows that this migration attaches in Validate. */
	readonly attached = new Set<KeyAfter>()
	/** The keys of tables both snapshots install whose index this migration drops in Validate beside a key the target
	 * declares over the same columns, by identity (replacedKeysOf): each goes before the foreign keys over those columns
	 * are added (replacedKey, unbind). */
	readonly replaced: ReadonlyMap<string, ReplacedKey>
	/** The candidate renames offered on the creation of a target object, by identity, planned before anything is drafted:
	 * an enum or domain it adds (typeOffersOf), a login (loginOffers) or a relation (renameCandidateTable). One offered
	 * none has none. */
	readonly creationOffers: ReadonlyMap<string, ReadonlyArray<TopOffer>>
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
	/** The candidate renames this draft offers, with what each alternative renames, brings across and takes away, in the
	 * order they are planned. */
	readonly planned: Array<Planned> = []
	/** The names of the roles' views and world functions this migration drops at the start of Structure, by name key,
	 * whose privileges went with them. */
	readonly worldGone: ReadonlySet<string>
	/** Domains whose constraint this migration replaces, by name key: the validation statements that cast to one run
	 * again in Publish. */
	readonly reconstrained = new Set<string>()
	/** How each closed relation's enum both manifests install changes, by identity, a rebuild planned (planRebuild)
	 * before any object is visited. */
	readonly enums: ReadonlyMap<string, EnumChange>
	/** Every object of the previous installation, in its install order, with its fate. */
	readonly previous: ReadonlyArray<Previous>
	/** Every object of the target, in its install order, with what it is to this migration. */
	readonly targets: ReadonlyArray<Target>
	/** What each object of the target that follows a previous one or replaces a taken one is, by identity (arrivalOf). */
	readonly arrivals: ReadonlyMap<string, Arrival>
	/** The previous objects that stand when a rename this draft offers runs: every one but those Structure takes away
	 * before it (Taken), the enum rebuilds among them, which run before every rename (orderedSteps). A rename pairs,
	 * drops or drops first only what stands: deciding one already taken would act on a part no longer there; what the
	 * target declares in its place is created by its own statements. */
	readonly standing: ReadonlyArray<ManifestObject>
	/** What enum rebuilds drop and create again from the target's definitions, at the end of Structure, and the
	 * constraints among them that Validate then validates (rebuildEnum). */
	readonly rebuildTail: Array<SqlStatement> = []
	readonly rebuildValidations: Array<SqlStatement> = []

	constructor(input: DiffInput) {
		this.input = input
		this.schema = input.target.schema
		const previousObjects = input.previous.manifest.objects
		const targetObjects = input.target.manifest.objects
		this.prev = new Map(previousObjects.map((o) => [o.ident, o]))
		this.next = new Map(targetObjects.map((o) => [o.ident, o]))
		this.prevDomains = domainsOf(input.previous.manifest)
		this.nextDomains = domainsOf(input.target.manifest)
		this.reads = installedReads(input.previous, this.schema)
		this.rebuiltEnums = new Set(
			targetObjects.flatMap((o) => {
				const v = installed(o)
				const before = this.prev.get(o.ident)
				const was = before === undefined ? undefined : installed(before)
				return v.kind === "enum" &&
					was?.kind === "enum" &&
					rosterOf(was.create.labels, v.create.labels).kind === "rebuilt"
					? [nameKey(v.create.name)]
					: []
			})
		)
		this.keptTables = this.keptTablesOf()
		this.sequences = sequenceFatesOf(this.keptTables.values(), this.rebuiltEnums)
		const replacedBy = this.takenByReplacement()
		/** The dependents an earlier rebuild drops already, which a later one leaves to it. */
		const claimed = new Set<string>()
		this.enums = new Map(
			targetObjects.flatMap((o): ReadonlyArray<readonly [string, EnumChange]> => {
				const v = installed(o)
				const before = this.prev.get(o.ident)
				return v.kind === "enum" && before !== undefined
					? [
							[
								o.ident,
								enumChange(before, v.create, (old) =>
									this.planRebuild(v.create, old, replacedBy, claimed)
								)
							]
						]
					: []
			})
		)
		const rebuilds = [...this.enums.values()].flatMap(({ roster: r }) =>
			r.kind === "rebuilt" && r.rebuild.kind === "planned" ? [r.rebuild] : []
		)
		this.rebuilds = rebuilds
		this.viewDrops = this.viewDropsOf()
		this.recreatedViews = new Set(
			this.viewDrops.flatMap((d) => (d.fate === "recreated" ? [d.key] : []))
		)
		this.dropped = new Set(this.viewDrops.flatMap((d) => (d.fate === "dropped" ? [d.key] : [])))
		/** What this migration takes away and builds again beneath the roles' objects without changing its DDL: each
		 * materialized view it drops (recreated or not), each object an enum rebuild drops and recreates, each table an
		 * enum rebuild converts a column of, and each table a column of which it converts in place. */
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
			...[
				...rebuilds.flatMap((r) => r.conversions.map((c) => nameKey(c.table))),
				...convertedTables
			].flatMap((key) => {
				const ident = tableKeys.get(key)
				return ident === undefined ? [] : [ident]
			})
		])
		const worlds = worldChangesOf(input.previous.manifest, input.target.manifest, beneath)
		const viewKeys = new Set(this.viewDrops.map((d) => d.key))
		const rebuildDrops = new Set(
			rebuilds.flatMap((r) => [...r.tags, ...r.dependents].map((d) => d.object.ident))
		)
		/** What takes a previous object away in Structure, if anything does. */
		const takenOf = (o: ManifestObject): Taken | undefined => {
			if (worlds.drops.has(o.ident)) {
				return { kind: "world" }
			}
			const on = objectTable(o)
			if (on !== undefined && viewKeys.has(nameKey(on))) {
				return { kind: "view" }
			}
			if (rebuildDrops.has(o.ident)) {
				return { kind: "rebuild" }
			}
			const how = replacedBy.get(o.ident)
			return how === undefined ? undefined : { kind: "replaced", how }
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
		for (const r of rebuilds) {
			for (const index of r.overTags) {
				arrivals.set(index.object.ident, { kind: "rebuild" })
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
			if (arrival.kind !== "new" && !(arrival.kind === "replaced" && arrival.how === "retagged")) {
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
		this.standing = this.previous.flatMap((p) => (standsAtRenames(p.fate) ? [p.object] : []))
		this.worldGone = new Set(
			this.previous.flatMap(({ object, fate }) => {
				if (fate.kind !== "world") {
					return []
				}
				const v = installed(object)
				return v.kind === "view" || v.kind === "worldFunction" ? [nameKey(v.create.name)] : []
			})
		)
		const creations = new Map(this.typeOffersOf())
		this.replaced = this.replacedKeysOf()
		/** The candidate renames of logins, relations and fields, planned in the target's install order before anything
		 * is drafted, so an enum rebuild drafted first offers each candidate's conversion of a removed column it converts
		 * (rebuildOffers). */
		const keptPlans = new Map<string, KeptPlan>()
		for (const o of targetObjects) {
			const v = installed(o)
			if (v.kind === "table") {
				const kept = this.keptTables.get(o.ident)
				if (kept === undefined) {
					creations.set(o.ident, this.renameCandidateTable(v.create))
				} else {
					keptPlans.set(o.ident, this.planKept(kept))
				}
			} else if (v.kind === "role" && v.create.login && !this.prev.has(o.ident)) {
				creations.set(o.ident, this.loginOffers(v.create.name))
			}
		}
		this.creationOffers = creations
		this.keptPlans = keptPlans
	}

	/** The candidate renames offered on the creation of a target object (creationOffers). */
	offersOnCreation(o: ManifestObject): ReadonlyArray<TopOffer> {
		return this.creationOffers.get(o.ident) ?? []
	}

	/** Each table both installations hold, by identity (KeptTable): the fate of each field of the previous table is its
	 * field change's (fieldChange), dropped where the target holds it no longer; of each stored tag, kept, retagged
	 * where its value changes, or dropped. */
	keptTablesOf(): ReadonlyMap<string, KeptTable> {
		const previousObjects = this.input.previous.manifest.objects
		const previousTables = new Map(
			previousObjects.flatMap((o, order) => {
				const v = installed(o)
				return v.kind === "table" ? [[o.ident, { old: v.create, order }] as const] : []
			})
		)
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
					const fields = old.columns.map((b): readonly [string, ColumnFate] => {
						const c = create.columns.find((x) => x.name === b.name)
						if (c === undefined) {
							return [b.name, droppedColumn]
						}
						const change = fieldChange(b, c, this.rebuiltEnums)
						return [
							b.name,
							change.kind === "converted" ? { kind: "converted", by: change.by } : keptColumn
						]
					})
					const tags = previousObjects.flatMap(
						(p): ReadonlyArray<readonly [string, ColumnFate]> => {
							const w = installed(p)
							if (w.kind !== "storedTag" || nameKey(w.table) !== key) {
								return []
							}
							const now = this.next.get(p.ident)
							return [
								[
									w.column,
									now === undefined
										? droppedColumn
										: same(p.ddl, now.ddl)
											? keptColumn
											: retaggedColumn
								]
							]
						}
					)
					return [
						[o.ident, { object: o, order, old, create, fates: new Map([...fields, ...tags]) }]
					]
				}
			)
		)
	}

	/** The tables of which this migration converts a column in place, by table key. */
	convertedTables(): ReadonlyArray<string> {
		return [...this.keptTables.values()].flatMap((k) =>
			[...k.fates.values()].some((f) => f.kind === "converted") ? [nameKey(k.create.table)] : []
		)
	}

	/** What an object of the target is to this migration (Arrival): new when it follows no previous object. */
	arrivalOf(o: ManifestObject): Arrival {
		return this.arrivals.get(o.ident) ?? arrivedNew
	}

	push(slot: PlainSlot, draft: Draft): void {
		this.steps.push({ slot, draft })
	}

	/** A step of a residual law's own Validate file. */
	pushLaw(law: LawId, draft: Draft): void {
		this.steps.push({ slot: "validate.law", law, draft })
	}

	sql(slot: PlainSlot, statements: ReadonlyArray<SqlStatement>): void {
		for (const s of statements) {
			this.push(slot, statement(s))
		}
	}

	/** A drop of what the target no longer has, drafted in publish.removed at its place in the drop order (dropOrder) and
	 * its position `order` in the previous install order. */
	removal(rank: number, order: number, draft: Draft): void {
		this.removals.push({ rank, order, draft })
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
				note: `${asideWhy(a)}, so the draft renames it aside to ${quoteIdent(a.to)}${ownedAside(a)}; a candidate rename takes it from there, or the end of this migration drops it, a loss the reviewer decides`,
				instruction: `Keep the renames below and delete this line; they are one decision, kept or removed together`,
				keep: asideStatements(a)
			})
		}
		this.dropWorlds()
		this.dropViews()
		this.dropReplaced()
		this.markAttached()
		for (const t of this.targets) {
			this.visit(t)
		}
		this.sql("structure", this.rebuildTail)
		this.sql("validate", this.rebuildValidations)
		this.validations()
		this.laws()
		for (const p of this.previous.toReversed()) {
			if (p.fate.kind === "removed") {
				this.remove(p.object, p.order)
			}
		}
		this.grants()
		this.defaults()
		this.draftRemovals()
		this.markRenameCandidates()
		this.comments()
		return { steps: this.orderedSteps() }
	}

	orderedSteps(): ReadonlyArray<Step> {
		return this.steps.toSorted(stepOrder)
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

	/** The previous objects built over a column this migration replaces (ColumnFate converted or retagged), by identity,
	 * each with how: what is built over a column converted in place (objects.ts builtOver: a constraint, an index, a
	 * statistics object, a law trigger or a stored tag computed from it), and each foreign key referencing a key over
	 * one, which dropReplaced drops before the conversion; and what is built over a stored tag dropped and added again,
	 * which goes with the drop, a foreign key referencing a key over it dropped first by dropReplaced. */
	takenByReplacement(): ReadonlyMap<string, Replacement> {
		const out = new Map<string, Replacement>()
		/** How each of `columns` of `table` is replaced, of those this migration replaces: only a table both hold has
		 * a column replaced. */
		const hows = (
			table: ObjectName,
			columns: ReadonlyArray<string>
		): ReadonlyArray<Replacement> => {
			const fates = this.keptTables.get(tableIdent(table))?.fates
			return columns.flatMap((c) => {
				const how = fates?.get(c)?.kind
				return how === "converted" || how === "retagged" ? [how] : []
			})
		}
		for (const o of this.prev.values()) {
			const v = installed(o)
			const over = builtOver(v, (c) => keyOrCheckDefinition(c, this.prev))
			const taken = strongestReplacement([
				...(over === undefined ? [] : hows(over.table, over.columns)),
				...(v.kind === "foreignKey"
					? hows(
							v.constraint.references,
							v.constraint.referencedColumns.map((k) => k.column)
						)
					: [])
			])
			if (taken !== undefined) {
				out.set(o.ident, taken)
			}
		}
		return out
	}

	/** Drops what a conversion in place takes away (Taken replaced), before the conversion, in Structure: the foreign keys
	 * first, then the keys and CHECKs, the indexes, the statistics objects and the law triggers. PostgreSQL would carry
	 * each across the conversion under its old definition, or refuse the conversion under it (a foreign key compares
	 * only once both its sides are converted; a trigger's UPDATE OF pins its columns), so the target's is built again as
	 * on any relation that may hold rows. Of what a stored tag dropped and added again takes, it drops the foreign keys:
	 * the tag's DROP COLUMN drops every constraint and index of its own table over it, but refuses one a foreign key of
	 * another table depends on (2BP01), an arm's into an alternatives parent's key over its arm tag. */
	dropReplaced(): void {
		const drops = this.previous
			.flatMap(({ object: o, fate }) => {
				const v = installed(o)
				if (fate.kind !== "replaced" || (fate.how === "retagged" && v.kind !== "foreignKey")) {
					return []
				}
				const drop = replacementDrop(v)
				return drop === undefined ? [] : [drop]
			})
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

	/** Drafts what one object of the target needs, by what it is to this migration (Arrival): nothing for one an enum
	 * rebuild creates again (rebuildEnum).
	 *
	 * The refusal and isolation functions' bodies are fixed.
	 *
	 * A serial field's advance function, created after its table, and replaced in place when the sequence it names
	 * changes (a renamed relation or field), which keeps its grants.
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
	 * laws() and grants() handle them by law and by role.
	 *
	 * validations() handles them once every domain is visited. */
	visit({ object: o, arrival }: Target): void {
		if (arrival.kind === "rebuild") {
			return
		}
		const before = arrival.kind === "follows" ? arrival.before : undefined
		const v = installed(o)
		switch (v.kind) {
			case "schema":
				this.schemaObject(o, before)
				return
			case "databaseDefault":
			case "ledger":
			case "extension":
			case "refusalFunction":
			case "isolationFunction":
			case "snapshotGuard":
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
			case "enum":
				this.enumObject(v, this.enums.get(o.ident))
				return
			case "domain":
				this.domainObject(v, before)
				return
			case "table":
				this.tableObject(v)
				return
			case "storedTag":
				this.storedTag(v, before)
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
			case "lawTrigger":
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

	/** A login's or a theory role's CREATE ROLE, in Publish, under a login's candidate renames (loginOffers). */
	roleObject(v: Installed & { readonly kind: "role" }): void {
		this.push("publish.roles", offered(this.offersOnCreation(v.object), statement(v.create)))
	}

	/** The candidate renames of the added login `to`: each removed login. grizzle never sets a password, so a login
	 * dropped and created again has none until the operator sets one, while ALTER ROLE ... RENAME keeps it; only the
	 * reviewer knows which was meant. A theory role holds no data and no password, and everything naming it is created
	 * again with it, so it is never renamed. */
	loginOffers(to: string): ReadonlyArray<RootRename> {
		const removed = [...this.prev.values()].flatMap((o) => {
			const r = installed(o)
			return r.kind === "role" && r.create.login && !this.next.has(o.ident) ? [r.create.name] : []
		})
		return removed.map((from): RootRename => {
			const candidate: LoginCandidate = { kind: "login", removed: from, added: to }
			this.planned.push({
				kind: "login",
				candidate,
				qualified: inRelations(new Map()),
				drops: []
			})
			return {
				kind: "rename",
				candidate,
				note: `the login ${quoteIdent(to)} may be the removed login ${quoteIdent(from)}, which this migration drops; grizzle never sets a password, so a login dropped and created again has none until its operator sets one, while choosing the rename keeps it, and also decides the statements marked as part of it in this folder's files${this.ambiguity(removed.length, 1)}`,
				alternative: []
			}
		})
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
		if (create === undefined || !isNonEmpty(abandoned)) {
			this.sql("setup", o.ddl)
			return
		}
		this.push("setup", {
			kind: "loss",
			loses: { kind: "schema", schema: this.schema, abandoned },
			statement: create,
			carriers: []
		})
		this.sql("setup", rest)
	}

	/** An enum the target installs, new (undefined) or changed as `change` says.
	 *
	 * A removed handle is never drafted, since removing a label rebuilds the enum, so the rename is the one way
	 * the draft has, and a marker asks the reviewer to confirm it, or to change the rows that hold the old handle
	 * first.
	 *
	 * Each new label is placed before the next existing one.
	 *
	 * A rebuild was planned before any object was visited. */
	enumObject(v: Installed & { readonly kind: "enum" }, change: EnumChange | undefined): void {
		const { object: o, create } = v
		if (change === undefined) {
			this.push("setup", offered(this.offersOnCreation(o), statement(create)))
			this.sql("setup", o.ddl.slice(1))
			return
		}
		const { old, roster } = change
		switch (roster.kind) {
			case "unchanged":
				return
			case "renamed":
				for (const [from, to] of roster.handles) {
					this.push("setup", {
						kind: "confirm",
						note: `the handle ${quoteString(from)} of ${printObjectName(create.name)} is gone and ${quoteString(to)} takes its place, so the draft renames it: every row holding ${quoteString(from)} holds ${quoteString(to)} afterwards`,
						instruction: `Keep the rename below and delete this line. A handle removed rather than renamed is not drafted, since removing one rebuilds the enum: if ${quoteString(from)} is removed, delete or change the rows that hold it before this rename`,
						keep: [{ kind: "alterEnumRenameValue", name: create.name, from, to }]
					})
				}
				return
			case "added": {
				const existing = new Set(old.labels)
				this.sql(
					"setup.labels",
					create.labels.flatMap((label, k): ReadonlyArray<SqlStatement> => {
						if (existing.has(label)) {
							return []
						}
						const after = create.labels.slice(k + 1).find((l) => existing.has(l))
						return [
							{
								kind: "alterEnumAddValue",
								name: create.name,
								label,
								ifNotExists: true,
								position: after === undefined ? undefined : { kind: "BEFORE", label: after }
							}
						]
					})
				)
				return
			}
			case "rebuilt":
				if (roster.rebuild.kind === "refused") {
					refuseUnsupported(roster.rebuild)
				}
				this.rebuildEnum(roster.rebuild)
				return
		}
	}

	/** The rebuild of a closed relation's roster that loses or reorders handles: the enum rebuilt in place, in one Structure
	 * transaction (see `diff`). PostgreSQL cannot remove or reorder an enum's labels, so a new type takes the new
	 * roster under the naming door's rebuild name (identity.rebuild), which no other object takes; every column of the old type is
	 * converted to it, rewriting its table under an ACCESS EXCLUSIVE lock; the old type is dropped and the new one renamed
	 * to its name. What a conversion would fail under, or would leave dangling, is dropped first and created again from
	 * the target's definition once the type is back, at the end of Structure: each CHECK and partial index whose
	 * definition names the type, each foreign key over a column of it (the other side is converted after or before it),
	 * each stored tag of it, which cannot be converted, and the indexes over a dropped tag. A law trigger whose UPDATE OF
	 * or WHEN reads a column of the type, or whose WHEN names it, is dropped too, since PostgreSQL converts no column
	 * under a trigger that reads it, and laws() creates it again. A removed handle is mapped by
	 * the expression the reviewer writes at each column's placeholder. A domain or a materialized view over the type keeps
	 * a definition the rebuild cannot carry, and is refused with what to do.
	 * What it converts and drops is read from the previous manifest alone, so the rebuild is planned before any object is
	 * visited and what it drops is known to every rule (standing); it is drafted when its enum is visited (rebuildEnum).
	 *
	 * The column's one conversion needs its old type standing and its new type in place, which one
	 * rebuild cannot give when the new type is another roster rebuilt by this migration.
	 *
	 * What it drops goes in the drop order (dropOrder): the foreign keys first, then the CHECKs, the indexes, the law
	 * triggers and the tags, whose drop takes the rest over them. */
	planRebuild(
		create: CreateEnum,
		old: CreateEnum,
		replacedBy: ReadonlyMap<string, Replacement>,
		claimed: Set<string>
	): Rebuild {
		const name = create.name
		const key = nameKey(name)
		const where = SourceLoc(`closed relation of enum ${printObjectName(name)}`, [])
		const names = (value: unknown): boolean => qualifiedNames(value, this.schema).has(key)
		const typed = (t: TypeRef): boolean =>
			t.kind === "named" && t.schema === this.schema && t.name === name.name
		const installedObjects = this.input.previous.manifest.objects
		const conversions: Array<Conversion> = []
		const tags: Array<RebuiltTag> = []
		/** A table's columns of the type, each converted once (RebuiltColumn): to the type the target changes it to, or to
		 * the new type, which a column the target keeps of the type, drops, or whose table it drops holds until then; or
		 * the first refused. */
		const convertTable = (
			p: ManifestObject,
			createTable: CreateTable
		): RefusedRebuild | undefined => {
			const target = this.next.get(p.ident)
			const targetTable = target === undefined ? undefined : installed(target)
			const targetColumns: ReadonlyArray<ColumnDef> =
				targetTable?.kind === "table" ? targetTable.create.columns : []
			const rebuiltColumn = (c: ColumnDef): RebuiltColumn | RefusedRebuild => {
				const now = targetColumns.find((x) => x.name === c.name)
				if (now === undefined) {
					return { kind: "removed", column: c }
				}
				const change = fieldChange(c, now, this.rebuiltEnums)
				if (change.kind !== "converted") {
					return { kind: "rebuilt", column: c }
				}
				return now.type.kind === "named" &&
					this.rebuiltEnums.has(nameKey(objectName(now.type.schema, now.type.name)))
					? {
							kind: "refused",
							loc: where,
							capability: `removing or reordering handles of both ${printObjectName(name)} and ${printType(now.type)} while ${printObjectName(createTable.table)}.${quoteIdent(c.name)} changes from the one to the other: change the field's type in one migration and the handles in another`
						}
					: { kind: "retyped", was: c, column: now, change }
			}
			const classified = createTable.columns.filter((c) => typed(c.type)).map(rebuiltColumn)
			const refusal = classified.find((x): x is RefusedRebuild => x.kind === "refused")
			if (refusal === undefined) {
				const rebuiltColumns = classified.filter((x): x is RebuiltColumn => x.kind !== "refused")
				if (isNonEmpty(rebuiltColumns)) {
					conversions.push({ table: createTable.table, columns: rebuiltColumns })
				}
			}
			return refusal
		}
		/** What one installed object adds to the rebuild: a table's conversions, a stored tag of the type, or the refusal
		 * of a domain or materialized view defined over the type. */
		const visit = (p: ManifestObject): RefusedRebuild | undefined => {
			const v = installed(p)
			if (v.kind === "table") {
				return convertTable(p, v.create)
			}
			if (v.kind === "storedTag" && typed(v.definition.type)) {
				tags.push({ object: p, table: v.table, column: v.column })
				return undefined
			}
			if ((v.kind === "domain" || v.kind === "materializedView") && names(p.ddl)) {
				return {
					kind: "refused",
					loc: where,
					capability: `removing or reordering handles while ${p.ident} is defined over the type: remove it first, change the handles, then declare it again`
				}
			}
			return undefined
		}
		for (const p of installedObjects) {
			const refusal = visit(p)
			if (refusal !== undefined) {
				return refusal
			}
		}
		/** Whether a column of a table is a stored tag of the type, or of the type at all, a field it converts. */
		const tagged = (t: ObjectName, column: string): boolean =>
			tags.some((x) => nameKey(x.table) === nameKey(t) && x.column === column)
		const ofType = (t: ObjectName, column: string): boolean =>
			tagged(t, column) ||
			conversions.some(
				(c) => nameKey(c.table) === nameKey(t) && c.columns.some((x) => columnOf(x).name === column)
			)
		const overEnum = (t: ObjectName, columns: ReadonlyArray<string>) =>
			columns.some((c) => ofType(t, c))
		const overTag = (index: CreateIndex): boolean =>
			indexColumns(index).some((c) => tagged(index.table, c))
		/** The target's index of an identity, if it has one. */
		const targetIndex = (ident: string): CreateIndex | undefined => {
			const o = this.next.get(ident)
			const v = o === undefined ? undefined : installed(o)
			return v?.kind === "index" || v?.kind === "uniqueIndex" ? v.create : undefined
		}
		/** A materialized view over a converted table depends on its columns, which no conversion may change under it. */
		const convertedTables = new Set(conversions.map((c) => nameKey(c.table)))
		const view = [...this.reads].find(([, reads]) => [...reads].some((r) => convertedTables.has(r)))
		if (view !== undefined) {
			return {
				kind: "refused",
				loc: where,
				capability: `removing or reordering handles while the materialized view ${view[0]} reads a table of the type: remove it first, change the handles, then declare it again`
			}
		}
		/** The dependents dropped before the conversion, and what the target makes of each, read part by part. A key over a
		 * column of the type is converted with it, as a statistics object is; the stored tags themselves are dropped and
		 * added again, and a key over one, an alternatives parent's UNIQUE over its arm tag, goes with it and is added again
		 * once the tag is back, before the foreign keys that reference it. An index the target declares over a stored tag
		 * is created again once the tag is back, so the previous index of its name goes first.
		 * What a conversion in place takes away (Taken replaced) is dropped before it by dropReplaced, and drafted as new
		 * by the target's visit, so the rebuild leaves it to them; and what an earlier rebuild drops, that one does. */
		const dependentsOf = (p: ManifestObject, part: Part): ReadonlyArray<RebuiltDependent> => {
			switch (part.kind) {
				case "constraint": {
					const c = part.constraint
					const over =
						c.kind === "foreignKey"
							? overEnum(part.table, constraintColumns(c)) ||
								overEnum(
									c.references,
									c.referencedColumns.map((k) => k.column)
								)
							: c.kind === "check"
								? names(c)
								: c.kind !== "exclude" && constraintColumns(c).some((x) => tagged(part.table, x))
					return over
						? [
								{
									object: p,
									drop: {
										rank: dropOrder[c.kind === "exclude" ? "unique" : c.kind],
										draft: statement(alter(part.table, [{ kind: "dropConstraint", name: c.name }]))
									}
								}
							]
						: []
				}
				case "index": {
					const index = part.create
					const target = targetIndex(p.ident)
					return names(index) || overTag(index) || (target !== undefined && overTag(target))
						? [
								{
									object: p,
									drop: {
										rank: dropOrder.index,
										draft: statement({
											kind: "dropIndex",
											name: objectName(index.table.schema, index.name),
											concurrently: false,
											ifExists: false
										})
									}
								}
							]
						: []
				}
				case "lawTrigger":
					return overEnum(part.table, triggerColumns(part.create)) || names(part.create)
						? [{ object: p, drop: { rank: dropOrder.lawTrigger, draft: dropTrigger(part) } }]
						: []
				case "statistics":
				case "column":
				case "sequence":
					return []
			}
		}
		const dependents = installedObjects.flatMap((p) =>
			replacedBy.has(p.ident) || claimed.has(p.ident)
				? []
				: objectParts(installed(p), (c) => keyOrCheckDefinition(c, this.prev)).flatMap((part) =>
						dependentsOf(p, part)
					)
		)
		for (const d of dependents) {
			claimed.add(d.object.ident)
		}
		/** The target's indexes over a stored tag of the type whose previous index a replacement takes away: created again
		 * with the tag. */
		const overTags = this.input.target.manifest.objects.flatMap((o) => {
			const index = targetIndex(o.ident)
			return index !== undefined && overTag(index) && replacedBy.has(o.ident)
				? [{ object: o, create: index }]
				: []
		})
		return {
			kind: "planned",
			create,
			old,
			conversions,
			tags,
			dependents: dependents.toSorted(
				mapInput(compareNumbers, (d: RebuiltDependent) => d.drop.rank)
			),
			overTags
		}
	}

	/** A planned enum rebuild, drafted (planRebuild).
	 *
	 * A column the target removes is converted alone, at a step of its own, where a candidate that renames it with
	 * its type changed offers its own conversion in place of this one (rebuildOffers).
	 *
	 * A column the target changes to another type is converted to it here, its one conversion, while its old
	 * type still stands.
	 *
	 * The new type has the default privileges: the grants on the old one and its PUBLIC revoke, again.
	 *
	 * What was dropped comes back as the target declares it, once everything else of Structure is in place; what
	 * the target no longer has stays dropped. */
	rebuildEnum({
		create,
		old,
		conversions,
		tags,
		dependents: ordered,
		overTags
	}: PlannedRebuild): void {
		const name = create.name
		const key = nameKey(name)
		const installedObjects = this.input.previous.manifest.objects
		const rebuilt = objectName(name.schema, identifierOf(identity.rebuild(name.name)))
		const rebuiltType: TypeRef = namedType(this.input.installation.names.types, rebuilt.name, [])
		const removed = old.labels.filter((l) => !create.labels.includes(l))
		const reordered = removed.length === 0
		const rewritten = conversions.map((c) => printObjectName(c.table)).join(", ")
		const note = reordered
			? `the handles of ${printObjectName(name)} change order (${old.labels.map(quoteString).join(", ")} to ${create.labels.map(quoteString).join(", ")}), which PostgreSQL cannot do in place, so the draft rebuilds the enum: every row keeps its handle, and each table that holds the type${rewritten === "" ? "" : ` (${rewritten})`} is rewritten under an ACCESS EXCLUSIVE lock while its column is converted`
			: `the handles ${removed.map(quoteString).join(", ")} of ${printObjectName(name)} are removed, which PostgreSQL cannot do in place, so the draft rebuilds the enum: each row holding a removed handle takes the one the expression at its column's placeholder maps it to; and each table that holds the type${rewritten === "" ? "" : ` (${rewritten})`} is rewritten under an ACCESS EXCLUSIVE lock while its column is converted`
		this.push("structure", {
			kind: "confirm",
			note,
			instruction: `Keep the rebuild below and delete this line; it runs in one transaction, and a statement drafted later in this file for something it drops is part of it`,
			keep: [{ kind: "createEnum", name: rebuilt, labels: [...create.labels] }]
		})
		const drops = [
			...ordered.map((d) => d.drop),
			...tags.map((t): Drop => ({
				rank: dropOrder.storedTag,
				draft: statement(alter(t.table, [{ kind: "dropColumn", column: t.column }]))
			}))
		].toSorted(byDropOrder)
		for (const d of drops) {
			this.push("structure", d.draft)
		}
		const [removedFirst, ...removedRest] = removed
		const [label, ...labels] = create.labels
		/** A column's conversion to the new type: by its text, or by the reviewer's mapping of the removed handles. */
		const toRebuilt = (
			table: ObjectName,
			columns: NonEmptyReadonlyArray<ColumnDef>
		): ReadonlyArray<Action> =>
			removedFirst === undefined || label === undefined
				? [
						statement(
							alter(
								table,
								mapNonEmpty(columns, (x): AlterTableAction => ({
									kind: "alterColumnType",
									column: x.name,
									type: rebuiltType,
									using: {
										kind: "expr",
										expr: cast(cast(tableCol(x.name), types.text), rebuiltType)
									},
									collation: undefined
								}))
							)
						)
					]
				: columns.map((x): Action => ({
						kind: "placeholderHandles",
						table,
						column: x.name,
						type: rebuiltType,
						removed: [removedFirst, ...removedRest],
						labels: [label, ...labels]
					}))
		for (const c of conversions) {
			const kept = c.columns.flatMap((x) => (x.kind === "rebuilt" ? [x.column] : []))
			for (const a of isNonEmpty(kept) ? toRebuilt(c.table, kept) : []) {
				this.push("structure", a)
			}
			for (const x of c.columns.flatMap((y) => (y.kind === "removed" ? [y.column] : []))) {
				const offers = this.rebuildOffers.flatMap((o) =>
					nameKey(o.table) === nameKey(c.table) && o.column === x.name ? [o.offer] : []
				)
				for (const a of toRebuilt(c.table, [x])) {
					this.push("structure", offered(offers, a))
				}
			}
			for (const x of c.columns.flatMap((y) => (y.kind === "retyped" ? [y] : []))) {
				this.changeInPlace(c.table, x.was, x.column, x.change)
			}
		}
		this.sql("structure", [
			{ kind: "drop", object: "TYPE", name, ifExists: false },
			{ kind: "rename", object: "TYPE", name: rebuilt, to: name.name }
		])
		for (const s of installedObjects.flatMap((p) => p.ddl)) {
			if (
				s.kind === "grant" &&
				s.on.kind === "TYPE" &&
				s.on.names.some((n) => nameKey(n) === key)
			) {
				this.sql("structure", [{ ...s, on: { kind: "TYPE", names: [name] } }])
			}
		}
		for (const s of this.input.previous.manifest.publicRevokes) {
			if (
				s.kind === "revoke" &&
				s.on.kind === "TYPE" &&
				s.on.names.some((n) => nameKey(n) === key)
			) {
				this.sql("structure", [{ ...s, on: { kind: "TYPE", names: [name] } }])
			}
		}
		for (const t of tags) {
			const target = this.next.get(t.object.ident)
			if (target !== undefined) {
				appendAll(this.rebuildTail, target.ddl)
			}
		}
		for (const d of ordered) {
			const target = this.next.get(d.object.ident)
			if (target === undefined) {
				continue
			}
			const v = installed(target)
			if (v.kind === "primaryKey" || v.kind === "unique") {
				this.rebuildTail.push(
					alter(v.table, [
						{
							kind: "addConstraint",
							constraint: this.constraintOf(target, this.next),
							notValid: false
						}
					])
				)
			}
		}
		for (const d of ordered) {
			const target = this.next.get(d.object.ident)
			if (target === undefined) {
				continue
			}
			const v = installed(target)
			if (v.kind === "index" || v.kind === "uniqueIndex") {
				this.rebuildTail.push(v.create)
			} else if (v.kind === "check" || v.kind === "foreignKey") {
				const c = this.constraintOf(target, this.next)
				this.rebuildTail.push(
					alter(v.table, [{ kind: "addConstraint", constraint: c, notValid: true }])
				)
				this.rebuildValidations.push(alter(v.table, [{ kind: "validateConstraint", name: c.name }]))
			}
		}
		for (const index of overTags) {
			this.rebuildTail.push(index.create)
		}
	}

	domainObject(
		v: Installed & { readonly kind: "domain" },
		before: ManifestObject | undefined
	): void {
		const { object: o, create } = v
		if (before === undefined) {
			this.push("setup", offered(this.offersOnCreation(o), statement(create)))
			this.sql("setup", o.ddl.slice(1))
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

	/** The candidate renames of each enum and domain the target adds (enumObject and domainObject draft them new), as
	 * their offers, by identity. They are made before any object is visited, in the target's install order, so every rule
	 * reads them whatever the order it runs in: a field's pairing with a removed field of a type one of them renames
	 * (pairings), and through it the candidate renames of the fields and the keys they leave standing (keyImages). A
	 * closed relation renamed keeps its handles in order. A contract renamed keeps its base and its predicate; its
	 * constraint is named after the contract, so the rename replaces it under the new name, which validates the stored
	 * values again. A text pattern's domain is named by its pattern, so one pattern keeps its domain; a domain may be
	 * renamed into another of its shape, a pattern's or a contract's alike. */
	typeOffersOf(): ReadonlyMap<string, ReadonlyArray<TopOffer>> {
		return new Map(
			this.input.target.manifest.objects.flatMap(
				(o): ReadonlyArray<readonly [string, ReadonlyArray<TopOffer>]> => {
					const v = installed(o)
					if (v.kind === "enum" && !this.enums.has(o.ident)) {
						const create = v.create
						return [
							[
								o.ident,
								this.typeCandidates(
									create,
									"TYPE",
									(t) => (t.kind === "enum" ? t.create : undefined),
									(a, b) => same(a.labels, b.labels),
									() => []
								)
							]
						]
					}
					if (v.kind === "domain" && this.beforeOf(o) === undefined) {
						const create = v.create
						return [
							[
								o.ident,
								this.typeCandidates(
									create,
									"DOMAIN",
									(t) => (t.kind === "domain" ? t.create : undefined),
									(a, b) => same(domainShape(a), domainShape(b)),
									(old) => [
										...old.constraints.map((c): SqlStatement => ({
											kind: "alterDomain",
											name: create.name,
											action: { kind: "dropConstraint", name: c.name }
										})),
										...create.constraints.map((c): SqlStatement => ({
											kind: "alterDomain",
											name: create.name,
											action: { kind: "addConstraint", constraint: c, notValid: false }
										}))
									]
								)
							]
						]
					}
					return []
				}
			)
		)
	}

	/** The candidate renames to the added enum or domain `create` of each installed one the target removes that `matches`
	 * it, as their rename offers: the alternative renames the type in place, so every column it types keeps its rows,
	 * then runs what follows the rename (`after`): a domain's constraints replaced under the new name. */
	typeCandidates<T extends CreateEnum | CreateDomain>(
		create: T,
		object: TypeCandidate["object"],
		/** The type of an installed object, when it is of create's kind. */
		typeOf: (v: Installed) => T | undefined,
		matches: (a: T, b: T) => boolean,
		after: (old: T) => ReadonlyArray<SqlStatement>
	): ReadonlyArray<RootRename> {
		const to = create.name
		const typesOf = (
			objects: ReadonlyArray<ManifestObject>,
			other: ReadonlyMap<string, ManifestObject>
		) =>
			objects.flatMap((o) => {
				const t = other.has(o.ident) ? undefined : typeOf(installed(o))
				return t === undefined ? [] : [t]
			})
		const added = typesOf(this.input.target.manifest.objects, this.prev)
		const removals = typesOf(this.input.previous.manifest.objects, this.next).filter((old) =>
			matches(old, create)
		)
		return removals.flatMap((old): ReadonlyArray<RootRename> => {
			const from = old.name
			const candidate: TypeCandidate = { kind: "type", object, removed: from, added: to }
			this.planned.push({
				kind: "type",
				candidate,
				qualified: inTypes(new Map([[from.name, to.name]])),
				drops: []
			})
			return [
				{
					kind: "rename",
					candidate,
					note: `${printObjectName(to)} has the definition of the removed type ${printObjectName(from)}, which this migration drops; choosing the rename keeps the rows of every column it types in place, and also decides the statements marked as part of it in this folder's files${this.ambiguity(removals.length, added.filter((a) => matches(old, a)).length)}`,
					alternative: after(old).map((x) => statement(x))
				}
			]
		})
	}

	/** The delete offers of a column's type change that a type candidate makes no change: the column keeps its rows in
	 * place under the renamed type. */
	retypeOffers(t: ObjectName, b: ColumnDef, c: ColumnDef): ReadonlyArray<PlainOffer> {
		return this.typeCandidatesOf().flatMap((x): ReadonlyArray<PlainOffer> => {
			if (!this.retypes(x, b, c)) {
				return []
			}
			return [
				{
					kind: "delete",
					candidate: x.candidate,
					note: `the statement below replaces ${printObjectName(t)}.${quoteIdent(b.name)}, of the removed type ${printObjectName(x.candidate.removed)}, by a column of ${printObjectName(x.candidate.added)}, which ${labelOf(x)} makes the column's own type`
				}
			]
		})
	}

	/** The type candidates, every one made before any object is visited (typeOffersOf). */
	typeCandidatesOf(): ReadonlyArray<PlannedType> {
		return this.planned.flatMap((x) => (x.kind === "type" ? [x] : []))
	}

	/** Whether the type candidate `x` makes the column `b`'s type the column `c`'s: `b` is of a type of this schema,
	 * which `x` renames, and under the new name the two types agree. */
	retypes(x: PlannedType, b: ColumnDef, c: ColumnDef): boolean {
		if (b.type.kind !== "named" || b.type.schema !== this.schema) {
			return false
		}
		const renamed = x.qualified.names.get(b.type.name)
		return renamed !== undefined && !typeChanged({ ...b, type: { ...b.type, name: renamed } }, c)
	}

	/** Two declarations of a relation's fields, the previous one's and the target's, paired (FieldPairs), each removed
	 * field an added one may be renamed from with the keys its rename carries across (`keysOf`). */
	fieldPairs(
		old: ReadonlyArray<ColumnDef>,
		target: ReadonlyArray<ColumnDef>,
		keysOf: (removed: ColumnDef, added: ColumnDef) => ReadonlyArray<CarriedKey>
	): FieldPairs {
		const removed = old.filter((c) => !target.some((x) => x.name === c.name))
		return {
			removed,
			fields: target.map((c): PairedField => {
				const held = old.find((x) => x.name === c.name)
				if (held !== undefined) {
					return { kind: "held", column: c, was: held }
				}
				const renames = this.pairings(removed, c, keysOf)
				const retypes =
					renames.length > 0 || c.generated !== undefined
						? []
						: removed.flatMap((r): ReadonlyArray<Retyping> =>
								r.generated === undefined ? [{ column: r, keys: keysOf(r, c) }] : []
							)
				return { kind: "added", column: c, renames, retypes }
			})
		}
	}

	/** The removed fields among `removed` that the added field `c` may be renamed from as they are: those of its type,
	 * then those of a type a type candidate makes its type, both generated or neither. */
	pairings(
		removed: ReadonlyArray<ColumnDef>,
		c: ColumnDef,
		keysOf: (removed: ColumnDef, added: ColumnDef) => ReadonlyArray<CarriedKey>
	): ReadonlyArray<Pairing> {
		const sameTyped = removed.filter((r) => sameColumnType(r, c))
		const viaType = removed.flatMap((r): ReadonlyArray<Pairing> => {
			if ((r.generated === undefined) !== (c.generated === undefined) || sameTyped.includes(r)) {
				return []
			}
			return this.typeCandidatesOf()
				.filter((x) => this.retypes(x, r, c))
				.map((candidate) => ({
					column: r,
					via: { kind: "renamed type", candidate },
					keys: keysOf(r, c)
				}))
		})
		return [
			...sameTyped.map((column): Pairing => ({
				column,
				via: { kind: "same type" },
				keys: keysOf(column, c)
			})),
			...viaType
		]
	}

	/** A kept table's fields paired, each rename carrying the keys over the removed field across (carriedKeys). */
	keptPairs(kept: KeptTable): FieldPairs {
		return this.fieldPairs(kept.old.columns, kept.create.columns, (r, c) =>
			this.carriedKeys(kept, r.name, c.name)
		)
	}

	/** A kept table as its visit drafts it (KeptPlan). A removed field of the added one's type, or of a type a type's
	 * candidate rename makes its type, is a candidate rename; with none, each removed field of another type, neither
	 * generated, is a candidate rename that converts the column in place (fieldPairs). The candidates are made in the
	 * order of the added fields. Its identity sequences pair by column, as a relation's rename pairs them. */
	planKept(kept: KeptTable): KeptPlan {
		const t = kept.create.table
		const pairs = this.keptPairs(kept)
		const holder = keptHolder(t)
		const offers = addedFields(pairs).flatMap((f) => [
			...this.renameCandidateColumn(holder, f.renames, f.column, (r) => renamingsOf(pairs, r)),
			...this.retypeCandidateColumn(holder, f.retypes, f.column, (r) => retypingsOf(pairs, r))
		])
		const sequences = pairParts(
			this.partsOf(t, this.prev).sequence,
			this.partsOf(t, this.next).sequence,
			(s) => carries("sequence", [s.column], (c) => columnFate(kept, c)),
			(s, as) => s.column === as.column
		)
		return { table: kept, pairs, offers, sequences }
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
			const recast = [...qualifiedNames(o.ddl, this.schema)].some((k) => this.reconstrained.has(k))
			if (changed || recast) {
				this.sql("publish", o.ddl)
			}
		}
	}

	/** A table: one the previous installation lacks created, under the candidate renames of the removed relations it
	 * may be (renameCandidateTable); one both hold changed field by field (keptTable). */
	tableObject(v: Installed & { readonly kind: "table" }): void {
		const plan = this.keptPlans.get(v.object.ident)
		if (plan === undefined) {
			this.push("structure", offered(this.offersOnCreation(v.object), statement(v.create)))
			return
		}
		this.keptTable(plan)
	}

	/** A table both installations hold, as planned (KeptPlan). Each removed column is dropped at the end of the
	 * migration, once nothing reads it any longer, a loss of its values the reviewer decides; a candidate that renames
	 * the column takes it away under its old name and carries its values instead. A column of an enum a rebuild replaces
	 * is converted in the rebuild (planRebuild): the table is visited after the enum, and the rebuild drops the old type.
	 *
	 * DROP IDENTITY drops the sequence, and its privileges with it. */
	keptTable({ table: kept, pairs, offers, sequences }: KeptPlan): void {
		const t = kept.create.table
		for (const r of pairs.removed) {
			this.removal(dropOrder.column, kept.order, fieldLoss(t, t, r.name, carriersOf(offers, r)))
		}
		for (const f of pairs.fields) {
			if (f.kind === "added") {
				this.addColumn(
					t,
					f.column,
					offers.flatMap((o) => (o.added === f.column ? [o.offer] : []))
				)
				continue
			}
			this.changeField(t, f.was, f.column, sequences)
		}
	}

	/** What a field both tables hold drafts for its change from `b` to `c` (fieldChange): the rename of its identity
	 * sequence when the target names it otherwise (KeptPlan sequences); otherwise its steps in place (changeInPlace),
	 * unless its enum's rebuild converts it. */
	changeField(
		t: ObjectName,
		b: ColumnDef,
		c: ColumnDef,
		sequences: ReadonlyArray<Paired<PartOf<"sequence">>>
	): void {
		const change = fieldChange(b, c, this.rebuiltEnums)
		if (change.kind === "kept") {
			this.sql(
				"structure",
				sequences.flatMap((p): ReadonlyArray<SqlStatement> =>
					p.kind === "brought" &&
					p.pair.column === c.name &&
					nameKey(p.was.sequence) !== nameKey(p.pair.sequence)
						? [{ kind: "rename", object: "SEQUENCE", name: p.was.sequence, to: p.pair.name }]
						: []
				)
			)
			return
		}
		if (change.kind === "converted" && change.by === "rebuild") {
			return
		}
		this.changeInPlace(t, b, c, change)
	}

	/** The steps of a field's change in place from `b` to `c` (inPlace), its conversion by its cast or its placeholder
	 * (conversion), each under the offers of the type candidates that make it unnecessary (retypeOffers): a field of a
	 * table both install, or one an enum rebuild converts from the old type to another. */
	changeInPlace(t: ObjectName, b: ColumnDef, c: ColumnDef, change: FieldChange): void {
		const retype = this.retypeOffers(t, b, c)
		for (const step of inPlace(t, b, c, change, (column) => [this.conversion(t, b, column)])) {
			this.push("structure", offered(retype, step))
		}
	}

	/** Whether the previous column `was` and the target's `column` hold the same values (representationOf), each type
	 * read through its own installation's domains: a cast from one to the other keeps every value. */
	keepsValues(was: ColumnDef, column: ColumnDef): boolean {
		return (
			representationOf(was.type, was.collation, this.prevDomains) ===
			representationOf(column.type, column.collation, this.nextDomains)
		)
	}

	/** The conversion in place of the column `column` of `t`, of the previous column `was`'s type, to `column`'s type:
	 * by its cast when the two hold the same values (keepsValues), so only the laws of their domains change and the new
	 * ones judge the stored values as the cast runs; otherwise by the expression the reviewer writes at its placeholder. */
	conversion(t: ObjectName, was: ColumnDef, column: ColumnDef): ColumnConversion {
		if (!this.keepsValues(was, column)) {
			return { kind: "placeholderRetype", table: t, column }
		}
		return {
			kind: "statement",
			statement: alter(t, [
				{
					kind: "alterColumnType",
					column: column.name,
					type: column.type,
					collation: column.collation,
					using: { kind: "expr", expr: cast(tableCol(column.name), column.type) }
				}
			])
		}
	}

	/** Whether an enum rebuild converts the removed column `column` of `table` (RebuiltColumn removed). */
	rebuildConverts(table: ObjectName, column: string): boolean {
		return this.rebuilds.some((r) =>
			r.conversions.some(
				(c) =>
					nameKey(c.table) === nameKey(table) &&
					c.columns.some((x) => x.kind === "removed" && x.column.name === column)
			)
		)
	}

	/** The conversion a candidate's alternative makes of the removed column `r` of `was`, which the candidate renames to
	 * `c` of `t` with its type changed: in the alternative, after the rename; or, when an enum rebuild converts `r`
	 * (RebuiltColumn removed), none, the candidate offering its conversion at the rebuild's own conversion of `r`
	 * instead, under the old names (rebuildOffers), so the column is converted once whichever way the reviewer decides. */
	conversionIn(
		candidate: Candidate,
		was: ObjectName,
		r: ColumnDef,
		t: ObjectName,
		c: ColumnDef
	): ReadonlyArray<ColumnConversion> {
		if (!this.rebuildConverts(was, r.name)) {
			return [this.conversion(t, r, c)]
		}
		const conversion = this.conversion(was, r, { ...c, name: r.name })
		this.rebuildOffers.push({
			table: was,
			column: r.name,
			offer: {
				kind: "convert",
				candidate,
				note: `the statement below converts ${printObjectName(was)}.${quoteIdent(r.name)} to the enum this migration rebuilds; choosing ${candidateLabel(candidate)} converts it here to ${printType(c.type)} instead, ${conversionsBy(1, conversion.kind === "statement" ? 1 : 0)}, its one conversion`,
				conversion
			}
		})
		return []
	}

	/** A new column. A new serial field numbers the existing rows from its new sequence. */
	addColumn(t: ObjectName, c: ColumnDef, offers: ReadonlyArray<TopOffer>): void {
		if (c.generated !== undefined) {
			this.push(
				"structure",
				offered(offers, statement(alter(t, [{ kind: "addColumn", column: c }])))
			)
			return
		}
		this.push(
			"structure",
			offered(offers, { kind: "placeholderColumn", table: t, column: c, hint: noHint })
		)
	}

	/** A removed relation with the heading of an added one, its primary key or its field names (renamePair): the
	 * alternative renames the relation, and leaves it holding exactly what the target declares. Each part of the removed
	 * relation that stands when the rename runs (objects.ts objectParts: a constraint, index, statistics object, stored
	 * tag or identity sequence) whose definition under the new names is one the added relation declares is brought
	 * across, renamed to the target's name (pairParts), and the target's own statement creating it is marked; every other
	 * one is dropped, its foreign keys first. A key it drops that another relation's foreign key references cannot be
	 * dropped under that reference (2BP01), so the alternative drops the reference before it: the drafted statements add
	 * the target's references again, NOT VALID and then validated, and a drafted teardown of a dropped reference is
	 * marked. A law trigger over a field it drops or converts is dropped before the fields change, and its drafted drop
	 * is marked. The fields only the added relation has are added, each with a placeholder that names the removed fields
	 * it may be computed from; each field both have that changes, its type or its identity, changes in place as a field
	 * of a table both install does (inPlace), converted by its conversion (conversionIn); then the fields only the
	 * removed relation has are dropped, after the constraints over them. A constraint the target declares inside its
	 * CREATE TABLE, which the alternative replaces, is added by the alternative itself once its columns are there.
	 *
	 * The identity sequences of the removed fields, and of the fields that give their identity up, go with them, and a
	 * revoke of one with them.
	 *
	 * A conversion a type's candidate rename makes unnecessary is a choice nested in this one: choosing
	 * that rename too, the column already has its new type. */
	renameCandidateTable(create: CreateTable): ReadonlyArray<RelationRename> {
		const removals = this.input.previous.manifest.objects.flatMap((o) => {
			const old = o.kind === "table" && !this.next.has(o.ident) ? this.createTableOf(o) : undefined
			return old !== undefined && renamePair(old, create) ? [old] : []
		})
		return removals.map((old) => this.renameOffer(old, create, removals.length))
	}

	/** The candidate rename of the removed table `old` to the added `create`, which `rivalCount` removed tables of its
	 * heading could be renamed to. */
	renameOffer(old: CreateTable, create: CreateTable, rivalCount: number): RelationRename {
		const to = create.table
		const from = old.table
		/** The fields only one side has: the relation's rename adds and drops them. */
		const pairs = this.fieldPairs(old.columns, create.columns, noKeys)
		const added = addedFields(pairs).map((f) => f.column)
		const lost = pairs.removed
		/** The parts of each relation (objectParts): the removed one's that still stand when the rename runs
		 * (standing), and the added one's. */
		const fromParts = relationParts(from, this.standing, this.prev)
		const toParts = this.partsOf(to, this.next)
		/** The stored tags the target declares as they were are brought across; every other one is dropped, and the
		 * target's own statement adds it again, so whatever is built over it goes with its drop and is built again
		 * (carriedOver), even when its definition is the target's (a tag whose value is a handle renamed in place,
		 * under its tagged reference). */
		const tags = pairParts(
			fromParts.column,
			toParts.column,
			() => true,
			(column, as) => same(column.definition, as.definition)
		)
		/** The stored tags of the removed relation, an enum rebuild's dropped ones among them. */
		const allTags = this.partsOf(from, this.prev).column
		/** The fields both have, each with its column before and its change (fieldChange), as a table both install
		 * changes them. */
		const held = create.columns.flatMap((c) => {
			const was = old.columns.find((x) => x.name === c.name)
			return was === undefined
				? []
				: [{ was, column: c, change: fieldChange(was, c, this.rebuiltEnums) }]
		})
		/** What the rename does to each column of the removed relation (ColumnFate): a field the added relation lacks
		 * is dropped, one whose type changes converted in place by this candidate, a stored tag it does not bring across
		 * retagged, one an enum rebuild dropped before it runs dropped, and every other column kept. */
		const fate = (column: string): ColumnFate => {
			if (old.columns.some((c) => c.name === column)) {
				const field = held.find((f) => f.was.name === column)
				return field === undefined
					? droppedColumn
					: field.change.kind === "converted"
						? { kind: "converted", by: "candidate" }
						: keptColumn
			}
			const tag = tags.find((p) => p.was.name === column)
			if (tag !== undefined) {
				return tag.kind === "dropped" ? retaggedColumn : keptColumn
			}
			return allTags.has(column)
				? droppedColumn
				: refuse(tableIdent(from), `a table whose columns include ${column}`)
		}
		/** The identity sequences, each of the field it is the identity of: one the added relation names otherwise is
		 * renamed with it, one of a field it drops goes with the field, and one of a field that gives its identity up
		 * (inPlace) goes with the identity. */
		const sequences = pairParts(
			fromParts.sequence,
			toParts.sequence,
			(s) => carries("sequence", [s.column], fate),
			(s, as) => s.column === as.column
		)
		const sequenceRenames = sequences.flatMap((p): ReadonlyArray<SqlStatement> =>
			p.kind === "brought" && p.pair.name !== p.was.name
				? [{ kind: "rename", object: "SEQUENCE", name: p.was.sequence, to: p.pair.name }]
				: []
		)
		const qualified = new Map<string, string>([
			[from.name, to.name],
			...sequences.flatMap((p): ReadonlyArray<readonly [string, string]> =>
				p.kind === "brought" && p.pair.name !== p.was.name ? [[p.was.name, p.pair.name]] : []
			)
		])
		/** A statement of the removed relation under the new names, to compare with the target's. */
		const underNewNames = (original: SqlStatement): SqlStatement =>
			renameStatement(original, this.schema, inRelations(qualified))
		/** The fields both have whose type changes, converted in place. */
		const retyped = held.filter((f) => f.change.kind === "converted")
		/** Each part of the removed relation paired with the added relation's part it is under the new names, or
		 * with none (pairParts), by kind. A foreign key that references a removed key the target's replaces
		 * (replacedKey) is never brought across: renamed, it would keep its binding to the removed key's index, whose
		 * drop PostgreSQL then refuses (2BP01), so the alternative drops it and the target's statement adds it again
		 * once the removed key is gone. */
		const paired: Pairs = {
			constraint: pairParts(
				fromParts.constraint,
				toParts.constraint,
				(c) =>
					carries("constraint", constraintColumns(c.constraint), fate) &&
					!(c.constraint.kind === "foreignKey" && this.referencesReplaced(c.constraint)),
				(c, as) =>
					same(
						underNewNames(
							alter(to, [
								{
									kind: "addConstraint",
									constraint: { ...c.constraint, name: as.name },
									notValid: false
								}
							])
						),
						alter(to, [{ kind: "addConstraint", constraint: as.constraint, notValid: false }])
					)
			),
			index: pairParts(
				fromParts.index,
				toParts.index,
				(i) => carries("index", indexColumns(i.create), fate),
				(i, as) =>
					same(
						{ ...i.create, concurrently: false, name: as.name, table: to },
						{ ...as.create, concurrently: false }
					)
			),
			statistics: pairParts(
				fromParts.statistics,
				toParts.statistics,
				(s) => carries("statistics", s.create.columns, fate),
				(s, as) => same({ ...s.create, name: as.create.name, table: to }, as.create)
			),
			column: tags,
			sequence: sequences,
			lawTrigger: [...fromParts.lawTrigger.values()].filter(
				(t) => !carries("lawTrigger", triggerColumns(t.create), fate)
			)
		}
		const relation: RelationCandidate = { kind: "relation", removed: from, added: to }
		const ownPart = (kind: PreviousPart["kind"], name: string): PreviousPart => ({
			kind,
			table: from,
			name
		})
		/** The removed relation's own foreign keys it drops go first, then its other drops and renames. */
		const ownReferences: Array<PreviousPart> = []
		const ownDrops: Array<PreviousPart> = []
		const constraints: Array<SealedStep> = []
		const dropped: Array<TableConstraint> = []
		for (const p of paired.constraint) {
			const c = p.was
			if (p.kind === "dropped") {
				dropped.push(c.constraint)
				const part = ownPart("constraint", c.name)
				ownDrops.push(part)
				if (c.constraint.kind === "foreignKey") {
					ownReferences.push(part)
				} else {
					constraints.push(this.droppedOnce(relation, part, to))
				}
			} else if (p.pair.name !== c.name) {
				constraints.push(
					statement({ kind: "renameConstraint", table: to, from: c.name, to: p.pair.name })
				)
			}
		}
		/** Another relation's foreign keys that reference a key it drops, dropped before the key. */
		const references = dropped
			.flatMap((c) => this.referencesTo(from, c))
			.filter((r) => nameKey(r.table) !== nameKey(from))
		const triggers = paired.lawTrigger.map((t) => ownPart("lawTrigger", t.name))
		const drops: ReadonlyArray<PreviousPart> = [...references, ...ownDrops, ...triggers]
		/** What brings each part across under its target name, or drops it, by kind, before the fields change or
		 * after. A constraint goes before, its foreign keys first, since a field converted in place keeps no
		 * constraint over it; one the target declares inside its CREATE TABLE, which the alternative replaces, is
		 * added after, once its columns are there. A law trigger it drops goes before too, since PostgreSQL refuses to
		 * convert or drop a column its UPDATE OF names. An index, a statistics object, a stored tag and an identity
		 * sequence go after. A stored tag is the target's only under its own name, so none is renamed. */
		const carried: {
			readonly [K in PartKind]: {
				readonly before: ReadonlyArray<SealedStep>
				readonly after: ReadonlyArray<SealedStep>
			}
		} = {
			constraint: {
				before: [
					...references.map((r) => this.droppedOnce(relation, r, r.table)),
					...ownReferences.map((r) => this.droppedOnce(relation, r, to)),
					...constraints
				],
				after: [...toParts.constraint.values()]
					.filter((c) => c.inline && !brings(paired, "constraint", c.name))
					.map((c) =>
						statement(
							alter(to, [{ kind: "addConstraint", constraint: c.constraint, notValid: false }])
						)
					)
			},
			index: {
				before: [],
				after: paired.index.flatMap((p): ReadonlyArray<SealedStep> => {
					const i = p.was
					const name = objectName(from.schema, i.name)
					if (p.kind === "dropped") {
						return [statement({ kind: "dropIndex", name, concurrently: false, ifExists: false })]
					}
					return p.pair.name === i.name
						? []
						: [statement({ kind: "rename", object: "INDEX", name, to: p.pair.name })]
				})
			},
			statistics: {
				before: [],
				after: paired.statistics.flatMap((p): ReadonlyArray<SealedStep> => {
					const s = p.was
					if (p.kind === "dropped") {
						return [{ kind: "dropStatistics", name: s.create.name }]
					}
					return p.pair.name === s.name
						? []
						: [
								statement({
									kind: "rename",
									object: "STATISTICS",
									name: s.create.name,
									to: p.pair.name
								})
							]
				})
			},
			column: {
				before: [],
				after: tags.flatMap((p) =>
					p.kind === "dropped"
						? [statement(alter(to, [{ kind: "dropColumn", column: p.was.name }]))]
						: []
				)
			},
			sequence: { before: [], after: sequenceRenames.map(statement) },
			lawTrigger: {
				before: triggers.map((t) => this.droppedOnce(relation, t, to)),
				after: []
			}
		}
		/** Each pair of a removed and an added field is a candidate rename nested in the relation's, offered as a
		 * field's is outside a relation's rename (fieldPairs): a removed field of the added one's type or of a type
		 * a type's candidate rename makes its type, or with none, each removed field of another type, neither
		 * generated, converted in place. Its marked statements are the addition, which it replaces with the rename,
		 * and the removed field's drop, which it deletes. */
		const holder = nestedHolder(relation)
		const fieldOffers = addedFields(pairs).map((f) => ({
			column: f.column,
			offers: [
				...this.renameCandidateColumn(holder, f.renames, f.column, (r) => renamingsOf(pairs, r)),
				...this.retypeCandidateColumn(holder, f.retypes, f.column, (r) => retypingsOf(pairs, r))
			]
		}))
		const additions = fieldOffers.map(({ column: c, offers: fieldOffered }): RelationStep =>
			offered(
				fieldOffered.map((f) => f.offer),
				c.generated === undefined
					? { kind: "placeholderColumn", table: to, column: c, hint: droppedHint(lost) }
					: statement(alter(to, [{ kind: "addColumn", column: c }]))
			)
		)
		const renamings = fieldOffers.flatMap((a) => a.offers)
		this.planned.push({
			kind: "relation",
			candidate: relation,
			qualified: inRelations(qualified),
			drops,
			pairs: paired
		})
		const shared = sameHeading(old, create)
			? "heading"
			: samePrimaryKey(old, create)
				? "primary key"
				: "field names"
		const differ =
			added.length + lost.length === 0
				? ""
				: `, and its fields differ (${fieldChanges(added, lost)}): the rename adds and drops them, and offers each added field that may be a dropped one renamed as a candidate of its own inside this one`
		const converted =
			retyped.length === 0
				? ""
				: `, and the type of ${retyped.map((c) => quoteIdent(c.column.name)).join(", ")} changes: the rename converts ${retyped.length === 1 ? "it" : "them"} in place ${conversionsBy(retyped.length, retyped.filter((c) => this.keepsValues(c.was, c.column)).length)}, unless a type's candidate rename marked there already makes the new type`
		/** The fields whose identity the rename gives up or takes in place (inPlace). */
		const reidentified = held.filter(
			(f) =>
				f.change.kind !== "kept" &&
				(identitySequence(f.was) !== undefined || identitySequence(f.column) !== undefined)
		)
		const identities =
			reidentified.length === 0
				? ""
				: `, and the identity of ${reidentified.map((f) => quoteIdent(f.column.name)).join(", ")} changes: the rename drops the old identity where there is one and adds the target's where it declares one, advanced past the stored maximum`
		const keyChange = samePrimaryKey(old, create) ? "" : `, and its primary key changes`
		const referenced =
			references.length === 0
				? ""
				: `; the foreign key${references.length === 1 ? "" : "s"} ${references.map((r) => `${printObjectName(r.table)}.${quoteIdent(r.name)}`).join(", ")} that reference${references.length === 1 ? "s" : ""} a key of ${printObjectName(from)} the rename drops ${references.length === 1 ? "is" : "are"} dropped first, then added again NOT VALID and validated by the statements drafted for ${references.length === 1 ? "it" : "them"}`
		return {
			kind: "relation rename",
			candidate: relation,
			note: `${printObjectName(to)} has the ${shared} of the removed ${printObjectName(from)}, which this migration drops${differ}${converted}${identities}${keyChange}${referenced}; choosing the rename also decides the statements marked as part of it in this folder's files${this.ambiguity(rivalCount, this.tableOffers(old))}`,
			alternative: [
				...partKinds.flatMap((kind) => carried[kind].before),
				...additions,
				...held.flatMap(({ was, column, change }): ReadonlyArray<SealedStep> => {
					const retype = this.typeCandidatesOf()
						.filter((x) => this.retypes(x, was, column))
						.map((x): PlainOffer => ({
							kind: "delete",
							candidate: x.candidate,
							note: `the statement below converts ${quoteIdent(column.name)} to ${printObjectName(x.candidate.added)}, which ${labelOf(x)} already makes its type`
						}))
					return inPlace(to, was, column, change, (c) =>
						this.conversionIn(relation, from, was, to, c)
					).map((step) => offered(retype, step))
				}),
				...partKinds.flatMap((kind) => carried[kind].after),
				...lost.map((c) => fieldLoss(from, to, c.name, carriersOf(renamings, c)))
			]
		}
	}

	/** The added relations that have the heading of a removed one. */
	tableOffers(removed: CreateTable): number {
		return this.input.target.manifest.objects.filter((o) => {
			const create =
				o.kind === "table" && !this.prev.has(o.ident) ? this.createTableOf(o) : undefined
			return create !== undefined && renamePair(removed, create)
		}).length
	}

	/** The note of a candidate that is one of several for its addition, or whose removed half is offered to several. */
	ambiguity(forAddition: number, forRemoval: number): string {
		return forAddition > 1 || forRemoval > 1
			? "; it is one of several candidates for the same names, so choose at most one rename for each added and each removed name"
			: ""
	}

	/** The foreign keys of the previous snapshot that reference the key `c` of `table` and still stand when a rename
	 * runs (standing). */
	referencesTo(table: ObjectName, c: TableConstraint): ReadonlyArray<PreviousPart> {
		if (c.kind !== "primaryKey" && c.kind !== "unique") {
			return []
		}
		const key = keyBefore(table, constraintColumns(c))
		return this.standing.flatMap((o): ReadonlyArray<PreviousPart> => {
			const v = installed(o)
			return v.kind === "foreignKey" && referencedBefore(v.constraint) === key
				? [{ kind: "constraint", table: v.table, name: v.name }]
				: []
		})
	}

	/** The drop of the previous part `part` on its table as `on` names it, in the alternative of the candidate that
	 * renames as `own` does, which every path drops once: under the offer of each candidate planned before it, whose
	 * alternative runs first, by what that alternative makes of the part (partFate): deleted where it dropped the part,
	 * the part's drop under its new names where it renamed it. The candidates that drop or rename a part, a relation's
	 * and a field's, are planned in the target's install order and offered in Structure in it (the constructor), so
	 * the order they are planned in is the order their alternatives run in. Two rival candidates, which take one
	 * removed name away or give one added name, are never chosen together (`grizzle check`), so neither offers in the
	 * other's alternative. */
	droppedOnce(own: Candidate, part: PreviousPart, on: ObjectName): SealedStep {
		return offered(
			this.planned.flatMap((x): ReadonlyArray<PlainOffer> =>
				rivals(x.candidate, own) ? [] : dropOffers(x, part)
			),
			statement(partDrop(part.kind, on, part.name))
		)
	}

	/** A removed column with the type of an added one, or with a type a type's candidate rename makes the added one's:
	 * the alternative renames the column, its keys (Pairing keys), and its identity sequence when the target names it
	 * otherwise. Everything else over the column, its other constraints and its indexes, is drafted under its target
	 * names whichever the reviewer chooses: the drafted statements build the new ones on the column, renamed or added,
	 * and drop the old ones by name, which a chosen rename carried along to the new column. So the reviewer's one edit
	 * is the replaced addition, and only what builds or drops a carried key and a revoke of a renamed sequence are
	 * marked. Under a type's rename, the column keeps its rows only where that rename renames its type too, so the
	 * field's candidate requires the type's: check refuses it chosen without it. */
	renameCandidateColumn<
		C extends FieldCandidate | NestedFieldCandidate,
		O extends RootRename | NestedRename
	>(
		holder: FieldHolder<C, O>,
		removed: ReadonlyArray<Pairing>,
		c: ColumnDef,
		additions: (r: ColumnDef) => number
	): ReadonlyArray<FieldOffer<O>> {
		const t = holder.table
		return removed.map(({ column: r, via, keys }): FieldOffer<O> => {
			/** The identity sequence, renamed too when the target names it otherwise. */
			const sequence =
				r.generated?.kind === "identity" &&
				c.generated?.kind === "identity" &&
				r.generated.sequence.name !== c.generated.sequence.name
					? { name: r.generated.sequence, to: c.generated.sequence.name }
					: undefined
			const qualified = inRelations(
				new Map(sequence === undefined ? [] : [[sequence.name.name, sequence.to]])
			)
			const requires: FieldRequires =
				via.kind === "same type"
					? { kind: "nothing" }
					: { kind: "type", candidate: via.candidate.candidate }
			const record = holder.candidate(r.name, c.name, requires)
			const candidate: PlannedField = {
				kind: "field",
				candidate: record,
				qualified,
				table: t,
				keys,
				drops: []
			}
			this.planned.push(candidate)
			const ends = endsOf(record)
			const under =
				via.kind === "same type"
					? ""
					: `, once ${labelOf(via.candidate)} makes its type ${printObjectName(via.candidate.candidate.added)}; choose it only with that candidate`
			return {
				added: c,
				offer: holder.offer(
					record,
					`${ends.added} has the type of the removed column ${ends.removed}, which ${removedBy(record)}${under}${this.ambiguity(removed.length, additions(r))}`,
					[
						...keys.map((k) =>
							statement({ kind: "renameConstraint", table: t, from: k.from, to: k.to })
						),
						...(sequence === undefined
							? []
							: [statement({ kind: "rename", object: "SEQUENCE", ...sequence })])
					]
				),
				removed: r,
				candidate
			}
		})
	}

	/** A removed column of another type than an added one, of the relation that held it in the previous manifest (its
	 * holder's: a kept table, or the removed relation of the rename it is nested in): the alternative renames the column
	 * and its keys, drops what PostgreSQL refuses to convert it under (conversionDrops), and converts it in place to the
	 * added column's type by its conversion (conversionIn). Everything else over the column is drafted under its target
	 * names whichever the reviewer chooses, as for a rename of one type. */
	retypeCandidateColumn<
		C extends FieldCandidate | NestedFieldCandidate,
		O extends RootRename | NestedRename
	>(
		holder: FieldHolder<C, O>,
		removed: ReadonlyArray<Retyping>,
		c: ColumnDef,
		conversions: (r: ColumnDef) => number
	): ReadonlyArray<FieldOffer<O>> {
		const { table: t, was } = holder
		return removed.map(({ column: r, keys }): FieldOffer<O> => {
			const record = holder.candidate(r.name, c.name, { kind: "nothing" })
			const drops = this.conversionDrops(record, r.name)
			const candidate: PlannedField = {
				kind: "field",
				candidate: record,
				qualified: inRelations(new Map()),
				drops,
				table: t,
				keys
			}
			this.planned.push(candidate)
			const ends = endsOf(record)
			return {
				added: c,
				offer: holder.offer(
					record,
					`${ends.added} may be the removed column ${ends.removed}, which ${removedBy(record)}, renamed with its type changed; choosing the rename converts it in place ${conversionsBy(1, this.keepsValues(r, c) ? 1 : 0)}${this.ambiguity(removed.length, conversions(r))}`,
					[
						...drops.map((p) => this.droppedOnce(record, p, p.table)),
						...keys.map((k) =>
							statement({ kind: "renameConstraint", table: t, from: k.from, to: k.to })
						),
						...this.conversionIn(record, was, r, t, c)
					]
				),
				removed: r,
				candidate
			}
		})
	}

	/** What a field candidate's conversion in place of its removed column `column` drops first, as a conversion in place
	 * of a column the target keeps does (dropReplaced), in the drop order: what PostgreSQL refuses to convert the column
	 * under, each foreign key over it or referencing a key over it, each CHECK over it, each law trigger whose UPDATE
	 * OF names it and each stored tag computed from it, with the keys over the tag and the foreign keys referencing them,
	 * of those that stand when the rename runs (standing): a conversion the target makes took the rest away before every
	 * candidate. A key, an index or a statistics object over it is converted with it. A field's rename
	 * nested in a relation's drops none: the relation's alternative brought across or dropped every part over it. */
	conversionDrops(
		candidate: FieldCandidate | NestedFieldCandidate,
		column: string
	): ReadonlyArray<PreviousPart> {
		switch (candidate.kind) {
			case "field":
				return this.clearedFor(candidate.relation, column)
			case "nested field":
				return []
		}
	}

	/** What PostgreSQL refuses to convert the column `column` of `table` under, of what stands when the renames run, in
	 * the drop order (conversionDrops): what is built over the column (objects.ts builtOver) or references a key over it,
	 * a stored tag computed from it among them, and what is built over such a tag or references a key over it, which the
	 * tag's drop takes along (clearedOf). */
	clearedFor(table: ObjectName, column: string): ReadonlyArray<PreviousPart> {
		const over = (v: Installed, columns: ReadonlyArray<string>): boolean => {
			const built = builtOver(v, (c) => keyOrCheckDefinition(c, this.prev))
			return (
				(built !== undefined &&
					nameKey(built.table) === nameKey(table) &&
					built.columns.some((c) => columns.includes(c))) ||
				(v.kind === "foreignKey" &&
					nameKey(v.constraint.references) === nameKey(table) &&
					v.constraint.referencedColumns.some((k) => columns.includes(k.column)))
			)
		}
		const tags = this.standing.flatMap((o) => {
			const v = installed(o)
			return v.kind === "storedTag" && over(v, [column]) ? [v.column] : []
		})
		return this.standing
			.flatMap((o) => {
				const v = installed(o)
				const cleared = over(v, [column])
					? clearedOf(v, "column")
					: over(v, tags)
						? clearedOf(v, "tag")
						: undefined
				return cleared === undefined ? [] : [cleared]
			})
			.toSorted(byDropOrder)
			.map((c) => c.part)
	}

	/** The keys a rename of the field `from` of the kept table to `to` carries across (pairParts): each candidate key over
	 * `from` the target no longer declares, every other column of which the migration carries (ColumnFates), paired with
	 * a candidate key the target adds of its definition with `to` in place of `from`. PostgreSQL binds a foreign key to a
	 * key over its referenced columns, so the target's key built beside the renamed one would bind the target's new
	 * references to the removed key, which Publish then cannot drop (2BP01). The rename renames the key instead, which
	 * renames its index with it. A primary key is named by its relation (identity.primaryKey), so it keeps its name over
	 * the renamed column and is replaced there in one ALTER TABLE (ownConstraint), which no reference binds beside.
	 * Inside a relation's rename there is none (noKeys): the relation's alternative drops each key it does not bring
	 * across. */
	carriedKeys(kept: KeptTable, from: string, to: string): ReadonlyArray<CarriedKey> {
		const t = kept.create.table
		const before = this.partsOf(t, this.prev).constraint
		const after = this.partsOf(t, this.next).constraint
		const uniques = (
			parts: ReadonlyMap<string, PartOf<"constraint">>,
			other: ReadonlyMap<string, PartOf<"constraint">>,
			over: (columns: ReadonlyArray<string>) => boolean
		): ReadonlyMap<string, PartOf<"constraint">> =>
			new Map(
				[...parts].filter(
					([name, p]) =>
						p.constraint.kind === "unique" &&
						!other.has(name) &&
						over(constraintColumns(p.constraint))
				)
			)
		return pairParts(
			uniques(before, after, (columns) => columns.includes(from)),
			uniques(after, before, () => true),
			(was) =>
				carries(
					"constraint",
					constraintColumns(was.constraint).filter((c) => c !== from),
					(c) => columnFate(kept, c)
				),
			(was, as) =>
				was.constraint.kind === "unique" &&
				same(
					{
						...was.constraint,
						name: as.name,
						columns: was.constraint.columns.map((x) =>
							x.column === from ? { ...x, column: to } : x
						)
					},
					as.constraint
				)
		).flatMap((p) => (p.kind === "brought" ? [{ from: p.was.name, to: p.pair.name }] : []))
	}

	/** The parts of a table among `objects` (objectParts), of each kind by name. */
	partsOf(t: ObjectName, objects: ReadonlyMap<string, ManifestObject>): Parts {
		return relationParts(t, objects.values(), objects)
	}

	storedTag(
		v: Installed & { readonly kind: "storedTag" },
		before: ManifestObject | undefined
	): void {
		const { object: o, table: t, column } = v
		if (before !== undefined) {
			if (same(before.ddl, o.ddl)) {
				return
			}
			this.sql("structure", [alter(t, [{ kind: "dropColumn", column }])])
		}
		this.sql("structure", o.ddl)
	}

	/** A primary key, candidate key or CHECK of a table, by what it is to this migration (Arrival).
	 *
	 * A key over a column converted in place, which dropReplaced dropped before the conversion, is added again in the
	 * same Structure transaction right after it, under the conversion's lock, so the key holds at every commit: built
	 * concurrently, it would hold no row written between Structure and Validate, a law that held before and after
	 * broken in between. A CHECK added NOT VALID holds every new row already.
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
			this.sql("structure", [alter(t, [{ kind: "addConstraint", constraint: c, notValid: false }])])
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
			this.sql("structure", [
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
		const index = replace ? swapName(c.name) : c.name
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
	 * rows, by identity: each removed key, and each the target replaces under its name (ownConstraint), that under some
	 * decision of its table's candidate renames stands over the columns of a key the target declares there (keyImages),
	 * such as a candidate key that becomes the primary key, a key over a removed field that a chosen candidate renames
	 * to the field of the target's primary key, or a primary key moved to other fields while a candidate key takes its
	 * old ones. A key a conversion takes away (Taken replaced) is dropped before the conversion, and is none of them. */
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
				[...this.partsOf(t, this.next).constraint.values()].flatMap((k) =>
					k.constraint.kind === "primaryKey" || k.constraint.kind === "unique"
						? [keyAfter(t, constraintColumns(k.constraint))]
						: []
				)
			)
			const beside = new Set(this.keyImages(kept, c).filter((k) => targetKeys.has(k)))
			if (beside.size > 0) {
				out.set(o.ident, { before: keyBefore(t, constraintColumns(c)), beside })
			}
		}
		return out
	}

	/** What the key `key` of the previous snapshot, on the kept table `kept`, may stand over in the target's names once
	 * the reviewer decides the table's candidate renames (fieldPairs): under each decision that leaves every column of it
	 * a column of the target, the column the target holds under its name, or the added field a chosen candidate renames
	 * a removed one to, no two columns to one field, the key over those columns; but for the decision of a candidate that
	 * carries the key itself across (the pairing's keys, carriedKeys), which then is the target's key, standing beside
	 * none. A key over a column every decision drops stands over none. */
	keyImages(kept: KeptTable, key: TableConstraint): ReadonlyArray<KeyAfter> {
		const t = kept.create.table
		const create = kept.create
		const pairs = this.keptPairs(kept)
		const tags = this.partsOf(t, this.next).column
		const held = (column: string) =>
			create.columns.some((c) => c.name === column) || tags.has(column)
		/** The names a column of the key may have in the target, each with the field's rename that gives it, none for a
		 * column the target holds; and the key's columns as each decision names them so far, with those renames. */
		type Rename = { readonly from: string; readonly to: string }
		type Named = { readonly name: string; readonly renames: ReadonlyArray<Rename> }
		type Image = {
			readonly columns: ReadonlyArray<string>
			readonly renames: ReadonlyArray<Rename>
		}
		const namesOf = (column: string): ReadonlyArray<Named> =>
			held(column)
				? [{ name: column, renames: [] }]
				: renamedTo(pairs, column).map((to) => ({ name: to, renames: [{ from: column, to }] }))
		const images = constraintColumns(key).reduce<ReadonlyArray<Image>>(
			(so, column) =>
				so.flatMap((image) =>
					namesOf(column).flatMap((n): ReadonlyArray<Image> =>
						image.columns.includes(n.name)
							? []
							: [{ columns: [...image.columns, n.name], renames: [...image.renames, ...n.renames] }]
					)
				),
			[{ columns: [], renames: [] }]
		)
		return images.flatMap((image) => {
			const [only, ...more] = image.renames
			const carried =
				only !== undefined &&
				more.length === 0 &&
				keysCarried(pairs, only.from, only.to).some((k) => k.from === key.name)
			return carried ? [] : [keyAfter(t, image.columns)]
		})
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
	 * columns are added (foreignKey), whichever way the reviewer decides the candidate renames: each removed foreign key
	 * that references it is dropped before it (remove), and each one the target keeps unchanged as well (rebind). */
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

	/** A table that holds no row takes it validated at once, as `addTables` installs it. */
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
		const afterKey = this.attached.has(referencedAfter(c)) || this.replaces(referencedAfter(c))
		if (!this.mayHoldRows(t) && !afterKey) {
			this.sql("structure", [alter(t, [{ kind: "addConstraint", constraint: c, notValid: false }])])
			return
		}
		const slot: PlainSlot = afterKey ? "validate" : "structure"
		this.sql(slot, [alter(t, [{ kind: "addConstraint", constraint: c, notValid: true }])])
		this.sql("validate", [alter(t, [{ kind: "validateConstraint", name: c.name }])])
	}

	/** A materialized view, created WITH NO DATA when it follows no previous view (Arrival): new, or dropped at the start
	 * of Structure (viewDropsOf). One that stands has the target's definition, since a changed one is dropped. */
	view(
		v: Installed & { readonly kind: "materializedView" },
		before: ManifestObject | undefined
	): void {
		if (before === undefined) {
			this.sql("structure", v.object.ddl)
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
			this.sql(o.phase === "structure" ? "structure" : "indexes", o.ddl)
			return
		}
		if (before === undefined) {
			this.buildConcurrently(create)
			return
		}
		/** A changed index on a relation that may hold rows: built under a temporary name, then swapped in. */
		const next = swapName(create.name)
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

	/** Residual laws, by law, each law's units by unit: a unit is one function and the one trigger that executes it, for
	 * one table and event (deploy/snapshot/objects.ts lawUnitsOf). A law whose units are unchanged keeps them; only a
	 * trigger a conversion or an enum rebuild took away is created again after it, in Structure. A law whose units change
	 * is validated again in its own Validate transaction, under the lock that excludes every writer: its standing
	 * triggers dropped, each changed or new unit's function created or replaced (CREATE OR REPLACE FUNCTION), every unit's
	 * trigger created, then its full violation query, so no new body runs before the existing rows are validated and a
	 * refusal leaves the old law in force. A change of the roles a violation reports its keys to (`witnessShown`), or of
	 * a relation's mutability alone, which adds or drops the units of its UPDATE and leaves the others standing, is no
	 * change of what the law obliges: its units change in Publish, without revalidation. A law the target no longer has
	 * drops its triggers in Publish; every removed unit's function goes with the removed objects, after its trigger. */
	laws(): void {
		const before = lawUnitsOf(this.previous)
		const after = lawUnitsOf(this.targets)
		const records = new Map<LawId, ResidualLaw>(
			this.input.installation.laws.residuals.map((r) => [r.lawId, r] as const)
		)
		for (const [law, now] of after) {
			const residual = records.get(law)
			if (residual === undefined) {
				refuseLaw(law, "a residual law record")
			}
			this.lawChange(residual, before.get(law), now)
		}
		for (const [law, was] of before) {
			if (after.has(law)) {
				continue
			}
			for (const u of was) {
				if (u.trigger.entry.fate.kind === "removed") {
					this.push("publish.drop", dropTrigger(u.trigger.view))
				}
			}
		}
	}

	/** What one law the target holds drafts (laws), `was` its units in the previous installation, by their functions:
	 * nothing but the triggers a conversion or a rebuild took away when no unit changes; its units' changes in Publish
	 * when only its witness or a relation's mutability changes; otherwise its full replacement and validation in its own
	 * Validate transaction. */
	lawChange(
		residual: ResidualLaw,
		was: NonEmptyReadonlyArray<LawUnit<Previous>> | undefined,
		now: NonEmptyReadonlyArray<LawUnit<Target>>
	): void {
		const law = residual.lawId
		const previous: ReadonlyArray<LawUnit<Previous>> = was ?? []
		const prior = new Map(previous.map((u) => [u.fn.ident, u] as const))
		const kept = new Set(now.map((u) => u.fn.ident))
		const removed = previous.filter((u) => !kept.has(u.fn.ident))
		const changedFunctions = now.filter((u) => {
			const b = prior.get(u.fn.ident)
			return b === undefined || !same(b.fn.ddl, u.fn.ddl)
		})
		const changedTriggers = now.filter((u) => {
			const b = prior.get(u.fn.ident)
			return (
				b === undefined ||
				b.trigger.view.object.ident !== u.trigger.view.object.ident ||
				!same(b.trigger.view.object.ddl, u.trigger.view.object.ddl)
			)
		})
		/** A previous unit's trigger that still stands: one no conversion or rebuild took away. */
		const standing = (u: LawUnit<Previous>): boolean =>
			u.trigger.entry.fate.kind !== "replaced" && u.trigger.entry.fate.kind !== "rebuild"
		/** A target unit's trigger a conversion or a rebuild took away, created again. */
		const takenAway = (u: LawUnit<Target>): boolean =>
			u.trigger.entry.arrival.kind === "replaced" || u.trigger.entry.arrival.kind === "rebuild"
		/** Each statement of `ddl`, in `slot`. */
		const each = (
			slot: "structure" | "publish.triggers",
			ddl: ReadonlyArray<SqlStatement>
		): void => {
			for (const d of ddl) {
				this.sql(slot, [d])
			}
		}
		if (removed.length === 0 && changedFunctions.length === 0 && changedTriggers.length === 0) {
			for (const u of now.filter(takenAway)) {
				each("structure", u.trigger.view.object.ddl)
			}
			return
		}
		if (was !== undefined && (this.witnessOnly(law) || this.mutabilityOnly(law))) {
			const changed = new Set(changedTriggers.map((u) => u.fn.ident))
			for (const u of [...removed, ...was.filter((x) => changed.has(x.fn.ident))].filter(
				standing
			)) {
				this.push("publish.triggers", dropTrigger(u.trigger.view))
			}
			for (const u of changedFunctions) {
				each("publish.triggers", u.fn.ddl)
			}
			for (const u of changedTriggers) {
				each("publish.triggers", u.trigger.view.object.ddl)
			}
			for (const u of now.filter((x) => takenAway(x) && !changed.has(x.fn.ident))) {
				each("structure", u.trigger.view.object.ddl)
			}
			return
		}
		/** The tables locked, each once in name order: every table a unit's trigger is on, its anchor's among them, since
		 * every family's anchor participates, and every table a standing trigger is on that the target keeps. */
		const [first, ...more] = sortNonEmpty(
			[
				...mapNonEmpty(now, (u) => u.trigger.view.create.table),
				...previous
					.map((u) => u.trigger.view.create.table)
					.filter((t) => this.next.has(tableIdent(t)))
			],
			mapInput(compareStrings, nameKey)
		)
		const tables: [ObjectName, ...Array<ObjectName>] = [first]
		let last = nameKey(first)
		for (const t of more) {
			const key = nameKey(t)
			if (key !== last) {
				tables.push(t)
				last = key
			}
		}
		this.pushLaw(
			law,
			statement({ kind: "lockTable", tables, mode: "SHARE ROW EXCLUSIVE", wait: "wait" })
		)
		for (const u of previous.filter(standing)) {
			this.pushLaw(law, dropTrigger(u.trigger.view))
		}
		for (const u of changedFunctions) {
			for (const d of u.fn.ddl) {
				this.pushLaw(law, statement(d))
			}
		}
		for (const u of now) {
			for (const d of u.trigger.view.object.ddl) {
				this.pushLaw(law, statement(d))
			}
		}
		this.pushLaw(law, this.violation(residual))
	}

	/** Whether a law's change is a change of its units' functions alone: its residual record is unchanged, so only the
	 * roles its functions report witness keys to changed. */
	witnessOnly(law: LawId): boolean {
		return (
			residualRecord(this.input.previous, law).digest ===
			residualRecord(this.input.target, law).digest
		)
	}

	/** Whether a law's change is caused by declaring or removing `mutable` alone: the record without its UPDATE units is
	 * unchanged, and a participant's mutability flipped, which adds or drops only its UPDATE units. */
	mutabilityOnly(law: LawId): boolean {
		const a = residualRecord(this.input.previous, law)
		const b = residualRecord(this.input.target, law)
		if (a.withoutUpdates !== b.withoutUpdates) {
			return false
		}
		return b.participants.some((p) => {
			const x = this.input.previous.theory.relations[p]
			const y = this.input.target.theory.relations[p]
			return x !== undefined && y !== undefined && x.mutable !== y.mutable
		})
	}

	/** The full violation query of a residual law, lowered by the oracle baseline over every row. */
	violation(r: ResidualLaw): Draft {
		const law = r.lawId
		/** A violation probe reads stored values, which already satisfy their refinements, so a text refinement no stored
		 * column carries, such as a contract's base pattern, is typed as text (`ConservativeSubject`). */
		const lowered = lowerConservative(
			{ dag: this.input.installation.laws.theory.dag, root: r.violation },
			{
				names: this.input.installation.names,
				params: [],
				subject: { kind: "violationProbe" },
				meter: new BudgetMeter(compileBudgets)
			}
		)
		if (!lowered.ok) {
			throw new Refusal(lowered.error)
		}
		const [root, ...rest] = lowered.value.roots
		const main = root.statement
		if (
			rest.length > 0 ||
			root.attachments.length > 0 ||
			main.role.kind !== "main" ||
			main.params.length > 0
		) {
			return refuseLaw(law, "a violation query of one parameterless statement")
		}
		return {
			kind: "violation",
			law,
			query: main.ast
		}
	}

	/** An object the target no longer has and no step takes away first (Fate removed), dropped in place: in
	 * publish.removed (draftRemovals) at its kind's rank, once nothing of the target reads it; a constraint of a table
	 * that stays, and a capacity's partial unique index, in publish.drop, before; and what belongs to a dropped table
	 * with no statement of its own.
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
	 * A stored relation's drop loses its rows: a loss the reviewer decides, which a candidate rename of it
	 * carries instead (markRenameCandidates).
	 *
	 * A removed table's own constraints go with it; a reference out of it is dropped first, with every other
	 * removed reference, so no drop of a key it references waits on it: in Validate, before the key, when the
	 * key it references is a removed one the target's replaces (replacedKey), which the removal order, every
	 * foreign key before the keys, drafts first.
	 *
	 * A capacity's partial unique index enforces a law: it goes with the law's other native objects.
	 *
	 * laws() drops every removed law's triggers.
	 *
	 * A table's isolation trigger goes with its table, the only way it is ever removed. */
	remove(o: ManifestObject, order: number): void {
		const t = objectTable(o)
		const tableGone =
			t !== undefined && !this.next.has(tableIdent(t)) && !this.next.has(viewIdent(t))
		const v = installed(o)
		const drop = (kind: Dropped, d: Action | LossDecision): void => {
			this.removal(dropOrder[kind], order, d)
		}
		switch (v.kind) {
			case "schema":
			case "ledger":
				throw new Refusal(
					unsupported(
						SourceLoc(`object ${o.ident}`, []),
						"removing the installed schema or its ledger"
					)
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
			case "enum":
			case "domain":
			case "materializedView":
				drop(v.kind, statement(dropObject(v)))
				return
			case "table":
				drop(v.kind, {
					kind: "loss",
					loses: { kind: "relation", relation: v.create.table },
					statement: dropObject(v),
					carriers: []
				})
				return
			case "lawFunction":
			case "refusalFunction":
			case "advanceFunction":
			case "isolationFunction":
			case "snapshotGuard":
				drop(
					v.kind,
					statement({ kind: "dropFunction", name: functionNameOf(v.create), ifExists: false })
				)
				return
			case "storedTag":
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
				if (lawIndex(o)) {
					this.sql("publish.drop", [
						{
							kind: "dropIndex",
							name,
							concurrently: false,
							ifExists: false
						}
					])
					return
				}
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
			case "lawTrigger":
				return
			case "isolationTrigger":
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
	 * granted, so grants two objects share survive. Every revoke comes before every grant: a login a chosen candidate
	 * renames revokes under its new name what its old name held, which must not take back what its new name is granted.
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
	 * so the revoke leaves it out. A relation, sequence or type a candidate rename renames is revoked in a statement of
	 * its own, which markRenameCandidates marks with the same revoke under the new name. */
	revokes(g: Grant): void {
		const r = revokeOf(g)
		const renamed = (n: ObjectName) =>
			n.schema === this.schema &&
			this.planned.some(
				(x) =>
					x.qualified.names.has(n.name) || (x.kind === "relation" && dropsSequence(x.pairs, n.name))
			)
		const split = (
			names: ReadonlyArray<ObjectName>,
			on: (names: NonEmptyReadonlyArray<ObjectName>) => Revoke
		) => {
			const kept = names.filter((n) => !renamed(n))
			if (isNonEmpty(kept)) {
				this.sql("publish.grants", [on(kept)])
			}
			for (const n of names) {
				if (renamed(n)) {
					this.sql("publish.grants", [on([n])])
				}
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
			case "TYPE":
				split(r.on.names, (names) => ({ ...r, on: { kind: "TYPE", names } }))
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
				this.sql("publish.grants", [r])
				return
		}
	}

	/** The statements a chosen candidate rename changes, each offered what it becomes, so apply refuses its file until
	 * the reviewer decides, in every file of the draft. A candidate's own addition keeps its rename offers first. A statement that runs
	 * before the candidate's own rename (orderedSteps: by slot, then as drafted), such as a rebuilt enum's conversion of
	 * a column of the renamed relation, names what it renames by the names that still stand then, so the candidate
	 * rewrites no such statement. */
	markRenameCandidates(): void {
		if (this.planned.length === 0) {
			return
		}
		/** Each step with the candidates whose own rename runs at it or before it, read off the steps in run order. */
		let ran: ReadonlySet<Candidate> = new Set()
		const byPosition = mapInput(compareNumbers, (x: { readonly i: number }) => x.i)
		const runOrder = this.steps
			.map((step, i) => ({ step, i }))
			.toSorted(
				mapInput(compareNumbers, (x: { readonly step: Step }) => slots.indexOf(x.step.slot))
			)
		const standing = runOrder
			.map(({ step, i }) => {
				const own = draftCandidates(step.draft)
				if (own.length > 0) {
					ran = new Set([...ran, ...own])
				}
				return { step, i, renamed: ran }
			})
			.toSorted(byPosition)
		const marked = standing.map(({ step, renamed }): Step => {
			if (step.draft.kind === "loss") {
				return { ...step, draft: this.carried(step.draft) }
			}
			const own = step.draft.kind === "choice" ? step.draft.offers : []
			const d = step.draft.kind === "choice" ? step.draft.keep : step.draft
			if (d.kind !== "statement") {
				return step
			}
			const offers = [...own, ...this.planned.flatMap((x) => this.offersOn(d.statement, x))]
			const kept = offers.filter((o) => o.kind !== "rewrite" || renamed.has(o.candidate))
			return kept.length === own.length ? step : { ...step, draft: offered(kept, d) }
		})
		for (const [i, step] of marked.entries()) {
			this.steps[i] = step
		}
	}

	/** A loss with every candidate that carries what it loses: one it already names, a field's rename of the dropped
	 * field, or a relation's rename of the dropped relation, whose choice deletes the loss's DROP TABLE (underRename). */
	carried(loss: LossDecision): LossDecision {
		const loses = loss.loses
		const carrier = (x: Planned): boolean => {
			switch (loses.kind) {
				case "relation":
					return x.kind === "relation" && nameKey(x.candidate.removed) === nameKey(loses.relation)
				case "field":
				case "schema":
					return false
			}
		}
		const renaming = this.planned.flatMap((x): ReadonlyArray<Candidate> =>
			carrier(x) && !loss.carriers.includes(x.candidate) ? [x.candidate] : []
		)
		return renaming.length === 0 ? loss : { ...loss, carriers: [...loss.carriers, ...renaming] }
	}

	/** The offer of candidate `x` on a drafted statement, by what the statement becomes when the reviewer chooses it
	 * (Becomes), with why: none when it stays as it is. A field's rename that carries keys deletes or rewrites what
	 * builds the target's key or drops the removed one; any other field's or type's rename only renames names, so the
	 * statement runs under the new ones; a relation's rename also deletes what it already did.
	 *
	 * The removed type's drop, which the rename leaves nothing to find for. */
	offersOn(s: SqlStatement, x: Planned): ReadonlyArray<PlainOffer> {
		const label = labelOf(x)
		const names = `the statement below names what ${label} renames`
		switch (x.kind) {
			case "field": {
				const keyed = this.underKeys(s, x)
				if (keyed.becomes.kind === "same") {
					return offersOf(x, this.underNames(s, x), names, names)
				}
				const key = keyed.takings.includes("key")
				const clears = keyed.takings.includes("cleared")
				const why =
					key && clears
						? `the statement below builds or drops a key that ${label} renames, or drops what it drops before it converts the column`
						: key
							? `the statement below builds or drops a key that ${label} renames`
							: `the statement below drops what ${label} drops before it converts the column`
				return offersOf(x, keyed.becomes, why, why)
			}
			case "type": {
				const from = x.candidate.removed
				if (
					s.kind === "drop" &&
					(s.object === "TYPE" || s.object === "DOMAIN") &&
					nameKey(s.name) === nameKey(from)
				) {
					return offersOf(
						x,
						deleted,
						names,
						`the statement below drops ${printObjectName(from)}, which ${label} renames`
					)
				}
				return offersOf(x, this.underNames(s, x), names, names)
			}
			case "relation": {
				const from = x.candidate.removed
				const to = x.candidate.added
				const onFrom = (t: ObjectName) => nameKey(t) === nameKey(from)
				/** A drop of another relation's foreign key the alternative already dropped, before a key it drops. */
				const deletion =
					s.kind === "drop" && s.object === "TABLE" && onFrom(s.name)
						? `the statement below drops ${printObjectName(from)}, which ${label} renames`
						: s.kind === "dropTrigger"
							? `the statement below drops a law trigger of ${printObjectName(from)} that ${label} drops before its fields change`
							: s.kind === "alterTable" && onFrom(s.table)
								? `the statement below alters ${printObjectName(from)}, the removed half of ${label}`
								: s.kind === "alterTable" && nameKey(s.table) !== nameKey(to)
									? `the statement below drops a foreign key that ${label} drops before a key of ${printObjectName(from)} it drops`
									: `the statement below adds to ${printObjectName(to)} what ${label} brings across`
				return offersOf(x, this.underRename(s, x), names, deletion)
			}
			case "login": {
				const { removed: from, added: to } = x.candidate
				if (s.kind === "drop" && s.object === "ROLE" && s.name === from) {
					return offersOf(
						x,
						deleted,
						names,
						`the statement below drops the login ${quoteIdent(from)}, which ${label} renames`
					)
				}
				const renamed = renameRole(s, from, to)
				return offersOf(
					x,
					renamed === s ? unchanged : { kind: "rewritten", statements: [renamed] },
					names,
					names
				)
			}
		}
	}

	/** What a statement becomes when the reviewer chooses `x`: deleted, when it drops the removed relation, which the
	 * alternative renamed, creates on the added relation a part the alternative brought across or the isolation trigger
	 * the rename carries, or drops on the removed relation a constraint the alternative renamed or dropped or a law
	 * trigger it dropped (Pairs); the statement under the new names, when it names what the alternative renamed; the
	 * same otherwise.
	 *
	 * A revoke of a sequence the alternative dropped with its column. */
	underRename(s: SqlStatement, x: Planned & { readonly kind: "relation" }): Becomes {
		const { removed: from, added: to } = x.candidate
		const renamed = (original: SqlStatement): SqlStatement =>
			renameStatement(original, this.schema, x.qualified)
		if (s.kind === "drop" && s.object === "TABLE" && nameKey(s.name) === nameKey(from)) {
			return deleted
		}
		if (s.kind === "createGuardTrigger" && nameKey(s.table) === nameKey(to)) {
			return deleted
		}
		if (s.kind === "alterTable") {
			const onTo = nameKey(s.table) === nameKey(to)
			const onFrom = nameKey(s.table) === nameKey(from)
			const taken = (a: AlterTable["actions"][number]): boolean => {
				const added = onTo ? addedPart(a) : undefined
				return (
					(added !== undefined && brings(x.pairs, added.kind, added.name)) ||
					(onFrom &&
						a.kind === "dropConstraint" &&
						x.pairs.constraint.some((p) => p.was.name === a.name)) ||
					(a.kind === "dropConstraint" && dropsPart(x, "constraint", s.table, a.name)) ||
					(a.kind === "dropColumn" && dropsPart(x, "column", s.table, a.column))
				)
			}
			const rest = s.actions.filter((a) => !taken(a))
			if (rest.length < s.actions.length) {
				return withActions(s, rest, renamed)
			}
		}
		if (
			s.kind === "createIndex" &&
			nameKey(s.table) === nameKey(to) &&
			brings(x.pairs, "index", s.name)
		) {
			return deleted
		}
		if (
			s.kind === "createStatistics" &&
			nameKey(s.table) === nameKey(to) &&
			s.name.schema === to.schema &&
			brings(x.pairs, "statistics", s.name.name)
		) {
			return deleted
		}
		if (
			s.kind === "revoke" &&
			s.on.kind === "SEQUENCE" &&
			s.on.names.every((n) => n.schema === from.schema && dropsSequence(x.pairs, n.name))
		) {
			return deleted
		}
		if (s.kind === "dropTrigger" && dropsPart(x, "lawTrigger", s.table, s.name)) {
			return deleted
		}
		return this.underNames(s, x)
	}

	/** What a statement becomes when the reviewer chooses the field's rename `x`, with why (Taking): without what builds
	 * the target's key over the added field, its index included, or drops the removed key, which the rename renamed
	 * (`key`); without what drops what the rename drops before it converts the column (`cleared`); the same when it does
	 * neither.
	 *
	 * The guard that drops an index of the target key's name before building it, which now names the renamed key. */
	underKeys(
		s: SqlStatement,
		x: PlannedField
	): { readonly becomes: Becomes; readonly takings: ReadonlyArray<Taking> } {
		const built = new Set(x.keys.map((k) => k.to))
		const dropped = new Set(x.keys.map((k) => k.from))
		const onT = (n: ObjectName): boolean => nameKey(n) === nameKey(x.table)
		const untouched = { becomes: unchanged, takings: [] }
		if (s.kind === "alterTable") {
			const own = onT(s.table)
			const taking = (a: AlterTable["actions"][number]): ReadonlyArray<Taking> =>
				(own && a.kind === "addConstraint" && built.has(a.constraint.name)) ||
				(own && a.kind === "addConstraintUsingIndex" && built.has(a.name)) ||
				(own && a.kind === "dropConstraint" && dropped.has(a.name))
					? ["key"]
					: (a.kind === "dropConstraint" && dropsPart(x, "constraint", s.table, a.name)) ||
						  (a.kind === "dropColumn" && dropsPart(x, "column", s.table, a.column))
						? ["cleared"]
						: []
			const takings = s.actions.flatMap(taking)
			return takings.length === 0
				? untouched
				: {
						becomes: withActions(
							s,
							s.actions.filter((a) => taking(a).length === 0),
							(kept) => kept
						),
						takings
					}
		}
		if (s.kind === "createIndex" && onT(s.table) && built.has(s.name)) {
			return { becomes: deleted, takings: ["key"] }
		}
		if (s.kind === "dropIndex" && s.name.schema === x.table.schema && built.has(s.name.name)) {
			return { becomes: deleted, takings: ["key"] }
		}
		if (s.kind === "dropTrigger" && dropsPart(x, "lawTrigger", s.table, s.name)) {
			return { becomes: deleted, takings: ["cleared"] }
		}
		return untouched
	}

	/** A statement under the names candidate `x` renames, or the same when it names none of them. */
	underNames(s: SqlStatement, x: Planned): Becomes {
		const r = renameStatement(s, this.schema, x.qualified)
		return r === s ? unchanged : { kind: "rewritten", statements: [r] }
	}

	/** The final COMMENT step: the comment of every object of the target this migration creates or renames, or whose
	 * comment the previous snapshot does not hold as the target does (physical/install/comments.ts). */
	comments(): void {
		const touched = touchedTargets(this.steps.flatMap((s) => draftStatements(s.draft)))
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

/** Every statement a draft may run: an action's, every offer's alternative of a choice beside the action it keeps, a
 * confirm's, a loss's. */
const draftStatements = (d: Draft | RelationStep): ReadonlyArray<SqlStatement> => {
	switch (d.kind) {
		case "statement":
		case "loss":
			return [d.statement]
		case "confirm":
			return d.keep
		case "choice":
			return [...draftStatements(d.keep), ...d.offers.flatMap((o: Offer) => offerStatements(o))]
		case "placeholderColumn":
			return [
				{ kind: "alterTable", table: d.table, actions: [{ kind: "addColumn", column: d.column }] }
			]
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return []
	}
}

const offerStatements = (o: Offer): ReadonlyArray<SqlStatement> => {
	switch (o.kind) {
		case "rename":
		case "relation rename":
		case "nested rename":
			return [headOf(o.candidate), ...o.alternative.flatMap((a) => draftStatements(a))]
		case "rewrite":
			return o.statements
		case "delete":
		case "convert":
			return []
	}
}

/** How a closed relation's roster changes: unchanged; handles renamed in place, as many handles and each that differs
 * one the other roster lacks (renamedHandles); handles added, every existing one keeping its order, so each new label is
 * placed before the next existing one; or rebuilt, handles removed or reordered, which PostgreSQL cannot do in place,
 * with the rebuild's plan or its refusal (planRebuild). */
type RosterChange =
	| { readonly kind: "unchanged" }
	| { readonly kind: "renamed"; readonly handles: NonEmptyReadonlyArray<readonly [string, string]> }
	| { readonly kind: "added" }
	| { readonly kind: "rebuilt"; readonly rebuild: Rebuild }

/** How a roster changes, read from the two rosters alone: a rebuild is planned for `rebuilt` (rosterChange). */
const rosterOf = (
	old: ReadonlyArray<string>,
	next: ReadonlyArray<string>
): Exclude<RosterChange, { readonly kind: "rebuilt" }> | { readonly kind: "rebuilt" } => {
	if (same(old, next)) {
		return { kind: "unchanged" }
	}
	const renamed = renamedHandles(old, next)
	if (isNonEmpty(renamed)) {
		return { kind: "renamed", handles: renamed }
	}
	let kept = 0
	for (const label of next) {
		if (kept < old.length && label === old[kept]) {
			kept++
		}
	}
	return kept === old.length ? { kind: "added" } : { kind: "rebuilt" }
}

const rosterChange = (
	old: ReadonlyArray<string>,
	next: ReadonlyArray<string>,
	rebuild: () => Rebuild
): RosterChange => {
	const r = rosterOf(old, next)
	return r.kind === "rebuilt" ? { kind: "rebuilt", rebuild: rebuild() } : r
}

/** How an enum the target installs changes from `before`, its previous object: its previous definition and its roster's
 * change, a rebuild planned or refused by `rebuild`. */
interface EnumChange {
	readonly old: CreateEnum
	readonly roster: RosterChange
}

const enumChange = (
	before: ManifestObject,
	create: CreateEnum,
	rebuild: (old: CreateEnum) => Rebuild
): EnumChange => {
	const was = installed(before)
	if (was.kind !== "enum") {
		refuse(before.ident, "a CREATE TYPE ... AS ENUM")
	}
	return {
		old: was.create,
		roster: rosterChange(was.create.labels, create.labels, () => rebuild(was.create))
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

/** What a rebuild does to one column of the enum's type, its one conversion: the target keeps it of the type, so it is
 * converted to the new type (`rebuilt`); the target drops it or its table at the end of the migration, so it is
 * converted to the new type unless the reviewer chooses a candidate that renames it with its type changed, whose
 * conversion to that type runs at the same step instead (`removed`); or the target changes it to another type, so it is
 * converted to that type, from `was` to `column` as `change` says (`retyped`). */
type RebuiltColumn =
	| { readonly kind: "rebuilt"; readonly column: ColumnDef }
	| { readonly kind: "removed"; readonly column: ColumnDef }
	| {
			readonly kind: "retyped"
			readonly was: ColumnDef
			readonly column: ColumnDef
			readonly change: Converted
	  }

/** The column of the enum's type a rebuild converts, as the previous manifest installs it. */
const columnOf = (x: RebuiltColumn): ColumnDef => (x.kind === "retyped" ? x.was : x.column)

/** The columns of an enum's type a rebuild converts, of one table. */
interface Conversion {
	readonly table: ObjectName
	readonly columns: NonEmptyReadonlyArray<RebuiltColumn>
}

/** A stored tag of an enum's type, which a rebuild drops and adds again. */
interface RebuiltTag {
	readonly object: ManifestObject
	readonly table: ObjectName
	readonly column: string
}

/** A dependent a rebuild's conversion would fail under, and its drop, first. */
interface RebuiltDependent {
	readonly object: ManifestObject
	readonly drop: Drop
}

/** A closed relation's enum rebuild (planRebuild): the roster it takes and the one it replaces, the columns of the type it
 * converts, the stored tags of the type, and the dependents it drops first, in the order they go; or the refusal of a
 * rebuild under what it cannot carry. */
type Rebuild = PlannedRebuild | RefusedRebuild

interface PlannedRebuild {
	readonly kind: "planned"
	readonly create: CreateEnum
	readonly old: CreateEnum
	readonly conversions: ReadonlyArray<Conversion>
	readonly tags: ReadonlyArray<RebuiltTag>
	readonly dependents: ReadonlyArray<RebuiltDependent>
	/** The target's indexes over a stored tag of the type whose previous index a replacement takes away, created again
	 * with the tag at the end of Structure. */
	readonly overTags: ReadonlyArray<{
		readonly object: ManifestObject
		readonly create: CreateIndex
	}>
}

type RefusedRebuild = { readonly kind: "refused" } & Unsupported

/** The handles a roster renamed in place, `[from, to]`: none unless both rosters have as many handles and every one
 * that differs is a label the other roster lacks. */
const renamedHandles = (
	old: ReadonlyArray<string>,
	next: ReadonlyArray<string>
): ReadonlyArray<readonly [string, string]> => {
	if (old.length !== next.length) {
		return []
	}
	const pairs: Array<readonly [string, string]> = []
	for (const [k, from] of old.entries()) {
		const to = next[k]
		if (to === undefined || to === from) {
			continue
		}
		if (next.includes(from) || old.includes(to)) {
			return []
		}
		pairs.push([from, to])
	}
	return pairs
}

/** A column list as a key of its set. */
const sortedColumns = (columns: ReadonlyArray<string>): string =>
	[...columns].toSorted(compareStrings).join(",")

/** The identity of a key of a table as a foreign key binds it: the table and the key's columns as a set, since
 * PostgreSQL matches a foreign key's referenced columns to a unique constraint whatever order either lists them in, and
 * a containment may name a key's fields in another order than the key declares them. A key is named in one snapshot's
 * coordinates, by the previous snapshot's names (KeyBefore) or by the target's (KeyAfter), each its own type, so no
 * key of the one is compared with a key of the other under names a rename changes: a previous key reaches the target's
 * names only through its images under its table's candidate renames (Differ.keyImages), the rename map applied once. */
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
 * target's keys it may stand beside, over their columns, once the reviewer decides the table's candidate renames
 * (keyImages). */
interface ReplacedKey {
	readonly before: KeyBefore
	readonly beside: ReadonlySet<KeyAfter>
}

const typeChanged = (a: ColumnDef, b: ColumnDef): boolean =>
	canonicalTextOf({ t: a.type, c: a.collation }) !== canonicalTextOf({ t: b.type, c: b.collation })

const sameColumnType = (a: ColumnDef, b: ColumnDef): boolean =>
	!typeChanged(a, b) && (a.generated === undefined) === (b.generated === undefined)

/** Each domain a manifest installs, by name key: what a column's type is read through to its representation. */
const domainsOf = (
	manifest: InstallationManifest<SqlStatement>
): ReadonlyMap<string, CreateDomain> =>
	new Map(
		manifest.objects.flatMap((o) => {
			const v = installed(o)
			return v.kind === "domain" ? [[nameKey(v.create.name), v.create] as const] : []
		})
	)

/** What a column of `type` holds, as canonical text: the type read through each domain of `domains` to its base type,
 * under the collation that applies (the column's own, else its domain's). A domain is its base type with a CHECK,
 * a law, so two types of one representation hold the same values: a pattern's domain and another pattern's, a
 * contract's and its base, two contracts over one base. */
const representationOf = (
	type: TypeRef,
	collation: Collation | undefined,
	domains: ReadonlyMap<string, CreateDomain>
): string => {
	const domain =
		type.kind === "named" ? domains.get(nameKey(objectName(type.schema, type.name))) : undefined
	return domain === undefined
		? canonicalTextOf({ t: type, c: collation })
		: representationOf(domain.base, collation ?? domain.collation, domains)
}

/** How a migration replaces the physical column of a table both snapshots install (ColumnFate): a field whose type
 * changes is converted in place, which first drops what is built over it (dropReplaced); a stored tag whose value
 * changes is retagged (storedTag), which takes every constraint and index over it along. */
type Replacement = "converted" | "retagged"

/** The strongest of `hows`: a conversion in place takes more than a stored tag dropped and added again. */
const strongestReplacement = (hows: ReadonlyArray<Replacement>): Replacement | undefined =>
	hows.includes("converted") ? "converted" : hows.includes("retagged") ? "retagged" : undefined

/** What a migration does to an identity sequence of a table both snapshots install: dropped with the identity that owns
 * it, or dropped and created again under its name, which leaves it with the default privileges. */
type SequenceFate = "dropped" | "recreated"

/** What a migration does to a field of a table both snapshots install, or of a relation a candidate renames, declared by
 * both, read off its type and its identity before and after: converted in place, its type changed, by its field's visit
 * or, a field of an enum a rebuild replaces, by the rebuild while the old type stands (`by`), with what becomes of its
 * identity when it was serial; otherwise kept, declared serial, or serial no longer, its identity added or dropped in
 * place (inPlace). A serial column converted gives its identity up first, whatever its new type, which drops the sequence
 * and its privileges, and the sequence is created again when the converted column takes the target's identity under its
 * name. A field serial before and after keeps its sequence, which its table's pairing renames when the target names it
 * otherwise (KeptPlan, renameOffer). */
type FieldChange =
	| { readonly kind: "kept" }
	| {
			readonly kind: "converted"
			readonly by: "field" | "rebuild"
			readonly sequence:
				| { readonly kind: "none" }
				| { readonly kind: SequenceFate; readonly sequence: ObjectName }
	  }
	| { readonly kind: "serialDeclared"; readonly sequence: ObjectName }
	| { readonly kind: "serialRemoved"; readonly sequence: ObjectName }

/** A field's change that converts its column in place. */
type Converted = Extract<FieldChange, { readonly kind: "converted" }>

/** The identity sequence of a serial column. */
const identitySequence = (c: ColumnDef): ObjectName | undefined =>
	c.generated?.kind === "identity" ? c.generated.sequence : undefined

/** The one reading of a field's change, from its column before and after and the enums whose rosters the migration
 * rebuilds, by name key. */
const fieldChange = (b: ColumnDef, c: ColumnDef, rebuilt: ReadonlySet<string>): FieldChange => {
	const was = identitySequence(b)
	const now = identitySequence(c)
	if (typeChanged(b, c)) {
		return {
			kind: "converted",
			by:
				b.type.kind === "named" && rebuilt.has(nameKey(objectName(b.type.schema, b.type.name)))
					? "rebuild"
					: "field",
			sequence:
				was === undefined
					? { kind: "none" }
					: {
							kind: now !== undefined && nameKey(now) === nameKey(was) ? "recreated" : "dropped",
							sequence: was
						}
		}
	}
	if (was === undefined) {
		return now === undefined ? { kind: "kept" } : { kind: "serialDeclared", sequence: now }
	}
	return now === undefined ? { kind: "serialRemoved", sequence: was } : { kind: "kept" }
}

/** The steps that change a field of `t` from `b` to `c` in place, by its change (fieldChange), `convert` converting the
 * column to its new type: a serial column gives its identity up before its conversion, and a column serial after takes
 * the target's identity once converted, advanced past the stored maximum; a field declared serial takes its identity,
 * advanced the same way, and one serial no longer gives it up; a field kept as it is takes none. The one reading for a
 * field of a table both install (changeField) and of a relation a candidate renames (renameOffer). */
const inPlace = (
	t: ObjectName,
	b: ColumnDef,
	c: ColumnDef,
	change: FieldChange,
	convert: (column: ColumnDef) => ReadonlyArray<ColumnConversion>
): ReadonlyArray<Action> => {
	const take = (sequence: ObjectName): ReadonlyArray<Action> => [
		statement(alter(t, [{ kind: "addIdentity", column: c.name, sequence }])),
		statement(advance(t, c.name, sequence, c.type))
	]
	const giveUp = statement(alter(t, [{ kind: "dropIdentity", column: b.name }]))
	switch (change.kind) {
		case "kept":
			return []
		case "converted": {
			const before = change.sequence.kind === "none" ? [] : [giveUp]
			return c.generated?.kind === "identity"
				? [...before, ...convert({ ...c, generated: undefined }), ...take(c.generated.sequence)]
				: [...before, ...convert(c)]
		}
		case "serialDeclared":
			return take(change.sequence)
		case "serialRemoved":
			return [giveUp]
	}
}

/** The identity sequences of the tables both install that a migration drops, by name key, each with its fate, read off
 * each field's change before any object is visited: a serial field converted in place drops its sequence, created again
 * when it takes the target's identity under its name; a field serial no longer drops it. */
const sequenceFatesOf = (
	kept: Iterable<KeptTable>,
	rebuilt: ReadonlySet<string>
): ReadonlyMap<string, SequenceFate> => {
	const out = new Map<string, SequenceFate>()
	for (const { old, create } of kept) {
		for (const c of create.columns) {
			const b = old.columns.find((x) => x.name === c.name)
			const change = b === undefined ? undefined : fieldChange(b, c, rebuilt)
			if (change?.kind === "converted" && change.sequence.kind !== "none") {
				out.set(nameKey(change.sequence.sequence), change.sequence.kind)
			} else if (change?.kind === "serialRemoved") {
				out.set(nameKey(change.sequence), "dropped")
			}
		}
	}
	return out
}

/** Whether two relations' primary keys hold the same columns, in key order. */
const samePrimaryKey = (a: CreateTable, b: CreateTable): boolean =>
	sameOrder(
		a.primaryKey.columns.map((k) => k.column),
		b.primaryKey.columns.map((k) => k.column)
	)

const sameFieldNames = (a: CreateTable, b: CreateTable): boolean =>
	sortedColumns(a.columns.map((c) => c.name)) === sortedColumns(b.columns.map((c) => c.name))

/** Whether a removed relation `a` and an added one `b` are a candidate rename: one heading, one primary key, or one set
 * of field names. Every field the two share that changes, its type or its identity, the rename changes in place as a
 * migration changes a field of a table both install (inPlace). */
const renamePair = (a: CreateTable, b: CreateTable): boolean =>
	sameHeading(a, b) || samePrimaryKey(a, b) || sameFieldNames(a, b)

/** The fields a relation's rename adds and drops, as a note names them. */
const fieldChanges = (added: ReadonlyArray<ColumnDef>, lost: ReadonlyArray<ColumnDef>): string =>
	[
		...(added.length > 0 ? [`${added.map((c) => quoteIdent(c.name)).join(", ")} added`] : []),
		...(lost.length > 0 ? [`${lost.map((c) => quoteIdent(c.name)).join(", ")} removed`] : [])
	].join(" and ")

/** The residual record of a law a snapshot enforces by a law function: mutabilityOnly asks only of a law both sides do. */
const residualRecord = (
	snapshot: { readonly theory: SnapshotTheory },
	law: LawId
): SnapshotResidual => {
	const record = snapshot.theory.laws[law]
	return record?.kind === "residual"
		? record.residual
		: refuseLaw(law, "a residual law record in the snapshot")
}

/** The drop of a type or a relation, which must find it. */
const dropObject = (
	v: Installed & { readonly kind: "enum" | "domain" | "table" | "materializedView" }
): SqlStatement => {
	const [object, name] =
		v.kind === "table"
			? (["TABLE", v.create.table] as const)
			: v.kind === "materializedView"
				? (["MATERIALIZED VIEW", v.create.name] as const)
				: v.kind === "domain"
					? (["DOMAIN", v.create.name] as const)
					: (["TYPE", v.create.name] as const)
	return { kind: "drop", object, name, ifExists: false }
}

/** The table key of a table or a materialized view: the name its definition creates. */
const relationKey = (v: Installed & { readonly kind: "table" | "materializedView" }): string =>
	nameKey(v.kind === "table" ? v.create.table : v.create.name)

/** The keys of every name qualified by `schema` that a value holds: relations, types, sequences and functions. */
const qualifiedNames = (value: unknown, schema: string): ReadonlySet<string> => {
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
		if (r["schema"] === schema && typeof r["name"] === "string") {
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
	schema: string
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
		for (const name of qualifiedNames(v.create.query, schema)) {
			add(view, name)
		}
	}
	return out
}

/** The drop of a law trigger, which every path drops once (Fate, Pairs, conversionDrops, a rebuild), so it must find
 * it. */
const dropTrigger = (v: { readonly create: CreateConstraintTrigger }): Action =>
	statement(partDrop("lawTrigger", v.create.table, v.create.name))

/** The drop of what a conversion in place of a column takes away, in the drop order (dropOrder): the foreign keys
 * first, then the keys and CHECKs, the indexes, the statistics objects, the law triggers and the stored tags whose
 * generation reads the column, which PostgreSQL refuses to convert it under (0A000); none for any other kind. */
const replacementDrop = (v: Installed): Drop | undefined => {
	switch (v.kind) {
		case "lawTrigger":
			return { rank: dropOrder.lawTrigger, draft: dropTrigger(v) }
		case "foreignKey":
		case "check":
		case "primaryKey":
		case "unique":
			return {
				rank: dropOrder[v.kind],
				draft: statement(partDrop("constraint", v.table, v.name))
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
		case "storedTag":
			return {
				rank: dropOrder.storedTag,
				draft: statement(alter(v.table, [{ kind: "dropColumn", column: v.column }]))
			}
		case "databaseDefault":
		case "schema":
		case "extension":
		case "enum":
		case "domain":
		case "table":
		case "refusalFunction":
		case "advanceFunction":
		case "isolationFunction":
		case "snapshotGuard":
		case "lawFunction":
		case "isolationTrigger":
		case "materializedView":
		case "validation":
		case "role":
		case "membership":
		case "privileges":
		case "roleSchema":
		case "view":
		case "worldFunction":
		case "policy":
		case "rowSecurity":
		case "ledger":
			return undefined
	}
}

const revokeOf = (g: Grant): Revoke => ({
	kind: "revoke",
	privileges: g.privileges,
	on: g.on,
	from: g.to
})

/** A statement with every mention of the PostgreSQL role `from` as `to`: the same statement when it names none. */
const renameRole = (s: SqlStatement, from: string, to: string): SqlStatement => {
	const role = (name: string): string => (name === from ? to : name)
	const grantees = (list: NonEmptyReadonlyArray<Grantee>): NonEmptyReadonlyArray<Grantee> =>
		mapNonEmpty(list, (g) =>
			g.kind === "role" && g.name === from ? { kind: "role", name: to } : g
		)
	const names = (list: ReadonlyArray<Grantee>): boolean =>
		list.some((g) => g.kind === "role" && g.name === from)
	switch (s.kind) {
		case "grant":
			return names(s.to) ? { ...s, to: grantees(s.to) } : s
		case "revoke":
			return names(s.from) ? { ...s, from: grantees(s.from) } : s
		case "grantRole":
			return s.role === from || s.to === from ? { ...s, role: role(s.role), to: role(s.to) } : s
		case "revokeRole":
			return s.role === from || s.from === from
				? { ...s, role: role(s.role), from: role(s.from) }
				: s
		case "grantColumns":
			return s.to === from ? { ...s, to } : s
		case "alterRole":
			return s.name === from ? { ...s, name: to } : s
		case "createPolicy":
			return s.role === from ? { ...s, role: to } : s
		case "comment":
			return s.on.kind === "ROLE" && s.on.name === from
				? { ...s, on: { kind: "ROLE", name: to } }
				: s
		case "select":
		case "insert":
		case "update":
		case "delete":
		case "merge":
		case "createSchema":
		case "createTable":
		case "alterTable":
		case "rename":
		case "renameColumn":
		case "renameConstraint":
		case "createDomain":
		case "alterDomain":
		case "createEnum":
		case "alterEnumAddValue":
		case "alterEnumRenameValue":
		case "createIndex":
		case "dropIndex":
		case "createMaterializedView":
		case "createView":
		case "dropPolicy":
		case "drop":
		case "dropFunction":
		case "dropTrigger":
		case "createFunction":
		case "createConstraintTrigger":
		case "createGuardTrigger":
		case "alterDatabaseDefault":
		case "createRole":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "createStatistics":
		case "lockTable":
		case "createCarrier":
		case "begin":
		case "commit":
		case "rollback":
		case "refresh":
		case "analyze":
			return s
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
 * materialized view it drops, an object an enum rebuild recreates, a table it converts a column of), read off the
 * target's edges in install order, a world object waiting for every relation, type and function its statements read
 * (`readsOf`); and each the target no longer holds. PostgreSQL refuses to convert, drop or rename what a view, a policy
 * or a function body reads beneath it, so dropping them first leaves every structural change free, and they hold
 * nothing a drop could lose.
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
		...simpleSelect(
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
 *   it: the reviewer's data steps, and the law triggers whose UPDATE OF names it, replaced or dropped before; a loss
 *   of its values, which the reviewer decides.
 * - Changing a field's type: the column is converted in place by ALTER COLUMN ... TYPE ... USING a marked placeholder
 *   the reviewer replaces by SQL computing the new value from the old (structure), or by its cast when the new type
 *   holds the old one's values (keepsValues: a pattern's domain for another pattern's, a contract added, removed or
 *   swapped for another over one base type), since a domain is its base type with a law: the cast keeps every value,
 *   and the new type's CHECK judges each as it runs, refusing a stored value with 23514. What is built over the column, a
 *   constraint, an index, a statistics object or a law trigger, and the foreign keys referencing a key over it, is
 *   dropped first (structure.drop), since PostgreSQL would carry it across the conversion under its old definition or
 *   refuse the conversion under it, and is built again as the target declares it, as on a relation that may hold rows,
 *   but for a key, which is added again in the same Structure transaction right after the conversion, so it holds at
 *   every commit;
 *   the materialized views over the table are dropped and recreated. A serial column changing type gives its identity
 *   up before the conversion, which drops its sequence, and takes one again after it, advanced past the stored maximum.
 * - Declaring a field serial: ALTER COLUMN ... ADD GENERATED ALWAYS AS IDENTITY and the sequence advanced past the
 *   stored maximum in the same transaction; removing serial: DROP IDENTITY, which drops the sequence and its grants,
 *   so Publish revokes nothing on it (structure).
 * - Adding a closed handle: ALTER TYPE ... ADD VALUE IF NOT EXISTS, positioned among the existing labels, in the
 *   no-transaction Setup file. Renaming handles in place: ALTER TYPE ... RENAME VALUE in Setup, under a marker the
 *   reviewer confirms. Removing or reordering handles rebuilds the enum in place, in Structure, under a marker the
 *   reviewer confirms (planRebuild): a new type under the naming door's rebuild name (identity.rebuild) with the new roster, every
 *   column of the old one converted once: to the new type (by its text, or, when handles are removed, by the
 *   expression the reviewer writes mapping each removed handle), or, when the target changes the column's type, to that
 *   type by the expression the reviewer writes at its placeholder; the old type dropped and the new one renamed to its
 *   name, its grants and
 *   PUBLIC revoke issued again; what names the type or reads a converted column without being converted (a CHECK, a
 *   foreign key, a partial index, a stored tag and the indexes over it) is dropped first and created again as the target
 *   declares it once the type is back.
 * - Changing a contract predicate: the domain's one constraint replaced in place under its name, dropped and added NOT
 *   VALID (structure), then validated (validate). A text pattern's domain is named by its pattern, so changing a
 *   field's pattern changes its type to the new pattern's domain, which holds the old one's values: a conversion by
 *   its cast.
 * - Adding a key to a relation that may hold rows: its unique index built concurrently (indexes), then the constraint
 *   attached USING INDEX (validate); a key with a span field is added directly in Validate, since PostgreSQL attaches
 *   only B-tree indexes. Changing a key builds the new index under a temporary name and swaps it in one statement. A
 *   capacity's partial unique index follows the same path.
 * - A key of a table both snapshots install that the migration removes or replaces under its name, over columns that,
 *   under some decision of the candidate renames, are those of a key the target declares there: PostgreSQL binds a
 *   foreign key to the first unique index over its referenced columns and refuses that index's drop under it, so the
 *   key goes in Validate, once the target's keys are attached and before the foreign keys over those columns are
 *   added, whichever way the reviewer decides; the foreign keys that may be bound to it go before it and are added
 *   again after (replacedKey). Its columns reach the target's names only through its images under its table's
 *   candidate renames (keyImages), the one rename map, so no key is compared under names a rename changes.
 * - Adding a row check or a containment to a relation that may hold rows: NOT VALID (structure), VALIDATE (validate);
 *   a containment that needs a key this migration attaches is added after it, in Validate.
 * - Adding or changing a residual law: its index in Indexes, and in its own Validate transaction a lock excluding every
 *   writer to its participating tables, its function created or replaced in place, its triggers (replacing the old
 *   ones) and its full violation query, which raises with the law's identity and rolls the file back, the old
 *   function with it, when existing rows violate it. A change that declaring or removing `mutable` alone causes
 *   replaces the function and the triggers in Publish without revalidation.
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
 *   takes away and builds again (a table, a column converted in place or by an enum rebuild, a materialized view it
 *   drops, a relation whose keys or foreign keys it changes, a type, a function, another world object), is dropped at
 *   the start of Structure,
 *   before anything they read is converted or dropped; one the target no longer has is dropped there too
 *   (worldChangesOf). Each is created again
 *   at the end of Structure, in the same transaction, with its grants, when its role stands before the migration, so no
 *   committed state lacks a view or policy an existing role relies on; a role's the migration creates are created in
 *   Publish with the role. A
 *   role's schema is created in Publish and dropped at its end, and a table's row security enabled in Publish or
 *   disabled at its end. A removed login and an added one are a candidate rename, ALTER ROLE ... RENAME, which keeps the
 *   login's password.
 * - Removing a law drops its native constraints and its triggers in Publish, and its function with what else it
 *   removes.
 * - A removed and an added relation with one heading, one primary key or one set of field names, or a removed and an
 *   added field of one relation, are a candidate rename (Candidate): the draft carries the marker and the commented
 *   rename, and every other drafted statement the choice changes is marked with what it becomes. A field's rename
 *   renames the column and its identity sequence, converting it in place when its type changes; what is over the
 *   column is drafted under its target names either way. A relation's rename brings across, by definition, the
 *   constraints, indexes, statistics objects, stored tags and identity sequences the target declares, drops the rest
 *   (first the foreign keys of other relations that reference a key it drops, which the draft adds again and
 *   validates, and the law triggers over a field it drops or converts), and converts in place each field whose type
 *   changes. An enum rebuild runs before every rename, so what it drops, a dependent or a
 *   stored tag of a removed relation, is neither paired nor dropped by a rename, and the rebuild's own drop of it
 *   stands whichever way the reviewer decides.
 * - Every drop of stored data, a relation with its rows or a field with its values, is a loss the reviewer decides
 *   (`LossDecision`): drafted commented, it runs only once the reviewer writes it in, and a candidate rename that
 *   carries the data is the other way to decide it. A schema's first migration beside schemas the configuration no
 *   longer lists starts the schema under the loss of their rows, decided the same way.
 * - A removed relation or type whose name the target gives an object of the other kind, and a kept stored relation
 *   whose identity moves (its name now holds another heading while another relation of the target has the one it
 *   held: a swap or a chain), is renamed aside first, in Setup, under a marker the reviewer confirms, and the diff
 *   starts from the previous snapshot as it is after that. PostgreSQL keeps a table's row type in the
 *   types' name space, so no order of statements could otherwise take the name while its holder stands, a swap of names
 *   between the kinds has no order at all, and a relation compared by name alone would be changed in place into
 *   another, its rows staying under the old name. */
export const diff = (input: DiffInput): Result.Result<MigrationPlan, CompileError> =>
	catchRefusal(() => new Differ(input).run())

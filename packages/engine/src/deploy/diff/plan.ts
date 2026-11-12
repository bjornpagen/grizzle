import type { DeclaredName } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"
import type {
	AlterTable,
	AlterTableAction,
	ColumnDef,
	ObjectName,
	Select,
	SqlStatement
} from "#compiler/sql/ast.ts"

/**
 * A name a draft's declarations speak of, as `--rename` and `--drop` spell it: a relation (`Relation`), a field of one
 * (`Relation.field`), a roster's handle (`Roster#handle`), or a login (`@login`).
 */
export type Named =
	| { readonly kind: "relation"; readonly relation: DeclaredName }
	| { readonly kind: "field"; readonly relation: DeclaredName; readonly field: DeclaredName }
	| { readonly kind: "handle"; readonly roster: DeclaredName; readonly handle: string }
	| { readonly kind: "login"; readonly login: DeclaredName }

/** A declared rename, `--rename <from>=<to>`: its two sides of one kind, `from` named as the previous snapshot names
 * it and `to` as the target does. */
export interface Rename {
	readonly from: Named
	readonly to: Named
}

/**
 * What a draft is told beside the schema: each rename and each drop its migration makes, in declaration order. Every
 * drop of stored state is declared, by one or the other, so nothing guesses whether a drop and an addition are one
 * rename: a handle renamed keeps its code, a relation and a login renamed keep their identities, and an undeclared drop
 * is refused, naming it.
 *
 * What is stored state, and so declared when it goes:
 * - a stored relation's rows, a field's values and a roster's live handle, whose code its stored values hold;
 * - a login: its PostgreSQL role holds what its operator gave it and no migration can give again, its password and
 *   whatever was granted to it outside grizzle. A login renamed is that role renamed in place (`ALTER ROLE ... RENAME
 *   TO`), so its OID, password, memberships and grants survive; a login that goes undeclared while another comes is
 *   refused, never read as one renamed.
 *
 * A name a declared rename takes from a name the previous snapshot holds is that name's end: the previous holder is
 * dropped, as declared, even where the target declares something of the same name. The rest holds no state of its
 * own: a derived relation, which its definition recomputes, a generated, drawn or accumulated field, which grizzle
 * draws again, and a role, whose PostgreSQL role, schema, views, policies and grants grizzle creates and grants whole.
 * A role is named by its own declared name, never by its login's, so a login's rename leaves its roles as they stand,
 * and their memberships in the login, which PostgreSQL holds by OID, follow the rename.
 */
export interface Declarations {
	readonly renames: ReadonlyArray<Rename>
	readonly drops: ReadonlyArray<Named>
}

/** Where a drafted statement goes. Slots are ordered, and each names the file its steps go to (`slotFile`), which
 * consecutive slots naming one file share; `planFiles` numbers the files in slot order:
 *
 * - setup.drop, setup: the holders set aside (`asidesOf`), then the checks of the laws over closed relations alone,
 *   then extensions, new constants and new domains;
 * - structure.drop, structure, structure.backfill, structure.constraints, structure.worlds: the roles' views, world
 *   functions and policies the migration changes or removes, then recreated materialized views dropped top-down and
 *   what is built over a column converted in place dropped before its conversion, then new tables, each table's one
 *   alteration (its new columns, conversions by cast, set-aside columns, identities and law columns, and a new table's
 *   own constraints); then, when Structure holds a data step, SET CONSTRAINTS ALL IMMEDIATE, after which every data
 *   step runs (diff.ts checkedAtOnce): the reviewer's UPDATE a placeholder column invites, written right after it, then
 *   each table's fill of its set-aside fields (Action fill), once every placeholder column of every table holds its
 *   value; then new or recreated materialized views WITH NO DATA with their unique indexes, which
 *   read the fields as the fills leave them; then the backfill of the families new to stored rows (backfill.ts) and the
 *   DROP DEFAULT of each column it drew; then each table's one alteration adding the
 *   constraints of tables that may hold rows, NOT VALID, after every value they read is drawn; and last the roles' changed
 *   views, world functions and policies created again with their grants, each whose role stands before the migration:
 *   in the one transaction that dropped them, so no committed state lacks one an existing role relies on;
 * - indexes: ordinary CREATE INDEX on relations this migration creates, which are empty, and CREATE STATISTICS
 *   followed by ANALYZE of a table that existed;
 * - indexes.concurrent: CREATE INDEX CONCURRENTLY on relations that may hold rows, each after dropping an invalid
 *   index a failed build left;
 * - validate.attach, validate: key constraints attached to their concurrently built indexes, then VALIDATE CONSTRAINT
 *   and the containments that need those keys;
 * - publish, publish.drop, publish.roles, publish.worlds, publish.grants, publish.defaults, publish.removed: the
 *   installation's validation statements (the refined constants' casts to their domains), the removed laws' native
 *   objects and constraints, the logins and roles, the roles' schemas, the views, world
 *   functions and policies of the roles this migration creates, and row security, the grants and memberships, the
 *   login defaults and PUBLIC revokes, every object the target no longer has, dropped in place: its indexes, roles and role schemas,
 *   statistics, views, functions, stored tags, columns, tables and types, in that order, and last the COMMENT of every
 *   object this migration creates or renames, or whose comment the target changes (physical/install/comments.ts). */
export const slots = [
	"setup.drop",
	"setup",
	"structure.drop",
	"structure",
	"structure.immediate",
	"structure.fill",
	"structure.views",
	"structure.backfill",
	"structure.constraints",
	"structure.worlds",
	"indexes",
	"indexes.concurrent",
	"validate.attach",
	"validate",
	"publish",
	"publish.drop",
	"publish.roles",
	"publish.worlds",
	"publish.grants",
	"publish.defaults",
	"publish.removed",
	"publish.comments"
] as const
export type Slot = (typeof slots)[number]

/** The slots that alter each table once (Action alteration): every subcommand a slot drafts on one table is one ALTER
 * TABLE, at the place of the table's first, so PostgreSQL rewrites a table at most once for the whole Structure file,
 * however many columns a migration adds to it, converts or generates. Structure's drops and backfill alter no table
 * that way: a drop never rewrites, and the drops' order among tables is the foreign keys' (dropOrder); the backfill's
 * DROP DEFAULT is already one statement per table. */
export type TableSlot = Extract<Slot, "structure" | "structure.constraints">

export const isTableSlot = (slot: Slot): slot is TableSlot =>
	slot === "structure" || slot === "structure.constraints"

/** A file of a phase holding its slots' steps, in one transaction or none. */
export interface SlotsFile {
	readonly kind: "slots"
	readonly phase: DeployPhase
	readonly transaction: boolean
}

const slotsFile = (phase: DeployPhase, transaction: boolean): SlotsFile => ({
	kind: "slots",
	phase,
	transaction
})
const setupFile = slotsFile("setup", true)
const structureFile = slotsFile("structure", true)
const indexesFile = slotsFile("indexes", true)
const concurrentIndexesFile = slotsFile("indexes", false)
const validateFile = slotsFile("validate", true)
const publishFile = slotsFile("publish", true)

/** The file each slot's steps go to. A slot exists only with its file, and its phase is its file's. */
export const slotFile: { readonly [S in Slot]: SlotsFile } = {
	"setup.drop": setupFile,
	setup: setupFile,
	"structure.drop": structureFile,
	structure: structureFile,
	"structure.immediate": structureFile,
	"structure.fill": structureFile,
	"structure.views": structureFile,
	"structure.backfill": structureFile,
	"structure.constraints": structureFile,
	"structure.worlds": structureFile,
	indexes: indexesFile,
	"indexes.concurrent": concurrentIndexesFile,
	"validate.attach": validateFile,
	validate: validateFile,
	publish: publishFile,
	"publish.drop": publishFile,
	"publish.roles": publishFile,
	"publish.worlds": publishFile,
	"publish.grants": publishFile,
	"publish.defaults": publishFile,
	"publish.removed": publishFile,
	"publish.comments": publishFile
}

/** Why no cast converts a column in place: `values`, the new type's values are other values; or `roster`, a value of one
 * side is a code, which names a handle only under its own roster and the conversion leaves that roster, so a cast would
 * read it as another handle or a bare number. */
export type RetypeReason = "values" | "roster"

/** A subcommand of a table's alteration whose value the reviewer writes at its placeholder, which a marker above the
 * alteration explains: ADD COLUMN ... NOT NULL DEFAULT <placeholder>, its DROP DEFAULT drafted after the alteration: a
 * field added to a relation that may hold rows needs a value for every row, which the generator cannot invent. */
export interface PlaceholderAlteration {
	readonly kind: "placeholderColumn"
	readonly column: ColumnDef
}

/** One subcommand of a table's alteration: an ALTER TABLE action, or a placeholder column's (PlaceholderAlteration),
 * which prints as the ADD COLUMN ... DEFAULT <placeholder> under its marker. */
export type Alteration = AlterTableAction | PlaceholderAlteration

/**
 * A field converted at the reviewer's value, set aside: a field whose type changes to one that holds other values, for
 * its `reason` (RetypeReason). No ALTER COLUMN ... TYPE ... USING converts it in place, since a USING expression reads
 * the row alone, its subqueries refused (PostgreSQL 19rc1, src/backend/parser/parse_utilcmd.c 3678 transforms it as
 * EXPR_KIND_ALTER_COL_TRANSFORM, which transformSubLink refuses at src/backend/parser/parse_expr.c 1850-1851, "cannot
 * use subquery in transform expression"), and a re-pointed reference's value lies in its target's row, which a
 * placeholder column of the same migration may only now be filling. So its table's one alteration adds the column
 * `aside`, of `column`'s type with no NOT NULL and no default (catalog only), its table's fill (Action fill) sets it
 * once every placeholder column holds its value, then drops the field's column, renames `aside` into the field's name
 * and sets its NOT NULL, its identity or its uuidv7() default. `column` is the field as the target declares it.
 */
export interface SetAside {
	readonly column: ColumnDef
	readonly aside: string
	readonly reason: RetypeReason
}

/**
 * The passes one ALTER TABLE runs its subcommands in, in order, each pass's subcommands in the order the statement lists
 * them (PostgreSQL 19rc1, src/backend/commands/tablecmds.c: AlterTablePass at 150-166, run in order by
 * ATRewriteCatalogs at 5345-5396, a CommandCounterIncrement after each subcommand at 5738, so each sees the ones before
 * it): the drops, the type conversions, the added columns, the re-expressed generations, the re-added indexes and
 * constraints of the converted columns, the constraints as first examined, the columns' attributes, the keys, the
 * indexes, then the other constraints, identities and defaults, and the rest.
 */
export const alterTablePasses = [
	"drop",
	"alterType",
	"addColumn",
	"setExpression",
	"oldIndex",
	"oldConstraint",
	"addConstraint",
	"columnAttributes",
	"addIndexConstraint",
	"addIndex",
	"addOtherConstraint",
	"misc"
] as const
export type AlterTablePass = (typeof alterTablePasses)[number]

/** The pass a subcommand runs in (alterTablePasses): ATPrepCmd's (tablecmds.c 4977-5191), an added constraint's as
 * ATParseTransformCmd moves it on (5807-5840), a key's to the keys and a CHECK's or foreign key's to the other
 * constraints. */
export const alterationPass = (a: Alteration): AlterTablePass => {
	switch (a.kind) {
		case "dropColumn":
		case "dropConstraint":
		case "dropIdentity":
		case "dropDefault":
			return "drop"
		case "alterColumnType":
			return "alterType"
		case "setNotNull":
			return "columnAttributes"
		case "addColumn":
		case "addColumnPlaceholder":
		case "addColumnDefault":
		case "addColumnUnchecked":
		case "placeholderColumn":
			return "addColumn"
		case "setExpression":
			return "setExpression"
		case "addConstraint":
			return a.constraint.kind === "check" || a.constraint.kind === "foreignKey"
				? "addOtherConstraint"
				: "addIndexConstraint"
		case "addConstraintUsingIndex":
			return "addIndexConstraint"
		case "addIdentity":
		case "setUuidv7Default":
			return "addOtherConstraint"
		case "validateConstraint":
		case "enableRowSecurity":
		case "disableRowSecurity":
			return "misc"
	}
}

/** The ALTER TABLE action a subcommand prints as: a placeholder's with its placeholder token (sql/ast.ts
 * addColumnPlaceholder, Using placeholder), any other as it is. */
const printedAction = (a: Alteration): AlterTableAction => {
	switch (a.kind) {
		case "placeholderColumn":
			return { kind: "addColumnPlaceholder", column: a.column }
		case "addColumn":
		case "addColumnPlaceholder":
		case "addColumnUnchecked":
		case "setNotNull":
		case "addColumnDefault":
		case "dropColumn":
		case "dropDefault":
		case "setUuidv7Default":
		case "alterColumnType":
		case "addIdentity":
		case "dropIdentity":
		case "addConstraint":
		case "addConstraintUsingIndex":
		case "validateConstraint":
		case "dropConstraint":
		case "enableRowSecurity":
		case "disableRowSecurity":
		case "setExpression":
			return a
	}
}

/** The one ALTER TABLE a table's alteration runs: its subcommands as they print, in its order. */
export const alterationStatement = (
	table: ObjectName,
	actions: NonEmptyReadonlyArray<Alteration>
): AlterTable => ({ kind: "alterTable", table, actions: mapNonEmpty(actions, printedAction) })

/** One drafted action:
 * - `statement`: one statement, audited and printed by `emit`;
 * - `alteration`: a table's one ALTER TABLE in a slot that alters each table once (TableSlot), its subcommands in
 *   PostgreSQL's pass order (alterationPass), so PostgreSQL rewrites the table at most once for all of them: in its one
 *   phase 3 (tablecmds.c ATRewriteTables at 5882, the rewrite at 5929-6053, fired once per table at 6006), which also
 *   checks every CHECK the statement adds (ATRewriteTable at 6236-6237); then one DROP DEFAULT of each placeholder column (PlaceholderAlteration),
 *   after the reviewer's optional UPDATE;
 * - `fill`: a table's fill of its set-aside fields (SetAside), in structure.fill, after every table's alteration: one
 *   UPDATE setting each set-aside column to the reviewer's value at its placeholder, under a marker each, the row aliased
 *   "t" and each old column still under its field's name, the last value free to be followed by the FROM and WHERE the
 *   values join. The fill's steps after it are statements (diff.ts fillSteps): the fields' old columns dropped, each
 *   set-aside column renamed into its field's name, one ALTER TABLE setting each field's NOT NULL, identity or uuidv7()
 *   default and the NOT NULL of every generated column over one, and an identity's advance;
 * - `violation`: the full violation query of a law the migration discharges once, which raises with the law's identity
 *   when it has a row;
 * - `analyze`: ANALYZE of a table that may hold rows, after a new statistics object;
 * - `dropStatistics`: DROP STATISTICS, which the SQL AST has no form for. */
export type Action =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| {
			readonly kind: "alteration"
			readonly table: ObjectName
			readonly actions: NonEmptyReadonlyArray<Alteration>
	  }
	| {
			readonly kind: "fill"
			readonly table: ObjectName
			readonly fields: NonEmptyReadonlyArray<SetAside>
	  }
	| { readonly kind: "violation"; readonly law: LawId; readonly query: Select }
	| { readonly kind: "analyze"; readonly table: ObjectName }
	| { readonly kind: "dropStatistics"; readonly name: ObjectName }

/** A column's conversion to a new type: in place by its cast, when the new type holds the old one's values (its domains
 * read through, the two are one base type under one collation, so the cast keeps every value and only the laws its
 * domains carry change, which judge the stored values as it runs); otherwise by the value the reviewer writes, set
 * aside (`placeholderRetype`, SetAside). */
export type ColumnConversion =
	| Extract<AlterTableAction, { readonly kind: "alterColumnType" }>
	| { readonly kind: "placeholderRetype"; readonly reason: RetypeReason }

/** A schema the migrations directory holds that the configuration no longer lists: its PostgreSQL schema and its
 * directory, as the command line names it. */
export interface AbandonedSchema {
	readonly schema: string
	readonly directory: string
}

/** What a statement that loses stored data no declaration names loses: when a schema's first migration starts it empty
 * while the migrations directory holds schemas the configuration no longer lists (a schema renamed in code is a new
 * PostgreSQL schema), their rows, left where they are and never migrated again. Every other drop is declared. */
export interface Loss {
	readonly kind: "schema"
	readonly schema: string
	readonly abandoned: NonEmptyReadonlyArray<AbandonedSchema>
}

/** A statement that loses stored data, which only the reviewer may decide: drafted commented under its marker, so it
 * runs only once the reviewer writes it in. Until then, the loss is unresolved, and `grizzle check` and `grizzle
 * migrate` refuse the folder (`lossDecisions`). */
export interface LossDecision {
	readonly kind: "loss"
	readonly loses: Loss
	readonly statement: SqlStatement
}

/** Drafted statements the reviewer confirms under one marker, with no other way drafted: one decision, so the files
 * keep them all, as drafted, or none of them. */
export interface Confirm {
	readonly kind: "confirm"
	readonly note: string
	readonly instruction: string
	readonly keep: NonEmptyReadonlyArray<SqlStatement>
}

/** One drafted step's content: an action, a loss decision, or a confirmed group. */
export type Draft = Action | LossDecision | Confirm

/** A drafted step in its slot. */
export interface Step {
	readonly slot: Slot
	readonly draft: Draft
}

/**
 * An index a migration builds under a temporary name (diff.ts swapName) before it swaps it in for the target's object
 * `of` on the table `table`: a refusal of its build, such as a key's over stored rows that repeat it, reports `name`
 * as its constraint, which the folder's laws read as the law of `of` (render/generate.ts folderLaws).
 */
export interface Swap {
	readonly table: string
	readonly name: string
	readonly of: string
}

/** A migration plan: what the diff of two snapshots drafts, slot by slot, before the phases group it into files, and
 * every index it builds under a temporary name, in the order the diff mints their names. */
export interface MigrationPlan {
	readonly steps: ReadonlyArray<Step>
	readonly swaps: ReadonlyArray<Swap>
}

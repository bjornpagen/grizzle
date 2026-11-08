import type { DeclaredName } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"
import type { ColumnDef, ObjectName, Select, SqlStatement } from "#compiler/sql/ast.ts"

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
 *   what is built over a column converted in place dropped before its conversion, then new tables, new columns,
 *   conversions, and new or recreated materialized views WITH NO DATA with their unique indexes; then the backfill of
 *   the families new to stored rows (backfill.ts) and the DROP DEFAULT of each column it drew; then the constraints
 *   added to tables that may hold rows, NOT VALID, after every value they read is drawn; and last the roles' changed
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

/** One drafted action:
 * - `statement`: one statement, audited and printed by `emit`;
 * - `placeholderColumn`: ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <placeholder>, then ALTER COLUMN ... DROP
 *   DEFAULT: a field added to a relation that may hold rows needs a value for every row, which the generator cannot
 *   invent;
 * - `placeholderRetype`: ALTER TABLE ... ALTER COLUMN ... TYPE ... USING <placeholder>: a column converted in place to
 *   `column`'s type, by the expression the reviewer writes: a field whose type changes to one that holds other values
 *   (a `ColumnConversion`), for its `reason` (RetypeReason);
 * - `violation`: the full violation query of a law the migration discharges once, which raises with the law's identity
 *   when it has a row;
 * - `analyze`: ANALYZE of a table that may hold rows, after a new statistics object;
 * - `dropStatistics`: DROP STATISTICS, which the SQL AST has no form for. */
/** Why no cast converts a column in place: `values`, the new type's values are other values; or `roster`, a value of one
 * side is a code, which names a handle only under its own roster and the conversion leaves that roster, so a cast would
 * read it as another handle or a bare number. */
export type RetypeReason = "values" | "roster"

export type Action =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| { readonly kind: "placeholderColumn"; readonly table: ObjectName; readonly column: ColumnDef }
	| {
			readonly kind: "placeholderRetype"
			readonly table: ObjectName
			readonly column: ColumnDef
			readonly reason: RetypeReason
	  }
	| { readonly kind: "violation"; readonly law: LawId; readonly query: Select }
	| { readonly kind: "analyze"; readonly table: ObjectName }
	| { readonly kind: "dropStatistics"; readonly name: ObjectName }

/** A column's conversion in place to a new type: the statement converting it by its cast, when the new type holds the
 * old one's values (its domains read through, the two are one base type under one collation, so the cast keeps every
 * value and only the laws its domains carry change, which judge the stored values as it runs); otherwise the
 * expression the reviewer writes at its placeholder (`placeholderRetype`). */
export type ColumnConversion = Extract<Action, { readonly kind: "statement" | "placeholderRetype" }>

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

/** A migration plan: what the diff of two snapshots drafts, slot by slot, before the phases group it into files. */
export interface MigrationPlan {
	readonly steps: ReadonlyArray<Step>
}

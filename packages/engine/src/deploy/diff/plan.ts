import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"
import type { ColumnDef, ObjectName, Select, SqlStatement } from "#compiler/sql/ast.ts"

/** Where a drafted statement goes. Slots are ordered, and each names the file its steps go to (`slotFile`), which
 * consecutive slots naming one file share; `planFiles` numbers the files in slot order:
 *
 * - setup.labels: enum labels added with ALTER TYPE ... ADD VALUE, in a no-transaction file first, because a new
 *   label is not usable until its transaction commits;
 * - setup.drop, setup: the holders set aside (`asidesOf`), then extensions, new enums and new domains;
 * - structure.drop, structure, structure.worlds: the roles' views, world functions and policies the migration changes
 *   or removes, then recreated materialized views dropped top-down and what is built over a column converted in place
 *   dropped before its conversion, then new tables, new columns, conversions, constraints NOT VALID, and new or
 *   recreated materialized views WITH NO DATA with their unique indexes, and last the roles' changed views, world
 *   functions and policies created again with their grants, each whose role stands before the migration: in the one
 *   transaction that dropped them, so no committed state lacks one an existing role relies on;
 * - indexes: ordinary CREATE INDEX on relations this migration creates, which are empty, and CREATE STATISTICS
 *   followed by ANALYZE of a table that existed;
 * - indexes.concurrent: CREATE INDEX CONCURRENTLY on relations that may hold rows, each after dropping an invalid
 *   index a failed build left;
 * - validate.attach, validate: key constraints attached to their concurrently built indexes, then VALIDATE CONSTRAINT
 *   and the containments that need those keys;
 * - validate.law: one transaction per residual law: its writer-excluding lock, its constraint triggers and its full
 *   violation query;
 * - publish, publish.triggers, publish.drop, publish.roles, publish.worlds, publish.grants, publish.defaults,
 *   publish.removed: the installation's validation statements (the refined constants' casts to their domains), the law
 *   function and trigger replacements `mutable` or a change of the roles a law reports its witness keys to requires,
 *   the removed laws' native objects and constraints, the logins and roles, the roles' schemas, the views, world
 *   functions and policies of the roles this migration creates, and row security, the grants and memberships, the
 *   login defaults and PUBLIC revokes, every object the target no longer has, dropped in place: its indexes, roles and role schemas,
 *   statistics, views, functions, stored tags, columns, tables and types, in that order, and last the COMMENT of every
 *   object this migration creates or renames, or whose comment the target changes (physical/install/comments.ts). */
export const slots = [
	"setup.labels",
	"setup.drop",
	"setup",
	"structure.drop",
	"structure",
	"structure.worlds",
	"indexes",
	"indexes.concurrent",
	"validate.attach",
	"validate",
	"validate.law",
	"publish",
	"publish.triggers",
	"publish.drop",
	"publish.roles",
	"publish.worlds",
	"publish.grants",
	"publish.defaults",
	"publish.removed",
	"publish.comments"
] as const
export type Slot = (typeof slots)[number]
/** Every slot but a residual law's, whose steps each name their law. */
export type PlainSlot = Exclude<Slot, "validate.law">

/** A file of a phase holding its slots' steps, in one transaction or none. */
export interface SlotsFile {
	readonly kind: "slots"
	readonly phase: DeployPhase
	readonly transaction: boolean
}

/** The residual laws' files: one per law, each in a transaction of its own. */
export interface LawsFile {
	readonly kind: "laws"
	readonly phase: "validate"
}

const slotsFile = (phase: DeployPhase, transaction: boolean): SlotsFile => ({
	kind: "slots",
	phase,
	transaction
})
const labelsFile = slotsFile("setup", false)
const setupFile = slotsFile("setup", true)
const structureFile = slotsFile("structure", true)
const indexesFile = slotsFile("indexes", true)
const concurrentIndexesFile = slotsFile("indexes", false)
const validateFile = slotsFile("validate", true)
const lawsFile: LawsFile = { kind: "laws", phase: "validate" }
const publishFile = slotsFile("publish", true)

/** The file each slot's steps go to, the residual laws' slot alone going to the laws' files. A slot exists only with
 * its file, and its phase is its file's. */
export const slotFile: { readonly [S in Slot]: S extends "validate.law" ? LawsFile : SlotsFile } = {
	"setup.labels": labelsFile,
	"setup.drop": setupFile,
	setup: setupFile,
	"structure.drop": structureFile,
	structure: structureFile,
	"structure.worlds": structureFile,
	indexes: indexesFile,
	"indexes.concurrent": concurrentIndexesFile,
	"validate.attach": validateFile,
	validate: validateFile,
	"validate.law": lawsFile,
	publish: publishFile,
	"publish.triggers": publishFile,
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
 *   invent. The hint names the removed columns the new one may be computed from;
 * - `placeholderRetype`: ALTER TABLE ... ALTER COLUMN ... TYPE ... USING <placeholder>: a column converted in place to
 *   `column`'s type, by the expression the reviewer writes: a field whose type changes to one that holds other values,
 *   or a column renamed to `column`'s name whose type changes so with it (a `ColumnConversion`);
 * - `placeholderHandles`: ALTER TABLE ... ALTER COLUMN ... TYPE <rebuilt enum> USING <placeholder>: a column of a
 *   closed relation's enum whose roster lost handles, converted to the rebuilt type by the expression the reviewer
 *   writes, which maps each removed handle to one of the new roster's;
 * - `violation`: the full violation query of a residual law, which raises with the law's identity when it has a row;
 * - `analyze`: ANALYZE of a table that may hold rows, after a new statistics object;
 * - `dropStatistics`: DROP STATISTICS, which the SQL AST has no form for. */
export type Action =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| {
			readonly kind: "placeholderColumn"
			readonly table: ObjectName
			readonly column: ColumnDef
			readonly hint: ColumnHint
	  }
	| { readonly kind: "placeholderRetype"; readonly table: ObjectName; readonly column: ColumnDef }
	| {
			readonly kind: "placeholderHandles"
			readonly table: ObjectName
			readonly column: string
			readonly type: ObjectName
			readonly removed: NonEmptyReadonlyArray<string>
			readonly labels: NonEmptyReadonlyArray<string>
	  }
	| { readonly kind: "violation"; readonly law: LawId; readonly query: Select }
	| { readonly kind: "analyze"; readonly table: ObjectName }
	| { readonly kind: "dropStatistics"; readonly name: ObjectName }

/** A column's conversion in place to a new type: the statement converting it by its cast, when the new type holds the
 * old one's values (its domains read through, the two are one base type under one collation, so the cast keeps every
 * value and only the laws its domains carry change, which judge the stored values as it runs); otherwise the
 * expression the reviewer writes at its placeholder (`placeholderRetype`). */
export type ColumnConversion = Extract<Action, { readonly kind: "statement" | "placeholderRetype" }>

/** The removed columns a new column's placeholder names, if it may be one of them renamed: none, or the columns a
 * relation's rename drops once its new columns are added, so if it is one of them renamed, the reviewer computes it
 * from that one first. */
export type ColumnHint =
	| { readonly kind: "none" }
	| { readonly kind: "dropped"; readonly removed: NonEmptyReadonlyArray<ColumnDef> }

/** A drafted action whose fate candidate renames decide: the reviewer keeps it, or chooses the candidate of one offer
 * and does what that offer says. Each offer is a marker with its commented alternative, above the action. */
export interface Choice {
	readonly kind: "choice"
	readonly offers: NonEmptyReadonlyArray<Offer>
	readonly keep: Action
}

/** A schema the migrations directory holds that the configuration no longer lists: its PostgreSQL schema and its
 * directory, as the command line names it. */
export interface AbandonedSchema {
	readonly schema: string
	readonly directory: string
}

/** What a statement that loses stored data loses: a relation with its rows; a field with its values; or, when a
 * schema's first migration starts it empty while the migrations directory holds schemas the configuration no longer
 * lists (a schema renamed in code is a new PostgreSQL schema), their rows, left where they are and never migrated
 * again. */
export type Loss =
	| { readonly kind: "relation"; readonly relation: ObjectName }
	| { readonly kind: "field"; readonly relation: ObjectName; readonly field: string }
	| {
			readonly kind: "schema"
			readonly schema: string
			readonly abandoned: NonEmptyReadonlyArray<AbandonedSchema>
	  }

/** A candidate rename that carries what a loss loses instead: choosing it takes the data along under the new name. */
export interface Carrier {
	readonly candidate: number
	readonly label: string
}

/** A statement that loses stored data, which only the reviewer may decide: drafted commented under its marker, so it
 * runs only once the reviewer writes it in, and left out where a candidate rename that carries the data is chosen
 * instead. Until one of the two is chosen, the loss is unresolved, and `grizzle check` and `grizzle migrate` refuse
 * the folder (`lossDecisions`). */
export interface LossDecision {
	readonly kind: "loss"
	readonly loses: Loss
	readonly statement: SqlStatement
	readonly carriers: ReadonlyArray<Carrier>
}

/** One step of a rename's alternative: an action, a choice nested in it, which a candidate rename of a member of the
 * renamed container offers (a field of a relation renamed), or the loss of a field the alternative drops, each decided
 * only where the reviewer takes the alternative. */
export type AlternativeStep = Action | Choice | LossDecision

/** One drafted step's content: an action, a choice, a loss decision, or a `confirm`: drafted statements the reviewer
 * confirms under one marker, with no other way drafted: one decision, so the files keep them all, as drafted, or none
 * of them (`splitRenames`). */
export type Draft =
	| Action
	| Choice
	| LossDecision
	| {
			readonly kind: "confirm"
			readonly note: string
			readonly instruction: string
			readonly keep: NonEmptyReadonlyArray<SqlStatement>
	  }

/** What a candidate renames: the removed relation, field or type it takes away and the added one it becomes, each by its
 * printed name, so `grizzle check` refuses two chosen candidates that take one removed name away or give one added
 * name twice. */
export interface CandidateRenames {
	readonly kind: "relation" | "field" | "type" | "login"
	readonly removed: string
	readonly added: string
}

/** A candidate rename the draft offers, named by every marker of it. A candidate is the plan's index into its list. */
interface Candidate {
	/** `the candidate rename of <from> to <to>`. */
	readonly label: string
	readonly renames: CandidateRenames
	/** The candidates it is chosen only with, by index: a field's rename whose types agree only under a type's rename
	 * requires that type's candidate. */
	readonly requires: ReadonlyArray<number>
}

/** What choosing a candidate does to the statement an offer marks:
 * - `rename`: the candidate's own marker, above the addition it replaces with the rename, what the rename brings
 *   across, and for a relation whose fields change, its columns added and dropped, each pair of a removed and an added
 *   field a nested choice of their own candidate rename;
 * - `rewrite`: the statement runs under the new names;
 * - `delete`: the statement goes: the rename already did what it does;
 * - `convert`: the statement goes, and the candidate's conversion of the column it converts runs in its place: an enum
 *   rebuild's conversion of a removed column the candidate renames with its type changed, so the column is converted
 *   once, there, while the old type stands, whichever way the reviewer decides (`Differ.conversionIn`). */
export type Offer =
	| {
			readonly kind: "rename"
			readonly candidate: number
			readonly note: string
			readonly alternative: NonEmptyReadonlyArray<AlternativeStep>
	  }
	| {
			readonly kind: "rewrite"
			readonly candidate: number
			readonly note: string
			readonly statements: NonEmptyReadonlyArray<SqlStatement>
	  }
	| { readonly kind: "delete"; readonly candidate: number; readonly note: string }
	| {
			readonly kind: "convert"
			readonly candidate: number
			readonly note: string
			readonly conversion: ColumnConversion
	  }

/** A drafted step in its slot; a residual law's validation names its law, one file per law. */
export type Step =
	| { readonly slot: PlainSlot; readonly draft: Draft }
	| { readonly slot: "validate.law"; readonly law: LawId; readonly draft: Draft }

/** A migration plan: what the diff of two snapshots drafts, slot by slot, before the phases group it into files. */
export interface MigrationPlan {
	readonly steps: ReadonlyArray<Step>
	/** The candidate renames the steps' offers choose between. */
	readonly candidates: ReadonlyArray<Candidate>
}

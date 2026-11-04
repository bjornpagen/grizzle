import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"
import type {
	ColumnDef,
	ObjectName,
	RenameColumn,
	RenameObject,
	Select,
	SqlStatement,
	TypeRef
} from "#compiler/sql/ast.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"

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
			readonly type: TypeRef
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
 * and does what that offer says. Each offer is a marker with its commented alternative, above the action. What a
 * choice may offer is fixed by where it stands (`O`): a candidate's own rename only where that candidate may be
 * renamed (TopOffer, RelationOffer), elsewhere only what another rename makes of the action (PlainOffer). */
export interface Choice<O extends Offer> {
	readonly kind: "choice"
	readonly offers: NonEmptyReadonlyArray<O>
	readonly keep: Action
}

/** A schema the migrations directory holds that the configuration no longer lists: its PostgreSQL schema and its
 * directory, as the command line names it. */
export interface AbandonedSchema {
	readonly schema: string
	readonly directory: string
}

/** What a statement that loses stored data loses: a relation with its rows; a field with its values, named by the
 * relation that held it in the previous snapshot (the removed relation, for a field a relation's rename drops); or,
 * when a schema's first migration starts it empty while the migrations directory holds schemas the configuration no
 * longer lists (a schema renamed in code is a new PostgreSQL schema), their rows, left where they are and never
 * migrated again. */
export type Loss =
	| { readonly kind: "relation"; readonly relation: ObjectName }
	| { readonly kind: "field"; readonly relation: ObjectName; readonly field: string }
	| {
			readonly kind: "schema"
			readonly schema: string
			readonly abandoned: NonEmptyReadonlyArray<AbandonedSchema>
	  }

/** A relation's candidate rename: the removed relation and the added one it may be. */
export interface RelationCandidate {
	readonly kind: "relation"
	readonly removed: ObjectName
	readonly added: ObjectName
}

/** A type's candidate rename: an enum's (TYPE) or a domain's (DOMAIN). */
export interface TypeCandidate {
	readonly kind: "type"
	readonly object: "TYPE" | "DOMAIN"
	readonly removed: ObjectName
	readonly added: ObjectName
}

/** A login's candidate rename: the removed login and the added one it may be. */
export interface LoginCandidate {
	readonly kind: "login"
	readonly removed: string
	readonly added: string
}

/** What a field's rename is chosen only with: nothing, or the rename of its removed field's type. */
export type FieldRequires =
	| { readonly kind: "nothing" }
	| { readonly kind: "type"; readonly candidate: TypeCandidate }

/** A field's candidate rename on a relation both snapshots hold. */
export interface FieldCandidate {
	readonly kind: "field"
	readonly relation: ObjectName
	readonly removed: string
	readonly added: string
	readonly requires: FieldRequires
}

/** A field's candidate rename nested in a relation's: it exists only under that rename, whose alternative holds its
 * offer (RelationStep). */
export interface NestedFieldCandidate {
	readonly kind: "nested field"
	readonly parent: RelationCandidate
	readonly removed: string
	readonly added: string
	readonly requires: FieldRequires
}

/** A candidate rename, by what it renames: its identity is its path, its kind and ends, or for a field's rename nested
 * in a relation's, its parent's path and its own two fields. */
export type Candidate =
	| RelationCandidate
	| TypeCandidate
	| LoginCandidate
	| FieldCandidate
	| NestedFieldCandidate

/** The statement a candidate's alternative opens with, which renames what it renames. */
export const headOf = (c: Candidate): RenameObject | RenameColumn => {
	switch (c.kind) {
		case "relation":
			return { kind: "rename", object: "TABLE", name: c.removed, to: c.added.name }
		case "type":
			return { kind: "rename", object: c.object, name: c.removed, to: c.added.name }
		case "login":
			return { kind: "rename", object: "ROLE", name: c.removed, to: c.added }
		case "field":
			return { kind: "renameColumn", table: c.relation, from: c.removed, to: c.added }
		case "nested field":
			return { kind: "renameColumn", table: c.parent.added, from: c.removed, to: c.added }
	}
}

/** The path of a root candidate that renames a whole object: its kind and its ends. */
export interface EndsPath<K extends "relation" | "type" | "login"> {
	readonly kind: K
	readonly removed: string
	readonly added: string
}

/** The path of a field's rename on a relation both snapshots hold: the relation and the two fields. */
export interface FieldPath {
	readonly kind: "field"
	readonly relation: string
	readonly removed: string
	readonly added: string
}

/** The path of a field's rename nested in a relation's: its parent's path and its two fields. */
export interface NestedFieldPath {
	readonly kind: "nested field"
	readonly parent: EndsPath<"relation">
	readonly removed: string
	readonly added: string
}

/** A candidate's path, its identity in printed form, as meta.json names it. Names print quoted, a relation's and a
 * type's schema-qualified. */
export type CandidatePath =
	| EndsPath<"relation">
	| EndsPath<"type">
	| EndsPath<"login">
	| FieldPath
	| NestedFieldPath

export const relationPath = (c: RelationCandidate): EndsPath<"relation"> => ({
	kind: "relation",
	removed: printObjectName(c.removed),
	added: printObjectName(c.added)
})

export const typePath = (c: TypeCandidate): EndsPath<"type"> => ({
	kind: "type",
	removed: printObjectName(c.removed),
	added: printObjectName(c.added)
})

export const pathOf = (c: Candidate): CandidatePath => {
	switch (c.kind) {
		case "relation":
			return relationPath(c)
		case "type":
			return typePath(c)
		case "login":
			return { kind: "login", removed: quoteIdent(c.removed), added: quoteIdent(c.added) }
		case "field":
			return {
				kind: "field",
				relation: printObjectName(c.relation),
				removed: quoteIdent(c.removed),
				added: quoteIdent(c.added)
			}
		case "nested field":
			return {
				kind: "nested field",
				parent: relationPath(c.parent),
				removed: quoteIdent(c.removed),
				added: quoteIdent(c.added)
			}
	}
}

/** Whether two paths name one candidate. */
export const samePath = (a: CandidatePath, b: CandidatePath): boolean => {
	switch (a.kind) {
		case "relation":
		case "type":
		case "login":
			return b.kind === a.kind && b.removed === a.removed && b.added === a.added
		case "field":
			return (
				b.kind === "field" &&
				b.relation === a.relation &&
				b.removed === a.removed &&
				b.added === a.added
			)
		case "nested field":
			return (
				b.kind === "nested field" &&
				samePath(b.parent, a.parent) &&
				b.removed === a.removed &&
				b.added === a.added
			)
	}
}

/** What a candidate renames, end to end, by printed name; a field's ends name the relations that hold it, a nested
 * field's its parent's removed and added relation. */
export interface CandidateEnds {
	readonly kind: "relation" | "type" | "login" | "field"
	readonly removed: string
	readonly added: string
}

const fieldEnd = (relation: string, field: string): string => `${relation}.${field}`

export const pathEnds = (p: CandidatePath): CandidateEnds => {
	switch (p.kind) {
		case "relation":
		case "type":
		case "login":
			return { kind: p.kind, removed: p.removed, added: p.added }
		case "field":
			return {
				kind: "field",
				removed: fieldEnd(p.relation, p.removed),
				added: fieldEnd(p.relation, p.added)
			}
		case "nested field":
			return {
				kind: "field",
				removed: fieldEnd(p.parent.removed, p.removed),
				added: fieldEnd(p.parent.added, p.added)
			}
	}
}

export const endsOf = (c: Candidate): CandidateEnds => pathEnds(pathOf(c))

/** `the candidate rename of <removed> to <added>`, a login's `of login ...`: the one spelling of every label. */
export const endsLabel = (ends: CandidateEnds): string =>
	ends.kind === "login"
		? `the candidate rename of login ${ends.removed} to ${ends.added}`
		: `the candidate rename of ${ends.removed} to ${ends.added}`

export const candidateLabel = (c: Candidate): string => endsLabel(endsOf(c))

/** Whether two candidate ends are rivals: of one kind, taking one removed name away or giving one added name. Two
 * rivals are never both chosen. */
export const rivalEnds = (a: CandidateEnds, b: CandidateEnds): boolean =>
	a.kind === b.kind && (a.removed === b.removed || a.added === b.added)

export const rivals = (a: Candidate, b: Candidate): boolean => rivalEnds(endsOf(a), endsOf(b))

/** A statement that loses stored data, which only the reviewer may decide: drafted commented under its marker, so it
 * runs only once the reviewer writes it in, and left out where a candidate rename that carries the data is chosen
 * instead (its carriers). Until one of the two is chosen, the loss is unresolved, and `grizzle check` and `grizzle
 * migrate` refuse the folder (`lossDecisions`). */
export interface LossDecision {
	readonly kind: "loss"
	readonly loses: Loss
	readonly statement: SqlStatement
	readonly carriers: ReadonlyArray<Candidate>
}

/** What another candidate's choice makes of a drafted action, offered wherever the action stands:
 * - `rewrite`: the statement runs under the new names;
 * - `delete`: the statement goes: the rename already did what it does;
 * - `convert`: the statement goes, and the candidate's conversion of the column it converts runs in its place: an enum
 *   rebuild's conversion of a removed column the candidate renames with its type changed, so the column is converted
 *   once, there, while the old type stands, whichever way the reviewer decides (`Differ.conversionIn`). */
export type PlainOffer =
	| {
			readonly kind: "rewrite"
			readonly candidate: Candidate
			readonly note: string
			readonly statements: NonEmptyReadonlyArray<SqlStatement>
	  }
	| { readonly kind: "delete"; readonly candidate: Candidate; readonly note: string }
	| {
			readonly kind: "convert"
			readonly candidate: Candidate
			readonly note: string
			readonly conversion: ColumnConversion
	  }

/** A step of an alternative that holds no rename of its own (a type's, a login's, a field's, a nested field's): an
 * action, a choice of what other renames make of one, or the loss of a field it drops. */
export type SealedStep = Action | Choice<PlainOffer> | LossDecision

/** A candidate's own offer, above the addition it replaces with the rename: its head (headOf), then its alternative,
 * what the rename brings across, each step decided only where the reviewer takes it:
 * - `rename`: a type's, a login's or a kept relation's field's, whose alternative holds no rename of its own;
 * - `relation rename`: a relation's, whose alternative adds and drops the fields only one side has, each pair of a
 *   removed and an added field a choice of its own `nested rename`;
 * - `nested rename`: a field's rename nested in a relation's, offered only in that relation's alternative. */
export interface RootRename {
	readonly kind: "rename"
	readonly candidate: TypeCandidate | LoginCandidate | FieldCandidate
	readonly note: string
	readonly alternative: ReadonlyArray<SealedStep>
}

export interface RelationRename {
	readonly kind: "relation rename"
	readonly candidate: RelationCandidate
	readonly note: string
	readonly alternative: ReadonlyArray<RelationStep>
}

export interface NestedRename {
	readonly kind: "nested rename"
	readonly candidate: NestedFieldCandidate
	readonly note: string
	readonly alternative: ReadonlyArray<SealedStep>
}

/** What a choice in a relation's alternative offers: a field's rename nested in it, or what another rename makes of
 * the action. */
export type RelationOffer = NestedRename | PlainOffer

/** A step of a relation rename's alternative: an action, a choice a nested field's rename or another rename decides,
 * or the loss of a field it drops. */
export type RelationStep = Action | Choice<RelationOffer> | LossDecision

/** What a choice at the top of a file offers: a root candidate's own rename, or what another rename makes of the
 * action. */
export type TopOffer = RootRename | RelationRename | PlainOffer

/** Every offer, wherever it stands. */
export type Offer = TopOffer | RelationOffer

/** Drafted statements the reviewer confirms under one marker, with no other way drafted: one decision, so the files
 * keep them all, as drafted, or none of them (`splitRenames`). */
export interface Confirm {
	readonly kind: "confirm"
	readonly note: string
	readonly instruction: string
	readonly keep: NonEmptyReadonlyArray<SqlStatement>
}

/** One drafted step's content: an action, a choice, a loss decision, or a confirmed group. */
export type Draft = Action | Choice<TopOffer> | LossDecision | Confirm

/** A drafted step in its slot; a residual law's validation names its law, one file per law. */
export type Step =
	| { readonly slot: PlainSlot; readonly draft: Draft }
	| { readonly slot: "validate.law"; readonly law: LawId; readonly draft: Draft }

/** A migration plan: what the diff of two snapshots drafts, slot by slot, before the phases group it into files. Its
 * candidate renames are its rename offers (candidatesOf). */
export interface MigrationPlan {
	readonly steps: ReadonlyArray<Step>
}

/** The candidates whose own rename offer a step holds, those nested in a relation's alternative included, in draft
 * order. */
export const draftCandidates = (d: Draft | RelationStep): ReadonlyArray<Candidate> =>
	d.kind === "choice" ? d.offers.flatMap((o: Offer) => offerCandidates(o)) : []

/** The candidates whose own rename offer an offer is, a relation rename's nested ones after it. */
const offerCandidates = (o: Offer): ReadonlyArray<Candidate> => {
	switch (o.kind) {
		case "rename":
		case "nested rename":
			return [o.candidate]
		case "relation rename":
			return [o.candidate, ...o.alternative.flatMap((x) => draftCandidates(x))]
		case "rewrite":
		case "delete":
		case "convert":
			return []
	}
}

/** Every candidate rename a plan offers: each rename offer's candidate, in step order. */
export const candidatesOf = (plan: MigrationPlan): ReadonlyArray<Candidate> =>
	plan.steps.flatMap((s) => draftCandidates(s.draft))

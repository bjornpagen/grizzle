import {
	concatNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Lines } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type Action,
	alterationStatement,
	type Draft,
	type Loss,
	type LossDecision,
	type RetypeReason,
	type SetAside
} from "#compiler/deploy/diff/plan.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import { filed } from "#compiler/deploy/render/filed.ts"
import type { DraftedFile, DraftedStep, MetaLosses } from "#compiler/deploy/render/folder.ts"
import {
	confirmMarker,
	lossMarker,
	noTransactionMarker,
	placeholderMarker
} from "#compiler/deploy/render/markers.ts"
import { violationCheck } from "#compiler/physical/ddl/recheck.ts"
import type {
	AlterTableAction,
	ColumnDef,
	ObjectName,
	PlBlock,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { binary, call, cast, core, lit, tableCol, types } from "#compiler/sql/build.ts"
import type { GenerationAnchor } from "#compiler/sql/generation.ts"
import {
	commandsOf,
	commented,
	placeholderToken,
	printCommands,
	printExpr,
	printObjectName,
	printStatement,
	printType,
	sqlChunks,
	sqlText,
	statementText,
	writeDoBlock
} from "#compiler/sql/print.ts"

/** What a loss loses, as its marker and `grizzle check` name it (meta.json records it as data, MetaLosses). */
const lossesOf = (loses: Loss): MetaLosses => ({
	kind: "schema",
	schema: quoteIdent(loses.schema),
	abandoned: mapNonEmpty(loses.abandoned, (a) => ({
		schema: quoteIdent(a.schema),
		directory: a.directory
	}))
})

/** A loss's marker, saying what it loses, and the instruction line: how to decide it. The statement follows,
 * commented. */
const lossHead = (out: Lines, loss: LossDecision): void => {
	const schema = quoteIdent(loss.loses.schema)
	const many = loss.loses.abandoned.length > 1
	const left = loss.loses.abandoned
		.map((a) => `${quoteIdent(a.schema)} (${a.directory})`)
		.join(", ")
	out.line(
		`${lossMarker}: the statement below starts the schema ${schema} empty, and the configuration no longer lists the schema${many ? "s" : ""} ${left}, whose rows stay where they are, never migrated again: a schema renamed in code is a new PostgreSQL schema.`
	)
	out.line(
		`-- To start ${schema} empty, uncomment the statement below; to keep the rows, keep the schema's old name and delete this folder. grizzle never decides a loss for you.`
	)
}

const spelledLoc = SourceLoc("drafted statement", [])

/** A command's lines as its file holds them (filed), the last ending in its terminator. */
const terminated = (out: Lines, write: (out: Lines) => void): void => {
	const lines = filed(sqlText(spelledLoc, write)).split("\n")
	for (const [i, line] of lines.entries()) {
		out.line(i === lines.length - 1 ? `${line};` : line)
	}
}

/** A statement as a drafted file writes it: its commands (commandsOf), each ending in its terminator. */
const statementLines = (out: Lines, statement: SqlStatement): void => {
	for (const command of commandsOf(statement)) {
		terminated(out, command)
	}
}

/**
 * One command as a drafted file spells it: the comment lines above it, and the writer of its lines from its first
 * token, the text meta.json records (spelledText), which the file ends with its terminator. A statement of several
 * commands (sql/print.ts commandsOf: one behind the database lock) is as many, so the file's statements, split where
 * PostgreSQL's scanner ends each (render/markers.ts splitStatements), are the record's one for one.
 */
interface Spelled {
	readonly above: ReadonlyArray<string>
	readonly write: (out: Lines) => void
}

/**
 * A spelled statement's text from its first token, without its terminator, as its file holds it (filed): what
 * meta.json records, and what the migration runner sends (sql/print.ts statementText).
 */
const spelledText = (s: Spelled): string => filed(statementText(spelledLoc, s.write))

/**
 * One statement an action drafts, spelled once for its file and its record (spellFile): the comment lines above it and
 * its text from its first token (spelledText), which meta.json records and the file writes, its last line ending in its
 * terminator.
 */
interface SpelledStatement {
	readonly above: ReadonlyArray<string>
	readonly text: string
}

/** A spelled statement as its file holds it: the lines above it, then its text's lines, the last ending in `;`. */
const spelledLines = (out: Lines, s: SpelledStatement): void => {
	for (const line of s.above) {
		out.line(line)
	}
	const lines = s.text.split("\n")
	for (const [i, line] of lines.entries()) {
		out.line(i === lines.length - 1 ? `${line};` : line)
	}
}

/** `statement`'s commands as the file spells them (commandsOf), the comment lines `above` its first. */
const spelled = (
	above: ReadonlyArray<string>,
	statement: SqlStatement
): NonEmptyReadonlyArray<Spelled> => {
	const [first, ...rest] = commandsOf(statement)
	return [{ above, write: first }, ...rest.map((write): Spelled => ({ above: [], write }))]
}

const bare = (statement: SqlStatement): NonEmptyReadonlyArray<Spelled> => spelled([], statement)

/** What a retype's placeholder marker asks of the reviewer, by why no cast converts the column: for other values, the
 * expression from the value before, the cast its example; for a code that names a handle only under a roster the
 * conversion leaves, the expression from what each value means, never the cast, which reads it as another handle. */
const retypeAdvice: { readonly [R in RetypeReason]: (column: ColumnDef) => string } = {
	values: (column) =>
		`replace the placeholder below with the expression computing it from the column's value before the conversion, such as ${printExpr(cast(tableCol(column.name), column.type))}`,
	roster: () =>
		"a closed id's or a set's code names a handle only under its own roster, which this conversion leaves, so a cast would read each value as another handle or a bare number: replace the placeholder below with the expression computing each row's new value from what its value before means"
}

/** The marker a placeholder column `column` of an alteration of `table` drafts above it: what the reviewer supplies
 * there, and how. */
const placeholderNote = (table: ObjectName, column: ColumnDef): string =>
	`${placeholderMarker}: every existing row of ${printObjectName(table)} needs a value for the new column ${quoteIdent(column.name)} (${printType(column.type)}); replace the placeholder below with it, or with any value and compute the real one by an UPDATE written right after the SET CONSTRAINTS ALL IMMEDIATE below, which every data step follows; then delete this line.`

/** The marker a set-aside field of a fill of `table` drafts above the fill's UPDATE: the value its set-aside column takes,
 * and how a value joins another row. */
const fillNote = (table: ObjectName, f: SetAside): string =>
	`${placeholderMarker}: every row of ${printObjectName(table)} needs ${quoteIdent(f.column.name)} as ${printType(f.column.type)} in its set-aside column ${quoteIdent(f.aside)}, which takes the field's name below; ${retypeAdvice[f.reason](f.column)}: the row is "t", its old ${quoteIdent(f.column.name)} still standing, and the last value may be followed by the FROM and WHERE the values join; then delete this line.`

/** The columns an alteration's subcommands add at a placeholder (sql/ast.ts addColumnPlaceholder), in its order. */
const placeholdersOf = (actions: ReadonlyArray<AlterTableAction>): ReadonlyArray<ColumnDef> =>
	actions.flatMap((a) => (a.kind === "addColumnPlaceholder" ? [a.column] : []))

/** A fill's UPDATE of `table`: its anchor assigned its own value where it has one (plan.ts Action `fill`), then each
 * set-aside column at its placeholder, one assignment a line, the last free to be followed by a FROM. */
const writeFill = (
	out: Lines,
	table: ObjectName,
	fields: NonEmptyReadonlyArray<SetAside>,
	anchor: GenerationAnchor | undefined
): void => {
	out.line(`UPDATE ${printObjectName(table)} AS ${quoteIdent("t")}`)
	out.line("SET")
	const assignments = out.nested()
	if (anchor !== undefined) {
		assignments.line(
			`${quoteIdent(anchor.column)} = ${quoteIdent("t")}.${quoteIdent(anchor.column)},`
		)
	}
	for (const [i, f] of fields.entries()) {
		assignments.line(
			`${quoteIdent(f.aside)} = ${placeholderToken}${i === fields.length - 1 ? "" : ","}`
		)
	}
}

/** The statements a table's alteration drafts: its one ALTER TABLE, under a marker for each placeholder column it
 * holds, in its order; then, when it adds one, one ALTER TABLE dropping each such column's DEFAULT. A reviewer's UPDATE
 * of the column goes among the data steps, after SET CONSTRAINTS ALL IMMEDIATE (deploy/diff/diff.ts checkedAtOnce). */
const spellAlteration = (
	table: ObjectName,
	actions: NonEmptyReadonlyArray<AlterTableAction>
): NonEmptyReadonlyArray<Spelled> => {
	const placeholders = placeholdersOf(actions)
	const dropped = placeholders.map((c) => c.name)
	const alteration = spelled(
		placeholders.map((c) => placeholderNote(table, c)),
		alterationStatement(table, actions)
	)
	return isNonEmpty(dropped)
		? concatNonEmpty(
				alteration,
				bare({
					kind: "alterTable",
					table,
					actions: mapNonEmpty(dropped, (column) => ({ kind: "dropDefault", column }))
				})
			)
		: alteration
}

/**
 * A zone roster's check, the DO block a migration runs it by: one PERFORM that reads each of its handles as a time zone,
 * `timezone('<zone>'::text, <the epoch>)`, so PostgreSQL itself refuses the first handle its tzdata names no zone of,
 * 22023 (time zone "…" not recognized), and the file rolls back before anything changes. The epoch is a timestamptz made
 * with no zone looked up, `timezone('0 seconds'::interval, '1970-01-01'::date + '0 seconds'::interval)`.
 */
const zoneCheck = (zones: NonEmptyReadonlyArray<string>): PlBlock => {
	const none = lit.text("0 seconds", types.interval)
	const epoch = call("timezone", [none, binary("+", lit.text("1970-01-01", types.date), none)])
	return {
		declare: [],
		body: [
			{
				kind: "perform",
				query: {
					body: core(
						mapNonEmpty(zones, (zone) => ({
							expr: call("timezone", [lit.text(zone, types.text), epoch]),
							alias: undefined
						})),
						[],
						undefined
					),
					orderBy: [],
					limit: undefined,
					offset: undefined
				}
			}
		]
	}
}

/** The statements an action drafts, in order, as the file spells them: every action drafts one at least. */
const spellAction = (action: Action): NonEmptyReadonlyArray<Spelled> => {
	switch (action.kind) {
		case "statement":
			return bare(action.statement)
		case "alteration":
			return spellAlteration(action.table, action.actions)
		case "fill":
			return [
				{
					above: action.fields.map((f) => fillNote(action.table, f)),
					write: (out) => writeFill(out, action.table, action.fields, action.anchor)
				}
			]
		case "violation":
			return [
				{
					above: [`-- The full violation query of law ${action.law}.`],
					write: (out) => writeDoBlock(out, violationCheck(action.law, action.query))
				}
			]
		case "zones":
			return [
				{
					above: [
						`-- The time zones of roster ${action.roster}, each read by the server's tzdata.`
					],
					write: (out) => writeDoBlock(out, zoneCheck(action.zones))
				}
			]
	}
}

/**
 * A draft spelled for its file and its record (spellFile): an action's statements, each spelled once
 * (SpelledStatement), which the file writes and meta.json records alike; a confirm or a loss as drafted, which each
 * writes in its own form.
 */
type SpelledDraft =
	| { readonly kind: "spelled"; readonly statements: NonEmptyReadonlyArray<SpelledStatement> }
	| {
			readonly kind: "drafted"
			readonly draft: Extract<Draft, { readonly kind: "confirm" | "loss" }>
	  }

/** A draft spelled (SpelledDraft): an action's statements each printed and filed once. */
const spellDraft = (draft: Draft): SpelledDraft => {
	switch (draft.kind) {
		case "statement":
		case "alteration":
		case "fill":
		case "violation":
		case "zones":
			return {
				kind: "spelled",
				statements: mapNonEmpty(spellAction(draft), (x) => ({
					above: x.above,
					text: spelledText(x)
				}))
			}
		case "confirm":
		case "loss":
			return { kind: "drafted", draft }
	}
}

/**
 * A drafted file spelled once for its text and its decision record (renderFile, recordFile): each draft's statements
 * printed and filed once, where the file and meta.json each printed and filed every statement.
 */
export interface SpelledFile {
	readonly file: DraftFile
	readonly drafts: ReadonlyArray<SpelledDraft>
}

/** A drafted file spelled (SpelledFile); a statement past PostgreSQL's longest message refused as meta.json refuses it. */
export const spellFile = (file: DraftFile): Result.Result<SpelledFile, CompileError> =>
	catchRefusal(() => ({ file, drafts: file.drafts.map(spellDraft) }))

const renderDraft = (out: Lines, spelledDraft: SpelledDraft): void => {
	if (spelledDraft.kind === "spelled") {
		for (const s of spelledDraft.statements) {
			spelledLines(out, s)
		}
		return
	}
	const draft = spelledDraft.draft
	switch (draft.kind) {
		case "confirm":
			out.line(`${confirmMarker}: ${draft.note}.`)
			out.line(`-- ${draft.instruction}.`)
			for (const k of draft.keep) {
				out.line("")
				statementLines(out, k)
			}
			return
		case "loss":
			lossHead(out, draft)
			return statementLines(commented(out), draft.statement)
	}
}

/** The text of one drafted file.
 *
 * Rendering a drafted file's text.
 *
 * Every SQL statement is written by the printer (print.ts) into the file's one line sink, from the SQL AST, whose
 * constructors keep identifiers quoted, literals and parameters cast and no NULL (checked by the test kernel's
 * structural audit, never here). A few drafted forms are fixed templates around printed pieces, because they are
 * reviewer-facing or the SQL AST has no form for them:
 *
 * - a table's alteration holding placeholders: a marker line for each above its one ALTER TABLE, whose ADD COLUMN takes
 *   the placeholder as its default (sql/ast.ts addColumnPlaceholder) or whose ALTER COLUMN ... TYPE takes it as its
 *   USING (sql/ast.ts Using), a field converted in place; then the DROP DEFAULT of each column added at a placeholder,
 *   which follows the reviewer's value;
 * - a violation check: a DO block that reads the violation query whole and raises when it found a row (sql/build.ts
 *   whenFound), SQLSTATE 23000 with the law's identity as the constraint name, as the law function itself does, so a
 *   violating Validate file rolls back with the law's identity;
 * - a confirm's marker and its statements;
 * - a loss's marker, saying what it loses and how to decide it, above its statement commented the same way.
 *
 * Statements end with `;` and are separated by a blank line. A no-transaction file's first line is the marker. The
 * file's text is its chunks (sql/print.ts sqlChunks), never joined, so no length bounds it. */
export const renderFile = (file: SpelledFile): Result.Result<TextChunks, CompileError> =>
	catchRefusal(() =>
		sqlChunks((out) => {
			if (!file.file.transaction) {
				out.line(noTransactionMarker)
				out.line("")
			}
			for (const [i, d] of file.drafts.entries()) {
				if (i > 0) {
					out.line("")
				}
				renderDraft(out, d)
			}
			out.line("")
		})
	)

/** A drafted step as generate proves its record over it (render/folder.ts provedRecord), every statement it drafts in
 * its place, as the file spells it from its first token: an action's statements one by one; a loss with what it loses;
 * a confirmed group. */
const recordStep = (spelledDraft: SpelledDraft): ReadonlyArray<DraftedStep> => {
	if (spelledDraft.kind === "spelled") {
		return spelledDraft.statements.map((x): DraftedStep => ({
			kind: "statement",
			statement: x.text
		}))
	}
	const d = spelledDraft.draft
	switch (d.kind) {
		case "confirm":
			return [
				{
					kind: "confirm",
					statements: flatMapNonEmpty(d.keep, (k) => mapNonEmpty(printCommands(k), (c) => filed(c)))
				}
			]
		case "loss":
			return [
				{ kind: "loss", loses: lossesOf(d.loses), statement: filed(printStatement(d.statement)) }
			]
	}
}

/** One drafted file's decision record, every statement by its text, which meta.json records once generate proved it
 * (render/folder.ts provedRecord): every step it drafts, in draft order, and its lock demand, `locks`
 * (deploy/locks/demand.ts fileLockSets). */
export const recordFile = (
	file: SpelledFile,
	locks: number
): Result.Result<DraftedFile, CompileError> =>
	catchRefusal(() => ({
		name: file.file.name,
		steps: file.drafts.flatMap((d) => recordStep(d)),
		locks
	}))

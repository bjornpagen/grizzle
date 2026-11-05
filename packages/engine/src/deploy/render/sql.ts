import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Lines } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Action, Draft, Loss, LossDecision } from "#compiler/deploy/diff/plan.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import type { MetaFile, MetaLosses, MetaStep } from "#compiler/deploy/render/folder.ts"
import {
	confirmMarker,
	lossMarker,
	noTransactionMarker,
	placeholderMarker
} from "#compiler/deploy/render/markers.ts"
import type { PlBlock, SqlStatement } from "#compiler/sql/ast.ts"
import { cast, exists, lit, tableCol, types } from "#compiler/sql/build.ts"
import {
	commented,
	printExpr,
	printObjectName,
	printStatement,
	printType,
	quoteIdent,
	sqlText,
	statementText,
	terminated,
	writeDoBlock,
	writeStatement
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

/** A statement as a drafted file writes it: its lines, the last ending in its terminator. */
const statementLines = (out: Lines, statement: SqlStatement): void =>
	terminated(out, (lines) => writeStatement(lines, statement))

/**
 * One statement as a drafted file spells it: the comment lines above it, and the writer of its lines from its first
 * token, the text meta.json records (spelledText), which the file ends with its terminator.
 */
interface Spelled {
	readonly above: ReadonlyArray<string>
	readonly write: (out: Lines) => void
}

const spelledLoc = SourceLoc("drafted statement", [])

/**
 * A spelled statement's text from its first token, without its terminator: what meta.json records, and what the
 * migration runner sends (sql/print.ts statementText).
 */
const spelledText = (s: Spelled): string => statementText(spelledLoc, s.write)

const spelledLines = (out: Lines, s: Spelled): void => {
	for (const line of s.above) {
		out.line(line)
	}
	terminated(out, s.write)
}

const bare = (statement: SqlStatement): Spelled => ({
	above: [],
	write: (out) => writeStatement(out, statement)
})

/** A statement printed on its one line, then rewritten: a placeholder draft's ALTER TABLE of one action. */
const oneLine = (above: ReadonlyArray<string>, text: string): Spelled => ({
	above,
	write: (out) => out.line(text)
})

/** The statements an action drafts, in order, as the file spells them: every action drafts one at least. */
const spellAction = (action: Action): NonEmptyReadonlyArray<Spelled> => {
	switch (action.kind) {
		case "statement":
			return [bare(action.statement)]
		case "placeholderColumn": {
			return [
				{
					above: [
						`${placeholderMarker}: every existing row of ${printObjectName(action.table)} needs a value for the new column ${quoteIdent(action.column.name)} (${printType(action.column.type)}); replace the placeholder below with it, optionally compute the real value with an UPDATE before the DROP DEFAULT, and delete this line.`
					],
					write: (out) =>
						writeStatement(out, {
							kind: "alterTable",
							table: action.table,
							actions: [{ kind: "addColumnPlaceholder", column: action.column }]
						})
				},
				bare({
					kind: "alterTable",
					table: action.table,
					actions: [{ kind: "dropDefault", column: action.column.name }]
				})
			]
		}
		case "placeholderRetype": {
			const column = action.column
			return [
				{
					above: [
						`${placeholderMarker}: every row of ${printObjectName(action.table)} needs ${quoteIdent(column.name)} converted in place to ${printType(column.type)}; replace the placeholder below with the expression computing it from the column's value before the conversion, such as ${printExpr(cast(tableCol(column.name), column.type))}, and delete this line.`
					],
					write: (out) =>
						writeStatement(out, {
							kind: "alterTable",
							table: action.table,
							actions: [
								{
									kind: "alterColumnType",
									column: column.name,
									type: column.type,
									collation: column.collation,
									using: { kind: "placeholder" }
								}
							]
						})
				}
			]
		}
		case "violation": {
			const block: PlBlock = {
				declare: [],
				body: [
					{
						kind: "if",
						branches: [
							{
								condition: exists(action.query),
								body: [
									{
										kind: "raise",
										message: `law ${action.law} is violated by existing rows`,
										using: [
											{
												option: "ERRCODE",
												value: lit.text("integrity_constraint_violation", types.text)
											},
											{ option: "CONSTRAINT", value: lit.text(action.law, types.text) }
										]
									}
								]
							}
						],
						else: []
					}
				]
			}
			return [
				{
					above: [`-- The full violation query of law ${action.law}.`],
					write: (out) => writeDoBlock(out, block)
				}
			]
		}
		case "analyze":
			return [oneLine([], `ANALYZE ${printObjectName(action.table)}`)]
		case "dropStatistics":
			return [oneLine([], `DROP STATISTICS ${printObjectName(action.name)}`)]
	}
}

const renderDraft = (out: Lines, draft: Draft): void => {
	switch (draft.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
			for (const s of spellAction(draft)) {
				spelledLines(out, s)
			}
			return
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
 * - a placeholder column: the ADD COLUMN statement whose default is the placeholder (sql/ast.ts addColumnPlaceholder),
 *   then the DROP DEFAULT that follows the reviewer's value;
 * - a placeholder conversion: the ALTER COLUMN ... TYPE statement whose USING is the placeholder (sql/ast.ts Using): a
 *   field converted in place;
 * - a violation check: a DO block whose condition is the violation query, raising SQLSTATE 23000 with the law's
 *   identity as the constraint name, as the law function itself does, so a violating Validate file rolls back with the
 *   law's identity;
 * - `ANALYZE <table>` and `DROP STATISTICS <name>`;
 * - a confirm's marker and its statements;
 * - a loss's marker, saying what it loses and how to decide it, above its statement commented the same way.
 *
 * Statements end with `;` and are separated by a blank line. A no-transaction file's first line is the marker. A file
 * past V8's longest string is refused as ResourceBound (stringLength). */
export const renderFile = (file: DraftFile): Result.Result<string, CompileError> =>
	catchRefusal(() =>
		sqlText(SourceLoc("drafted file", [file.name]), (out) => {
			if (!file.transaction) {
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

/** A drafted step as meta.json records it, every statement it drafts in its place, as the file spells it from its first
 * token: an action's statements one by one; a loss with what it loses; a confirmed group. */
const recordStep = (d: Draft): ReadonlyArray<MetaStep> => {
	switch (d.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return spellAction(d).map((x): MetaStep => ({ kind: "statement", statement: spelledText(x) }))
		case "confirm":
			return [{ kind: "confirm", statements: mapNonEmpty(d.keep, (k) => printStatement(k)) }]
		case "loss":
			return [{ kind: "loss", loses: lossesOf(d.loses), statement: printStatement(d.statement) }]
	}
}

/** One drafted file's decision record, as meta.json records it: every step it drafts, in draft order. */
export const recordFile = (file: DraftFile): Result.Result<MetaFile, CompileError> =>
	catchRefusal(() => ({
		name: file.name,
		steps: file.drafts.flatMap((d) => recordStep(d))
	}))

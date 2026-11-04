import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { inlineText, type Lines } from "#compiler/core/lines.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	type Action,
	type AlternativeStep,
	type Choice,
	type Confirm,
	candidateLabel,
	type Draft,
	type FieldRequires,
	headOf,
	type Loss,
	type LossDecision,
	type Offer,
	type PlainOffer,
	pathOf,
	type RelationOffer,
	type RootRename,
	relationPath,
	type SealedStep,
	type TopOffer,
	typePath
} from "#compiler/deploy/diff/plan.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import type {
	MetaFile,
	MetaLosses,
	MetaNestedRename,
	MetaPlainOffer,
	MetaRequires,
	MetaRootRenames,
	MetaSealedStep,
	MetaStepOf,
	MetaTopOffer
} from "#compiler/deploy/render/folder.ts"

import {
	lossMarker,
	noTransactionMarker,
	placeholderMarker,
	renameMarker
} from "#compiler/deploy/render/markers.ts"
import type { ColumnDef, PlBlock, SqlStatement } from "#compiler/sql/ast.ts"
import { cast, exists, lit, tableCol, types } from "#compiler/sql/build.ts"
import {
	commented,
	printExpr,
	printObjectName,
	printStatement,
	printType,
	quoteIdent,
	quoteString,
	sqlText,
	terminated,
	writeDoBlock,
	writeStatement
} from "#compiler/sql/print.ts"

/** The instruction line below each kind of offer's marker: what a person does to keep or choose it. */
const renameInstruction =
	"-- Keep the drafted statements and delete this line, or replace the addition below with this rename and delete this line:"

export const offerInstruction: { readonly [K in Offer["kind"]]: string } = {
	rename: renameInstruction,
	"relation rename": renameInstruction,
	"nested rename": renameInstruction,
	rewrite:
		"-- Keep the statement below and delete this line, or, choosing the rename, replace it with this one and delete this line:",
	delete: "-- Keep the statement below and delete this line, or, choosing the rename, delete both.",
	convert:
		"-- Keep the statement below and delete this line, or, choosing the rename, replace it with this conversion and delete this line:"
}

/** What a loss loses, as its marker and `grizzle check` name it (meta.json records it as data, MetaLosses). */
const lossesOf = (loses: Loss): MetaLosses => {
	switch (loses.kind) {
		case "relation":
			return { kind: "relation", relation: printObjectName(loses.relation) }
		case "field":
			return {
				kind: "field",
				relation: printObjectName(loses.relation),
				field: quoteIdent(loses.field)
			}
		case "schema":
			return {
				kind: "schema",
				schema: quoteIdent(loses.schema),
				abandoned: mapNonEmpty(loses.abandoned, (a) => ({
					schema: quoteIdent(a.schema),
					directory: a.directory
				}))
			}
	}
}

/** A loss's marker, saying what it loses and which candidates carry it instead, and the instruction line: how to decide
 * it either way. The statement follows, commented. */
const lossHead = (out: Lines, loss: LossDecision): void => {
	const carried =
		loss.carriers.length === 0
			? ""
			: `; ${loss.carriers.map((c) => candidateLabel(c)).join(", or ")} carries them instead`
	const keep =
		loss.carriers.length === 0
			? "no candidate rename carries them"
			: "to keep them, choose a candidate rename that carries them and leave the statement commented"
	switch (loss.loses.kind) {
		case "relation":
			out.line(
				`${lossMarker}: the statement below drops the relation ${printObjectName(loss.loses.relation)} with its rows${carried}.`
			)
			return out.line(
				`-- To drop it with its rows, uncomment the statement below; ${keep}${loss.carriers.length === 0 ? "; if an added relation is this one renamed with more changes, rename it alone first, choose its candidate, and change the rest in a later migration" : ""}. grizzle never decides a loss for you.`
			)
		case "field":
			out.line(
				`${lossMarker}: the statement below drops the field ${printObjectName(loss.loses.relation)}.${quoteIdent(loss.loses.field)} with its values${carried}.`
			)
			return out.line(
				`-- To drop it with its values, uncomment the statement below; ${keep}. grizzle never decides a loss for you.`
			)
		case "schema": {
			const schema = quoteIdent(loss.loses.schema)
			const many = loss.loses.abandoned.length > 1
			const left = loss.loses.abandoned
				.map((a) => `${quoteIdent(a.schema)} (${a.directory})`)
				.join(", ")
			out.line(
				`${lossMarker}: the statement below starts the schema ${schema} empty, and the configuration no longer lists the schema${many ? "s" : ""} ${left}, whose rows stay where they are, never migrated again: a schema renamed in code is a new PostgreSQL schema.`
			)
			return out.line(
				`-- To start ${schema} empty, uncomment the statement below; to keep the rows, keep the schema's old name and delete this folder. grizzle never decides a loss for you.`
			)
		}
	}
}

/** A statement as a drafted file writes it: its lines, the last ending in its terminator. */
const statementLines = (out: Lines, statement: SqlStatement): void =>
	terminated(out, (lines) => writeStatement(lines, statement))

/** A candidate's marker, the instruction for the statement below it, and the commented alternative, if any: a rename's
 * head first, then its alternative's steps. */
const renderOffer = (out: Lines, offer: Offer): void => {
	out.line(`${renameMarker}: ${offer.note}.`)
	out.line(offerInstruction[offer.kind])
	switch (offer.kind) {
		case "rename":
		case "relation rename":
		case "nested rename": {
			const alternative = commented(out)
			statementLines(alternative, headOf(offer.candidate))
			for (const a of offer.alternative) {
				renderDraft(alternative, a)
			}
			return
		}
		case "rewrite": {
			const alternative = commented(out)
			for (const s of offer.statements) {
				statementLines(alternative, s)
			}
			return
		}
		case "delete":
			return
		case "convert":
			return renderDraft(commented(out), offer.conversion)
	}
}

/**
 * One statement as a drafted file spells it: the comment lines above it, and the writer of its lines from its first
 * token, the text meta.json records (spelledText), which the file ends with its terminator.
 */
interface Spelled {
	readonly above: ReadonlyArray<string>
	readonly write: (out: Lines) => void
}

const spelledLoc = SourceLoc("drafted statement", [])

/** A spelled statement's text from its first token, without its terminator: what meta.json records. */
const spelledText = (s: Spelled): string => sqlText(spelledLoc, s.write)

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
			const hint = action.hint
			const named = (removed: ReadonlyArray<ColumnDef>) =>
				`The removed column${removed.length === 1 ? "" : "s"} ${removed.map((r) => `${quoteIdent(r.name)} (${printType(r.type)})`).join(", ")}`
			const update = (from: ColumnDef): string =>
				inlineText((row) =>
					writeStatement(row, {
						kind: "update",
						with: undefined,
						table: action.table,
						alias: "r1",
						set: [
							{ column: action.column.name, value: cast(tableCol(from.name), action.column.type) }
						],
						from: [],
						where: undefined,
						returning: []
					})
				)
			const renamed =
				hint.kind === "none"
					? ""
					: ` ${named(hint.removed)} ${hint.removed.length === 1 ? "is" : "are"} dropped after it: if the new column is one renamed, compute it from that one before the drop, such as ${update(hint.removed[0])}.`
			return [
				{
					above: [
						`${placeholderMarker}: every existing row of ${printObjectName(action.table)} needs a value for the new column ${quoteIdent(action.column.name)} (${printType(action.column.type)}); replace the placeholder below with it, optionally compute the real value with an UPDATE before the DROP DEFAULT, and delete this line.${renamed}`
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
		case "placeholderHandles": {
			const column = quoteIdent(action.column)
			const [first] = action.labels
			const asText = cast(tableCol(action.column), types.text)
			const example = printExpr(
				cast(
					{
						kind: "case",
						operand: asText,
						whens: mapNonEmpty(action.removed, (h) => ({
							when: lit.text(h, types.text),
							result: lit.text(first, types.text)
						})),
						else: asText
					},
					action.type
				)
			)
			return [
				{
					above: [
						`${placeholderMarker}: every row of ${printObjectName(action.table)} holding a removed handle (${action.removed.map((h) => quoteString(h)).join(", ")}) in ${column} needs one of the new roster (${action.labels.map((h) => quoteString(h)).join(", ")}); replace the placeholder below with the expression converting the column, such as ${example}, and delete this line.`
					],
					write: (out) =>
						writeStatement(out, {
							kind: "alterTable",
							table: action.table,
							actions: [
								{
									kind: "alterColumnType",
									column: action.column,
									type: action.type,
									using: { kind: "placeholder" },
									collation: undefined
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

/** The statements an action drafts, from their first tokens, as meta.json records them. */
const actionStatements = (action: Action): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(spellAction(action), spelledText)

const renderDraft = (out: Lines, draft: Draft | AlternativeStep): void => {
	switch (draft.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
			for (const s of spellAction(draft)) {
				spelledLines(out, s)
			}
			return
		case "choice":
			for (const o of draft.offers) {
				renderOffer(out, o)
				out.line("")
			}
			return renderDraft(out, draft.keep)
		case "confirm":
			out.line(`${renameMarker}: ${draft.note}.`)
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
 *   field converted in place, or a column of a rebuilt roster;
 * - a violation check: a DO block whose condition is the violation query, raising SQLSTATE 23000 with the law's
 *   identity as the constraint name, as the law function itself does, so a violating Validate file rolls back with the
 *   law's identity;
 * - `ANALYZE <table>` and `DROP STATISTICS <name>`;
 * - a candidate rename's marker and commented alternative, every physical line of each statement behind `-- `, above
 *   the statement it decides;
 * - a loss's marker, saying what it loses and how to decide it, above its statement commented the same way.
 *
 * Statements end with `;` and are separated by a blank line. A no-transaction file's first line is the marker. A file
 * past JavaScript's longest string is refused as ResourceBound (text). */
export const renderFile = (file: DraftFile): Result.Result<string, CompileError> =>
	catchRefusal(() =>
		sqlText(SourceLoc("drafted file", [file.name]), (out) => {
			if (!file.transaction) {
				out.line(noTransactionMarker)
			}
			if (file.scope.kind !== "slots") {
				out.line(
					`-- Validate law ${file.scope.law}: its triggers and its violation query, under a lock excluding every writer to its tables.`
				)
			}
			if (!file.transaction || file.scope.kind !== "slots") {
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

/** What a field's rename requires, as meta.json records it: nothing, or the type's rename by its path. */
const requiresOf = (r: FieldRequires): MetaRequires =>
	r.kind === "nothing" ? r : typePath(r.candidate)

/** What a root rename that is no relation's renames, as meta.json records it. */
const rootRenames = (c: RootRename["candidate"]): MetaRootRenames => {
	switch (c.kind) {
		case "type": {
			const path = typePath(c)
			return { kind: "type", object: c.object, removed: path.removed, added: path.added }
		}
		case "login":
			return { kind: "login", removed: quoteIdent(c.removed), added: quoteIdent(c.added) }
		case "field":
			return {
				kind: "field",
				relation: printObjectName(c.relation),
				removed: quoteIdent(c.removed),
				added: quoteIdent(c.added),
				requires: requiresOf(c.requires)
			}
	}
}

/** What another candidate's choice makes of a statement, as meta.json records it: a rewrite's or a conversion's
 * statements replacing it, or its deletion. */
const recordPlain = (o: PlainOffer): MetaPlainOffer => {
	switch (o.kind) {
		case "rewrite":
			return {
				kind: "replace",
				candidate: pathOf(o.candidate),
				statements: mapNonEmpty(o.statements, (x) => printStatement(x))
			}
		case "convert":
			return {
				kind: "replace",
				candidate: pathOf(o.candidate),
				statements: actionStatements(o.conversion)
			}
		case "delete":
			return { kind: "delete", candidate: pathOf(o.candidate) }
	}
}

/** An alternative that holds no rename of its own, as meta.json records it. */
const recordSealed = (steps: ReadonlyArray<SealedStep>): ReadonlyArray<MetaSealedStep> =>
	steps.flatMap((a) => recordStep(a, recordPlain))

/** A relation rename's alternative, as meta.json records it: each field's rename nested in it with its head. */
const recordRelationOffer = (o: RelationOffer): MetaNestedRename | MetaPlainOffer => {
	switch (o.kind) {
		case "nested rename":
			return {
				kind: "nested rename",
				removed: quoteIdent(o.candidate.removed),
				added: quoteIdent(o.candidate.added),
				requires: requiresOf(o.candidate.requires),
				head: printStatement(headOf(o.candidate)),
				alternative: recordSealed(o.alternative)
			}
		case "rewrite":
		case "convert":
		case "delete":
			return recordPlain(o)
	}
}

/** An offer at the top of a file as meta.json records it: a root's rename with its head and its alternative, a
 * relation's with its nested fields' renames, or what another candidate's choice makes of the statement. */
const recordTop = (o: TopOffer): MetaTopOffer => {
	switch (o.kind) {
		case "rename":
			return {
				kind: "rename",
				renames: rootRenames(o.candidate),
				head: printStatement(headOf(o.candidate)),
				alternative: recordSealed(o.alternative)
			}
		case "relation rename": {
			const path = relationPath(o.candidate)
			return {
				kind: "relation rename",
				removed: path.removed,
				added: path.added,
				head: printStatement(headOf(o.candidate)),
				alternative: o.alternative.flatMap((a) => recordStep(a, recordRelationOffer))
			}
		}
		case "rewrite":
		case "convert":
		case "delete":
			return recordPlain(o)
	}
}

/** A drafted step as meta.json records it, every statement it drafts in its place, as the file spells it from its first
 * token, a choice's offers recorded by `offer`: an action's statements one by one; a choice's decided statement, the
 * offers, and what follows it whichever way it is decided (a placeholder column's DROP DEFAULT, which a chosen rename
 * leaves to the renamed column); a loss with what it loses and its carriers; a confirmed group. */
const recordStep = <O extends Offer, M>(
	d: Action | Choice<O> | LossDecision | Confirm,
	offer: (o: O) => M
): ReadonlyArray<MetaStepOf<M>> => {
	switch (d.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return spellAction(d).map((x): MetaStepOf<M> => ({
				kind: "statement",
				statement: spelledText(x)
			}))
		case "choice": {
			const [keep, ...follows] = spellAction(d.keep)
			return [
				{
					kind: "choice",
					keep: spelledText(keep),
					offers: mapNonEmpty(d.offers, offer),
					follows: follows.map((x) => spelledText(x))
				}
			]
		}
		case "confirm":
			return [{ kind: "confirm", statements: mapNonEmpty(d.keep, (k) => printStatement(k)) }]
		case "loss":
			return [
				{
					kind: "loss",
					loses: lossesOf(d.loses),
					statement: printStatement(d.statement),
					carriers: d.carriers.map((c) => pathOf(c))
				}
			]
	}
}

/** One drafted file's decision record, as meta.json records it: every step it drafts, in draft order. */
export const recordFile = (file: DraftFile): Result.Result<MetaFile, CompileError> =>
	catchRefusal(() => ({
		name: file.name,
		steps: file.drafts.flatMap((d) => recordStep(d, recordTop))
	}))

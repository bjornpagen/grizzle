import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type {
	Action,
	Choice,
	Draft,
	Loss,
	LossDecision,
	Offer
} from "#compiler/deploy/diff/plan.ts"
import type { DraftFile } from "#compiler/deploy/phases/files.ts"
import {
	type MetaChoice,
	type MetaConfirm,
	type MetaLoss,
	type MetaLosses,
	type MetaWithin,
	topLevel
} from "#compiler/deploy/render/folder.ts"

import {
	lossMarker,
	noTransactionMarker,
	placeholderMarker,
	placeholderToken,
	renameMarker
} from "#compiler/deploy/render/markers.ts"
import type { ColumnDef, Expr, PlBlock, SqlStatement } from "#compiler/sql/ast.ts"
import { exists, lit, namedType, types } from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import {
	dollarQuoteTag,
	printExpr,
	printObjectName,
	printPlBlock,
	printType,
	quoteIdent,
	quoteString
} from "#compiler/sql/print.ts"

const sentinel: Expr = lit.text("__grizzle_sentinel__", types.text)

const emitText = (statement: SqlStatement): string => {
	const e = emit(statement, emptyNameMap, unmetered)
	if (!e.ok) {
		throw new Refusal(e.error)
	}
	return e.value.text
}

const commentLines = (text: string): string =>
	text
		.split("\n")
		.map((l) => `-- ${l}`)
		.join("\n")

/** The instruction line below each kind of offer's marker: what a person does to keep or choose it. */
export const offerInstruction: { readonly [K in Offer["kind"]]: string } = {
	rename:
		"-- Keep the drafted statements and delete this line, or replace the addition below with this rename and delete this line:",
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
const lossHead = (loss: LossDecision): ReadonlyArray<string> => {
	const carried =
		loss.carriers.length === 0
			? ""
			: `; ${loss.carriers.map((c) => c.label).join(", or ")} carries them instead`
	const keep =
		loss.carriers.length === 0
			? "no candidate rename carries them"
			: "to keep them, choose a candidate rename that carries them and leave the statement commented"
	switch (loss.loses.kind) {
		case "relation":
			return [
				`${lossMarker}: the statement below drops the relation ${printObjectName(loss.loses.relation)} with its rows${carried}.`,
				`-- To drop it with its rows, uncomment the statement below; ${keep}${loss.carriers.length === 0 ? "; if an added relation is this one renamed with more changes, rename it alone first, choose its candidate, and change the rest in a later migration" : ""}. grizzle never decides a loss for you.`
			]
		case "field":
			return [
				`${lossMarker}: the statement below drops the field ${printObjectName(loss.loses.relation)}.${quoteIdent(loss.loses.field)} with its values${carried}.`,
				`-- To drop it with its values, uncomment the statement below; ${keep}. grizzle never decides a loss for you.`
			]
		case "schema": {
			const schema = quoteIdent(loss.loses.schema)
			const many = loss.loses.abandoned.length > 1
			const left = loss.loses.abandoned
				.map((a) => `${quoteIdent(a.schema)} (${a.directory})`)
				.join(", ")
			return [
				`${lossMarker}: the statement below starts the schema ${schema} empty, and the configuration no longer lists the schema${many ? "s" : ""} ${left}, whose rows stay where they are, never migrated again: a schema renamed in code is a new PostgreSQL schema.`,
				`-- To start ${schema} empty, uncomment the statement below; to keep the rows, keep the schema's old name and delete this folder. grizzle never decides a loss for you.`
			]
		}
	}
}

const alternative = (statements: ReadonlyArray<SqlStatement>) =>
	statements.map((s) => `${commentLines(emitText(s))};`)

/** A candidate's marker, the instruction for the statement below it, and the commented alternative, if any. */
const renderOffer = (offer: Offer): string => {
	const head = [`${renameMarker}: ${offer.note}.`, offerInstruction[offer.kind]]
	switch (offer.kind) {
		case "rename":
			return [...head, ...offer.alternative.map((a) => commentLines(renderDraft(a)))].join("\n")
		case "rewrite":
			return [...head, ...alternative(offer.statements)].join("\n")
		case "delete":
			return head.join("\n")
		case "convert":
			return [...head, commentLines(renderDraft(offer.conversion))].join("\n")
	}
}

/**
 * One statement as a drafted file spells it: the comment lines above it, then its text from its first token, which
 * meta.json records, and its terminator.
 */
interface Spelled {
	readonly above: ReadonlyArray<string>
	readonly text: string
}

const spelledText = (s: Spelled): string => [...s.above, `${s.text};`].join("\n")

const bare = (text: string): Spelled => ({ above: [], text })

/** The statements an action drafts, in order, as the file spells them: every action drafts one at least. */
const spellAction = (action: Action): NonEmptyReadonlyArray<Spelled> => {
	switch (action.kind) {
		case "statement":
			return [bare(emitText(action.statement))]
		case "placeholderColumn": {
			const text = emitText({
				kind: "alterTable",
				table: action.table,
				actions: [{ kind: "addColumn", column: { ...action.column, default: sentinel } }]
			})
			const printed = printExpr(sentinel)
			const drop = emitText({
				kind: "alterTable",
				table: action.table,
				actions: [{ kind: "dropDefault", column: action.column.name }]
			})
			const hint = action.hint
			const named = (removed: ReadonlyArray<ColumnDef>) =>
				`The removed column${removed.length === 1 ? "" : "s"} ${removed.map((r) => `${quoteIdent(r.name)} (${printType(r.type)})`).join(", ")}`
			const update = (from: ColumnDef) =>
				`UPDATE ${printObjectName(action.table)} SET ${quoteIdent(action.column.name)} = ${quoteIdent(from.name)}::${printType(action.column.type)}`
			const renamed =
				hint.kind === "none"
					? ""
					: ` ${named(hint.removed)} ${hint.removed.length === 1 ? "is" : "are"} dropped after it: if the new column is one renamed, compute it from that one before the drop, such as ${update(hint.removed[0])}.`
			return [
				{
					above: [
						`${placeholderMarker}: every existing row of ${printObjectName(action.table)} needs a value for the new column ${quoteIdent(action.column.name)} (${printType(action.column.type)}); replace the placeholder below with it, optionally compute the real value with an UPDATE before the DROP DEFAULT, and delete this line.${renamed}`
					],
					text: text.replace(printed, placeholderToken)
				},
				bare(drop)
			]
		}
		case "placeholderRetype": {
			const column = action.column
			const text = emitText({
				kind: "alterTable",
				table: action.table,
				actions: [
					{
						kind: "alterColumnType",
						column: column.name,
						type: column.type,
						collation: column.collation,
						using: sentinel
					}
				]
			})
			const printed = printExpr(sentinel)
			return [
				{
					above: [
						`${placeholderMarker}: every row of ${printObjectName(action.table)} needs ${quoteIdent(column.name)} converted in place to ${printType(column.type)}; replace the placeholder below with the expression computing it from the column's value before the conversion, such as ${quoteIdent(column.name)}::${printType(column.type)}, and delete this line.`
					],
					text: text.replace(printed, placeholderToken)
				}
			]
		}
		case "placeholderHandles": {
			const column = quoteIdent(action.column)
			const type = printObjectName(action.type)
			const text = emitText({
				kind: "alterTable",
				table: action.table,
				actions: [
					{
						kind: "alterColumnType",
						column: action.column,
						type: namedType(action.type.schema, action.type.name, []),
						using: sentinel,
						collation: undefined
					}
				]
			})
			const printed = printExpr(sentinel)
			const [first] = action.labels
			const example = `CASE ${column}::text ${action.removed.map((h) => `WHEN ${quoteString(h)} THEN ${quoteString(first)}`).join(" ")} ELSE ${column}::text END::${type}`
			return [
				{
					above: [
						`${placeholderMarker}: every row of ${printObjectName(action.table)} holding a removed handle (${action.removed.map((h) => quoteString(h)).join(", ")}) in ${column} needs one of the new roster (${action.labels.map((h) => quoteString(h)).join(", ")}); replace the placeholder below with the expression converting the column, such as ${example}, and delete this line.`
					],
					text: text.replace(printed, placeholderToken)
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
			const body = printPlBlock(block)
			const tag = dollarQuoteTag(body)
			return [
				{
					above: [`-- The full violation query of law ${action.law}.`],
					text: [`DO ${tag}`, body, tag].join("\n")
				}
			]
		}
		case "analyze":
			return [bare(`ANALYZE ${printObjectName(action.table)}`)]
		case "dropStatistics":
			return [bare(`DROP STATISTICS ${printObjectName(action.name)}`)]
	}
}

/** The statements an action drafts, from their first tokens, as meta.json records them. */
const actionStatements = (action: Action): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(spellAction(action), (s) => s.text)

const renderDraft = (draft: Draft): string => {
	switch (draft.kind) {
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return spellAction(draft)
				.map((s) => spelledText(s))
				.join("\n")
		case "choice":
			return [...draft.offers.map((o) => renderOffer(o)), renderDraft(draft.keep)].join("\n\n")
		case "confirm":
			return [
				`${renameMarker}: ${draft.note}.`,
				`-- ${draft.instruction}.`,
				"",
				draft.keep.map((k) => `${emitText(k)};`).join("\n\n")
			].join("\n")
		case "loss":
			return [...lossHead(draft), commentLines(`${emitText(draft.statement)};`)].join("\n")
	}
}

/** The text of one drafted file.
 *
 * Rendering a drafted file's text.
 *
 * Every SQL statement leaves through, which prints it from the SQL AST, whose constructors keep identifiers
 * quoted, literals and parameters cast and no NULL (checked by the test kernel's structural audit, never here). A few
 * drafted forms are fixed templates around emitted pieces, because they are reviewer-facing or the SQL AST has no form
 * for them:
 *
 * - a placeholder column: the ADD COLUMN statement emitted with a sentinel default, whose printed literal is replaced by
 *   the placeholder token, then the DROP DEFAULT that follows the reviewer's value;
 * - a placeholder conversion: the ALTER COLUMN ... TYPE statement emitted with a sentinel USING, whose printed literal is
 *   replaced by the placeholder token: a field converted in place, or a column of a rebuilt roster;
 * - a violation check: a DO block whose condition is the emitted violation query, raising SQLSTATE 23000 with the
 *   law's identity as the constraint name, as the law function itself does, so a violating Validate file rolls back
 *   with the law's identity;
 * - `ANALYZE <table>` and `DROP STATISTICS <name>`;
 * - a candidate rename's marker and commented alternative, each line of each emitted statement prefixed by `-- `, above
 *   the statement it decides;
 * - a loss's marker, saying what it loses and how to decide it, above its statement commented the same way.
 *
 * Statements end with `;` and are separated by a blank line. A no-transaction file's first line is the marker. */
export const renderFile = (file: DraftFile): Result.Result<string, CompileError> =>
	catchRefusal(() => {
		const parts = file.drafts.map((d) => renderDraft(d))
		const head = file.transaction ? [] : [noTransactionMarker]
		const law =
			file.scope.kind === "slots"
				? []
				: [
						`-- Validate law ${file.scope.law}: its triggers and its violation query, under a lock excluding every writer to its tables.`
					]
		return `${[...head, ...law].map((l) => `${l}\n`).join("")}${head.length + law.length > 0 ? "\n" : ""}${parts.join("\n\n")}\n`
	})

/** What an offer replaces the statement it decides with, as meta.json records it: none for a delete, a rewrite's
 * statements, a conversion's, or a rename's own alternative actions (what a nested choice decides is its own record). */
const offerStatements = (o: Offer): ReadonlyArray<string> => {
	switch (o.kind) {
		case "delete":
			return []
		case "rewrite":
			return o.statements.map((x) => emitText(x))
		case "convert":
			return actionStatements(o.conversion)
		case "rename":
			return o.alternative.flatMap((a) =>
				a.kind === "choice" || a.kind === "loss" ? [] : actionStatements(a)
			)
	}
}

/** The choices of one drafted file as meta.json records them, in the file's order: each statement a candidate decides,
 * as the file spells it, and each offer's statements; a choice nested in a rename's alternative follows the choice
 * whose offer holds it, recorded as within that offer's candidate. The statement an offer decides is the first the kept
 * draft renders: a placeholder column's DROP DEFAULT follows either way, since a chosen rename carries the removed
 * column's default along. A rename's statements are its alternative's own actions: what a nested choice decides is
 * that choice's record. */
const choicesOf = (file: string, d: Choice, within: MetaWithin): ReadonlyArray<MetaChoice> => {
	const record: MetaChoice = {
		file,
		within,
		keep: spellAction(d.keep)[0].text,
		offers: d.offers.map((o) => ({ candidate: o.candidate, statements: offerStatements(o) }))
	}
	const nested = d.offers.flatMap((o) =>
		o.kind === "rename"
			? o.alternative.flatMap((a) =>
					a.kind === "choice" ? choicesOf(file, a, { kind: "within", candidate: o.candidate }) : []
				)
			: []
	)
	return [record, ...nested]
}

export const fileChoices = (
	file: DraftFile
): Result.Result<ReadonlyArray<MetaChoice>, CompileError> =>
	catchRefusal(() =>
		file.drafts.flatMap((d) => (d.kind === "choice" ? choicesOf(file.name, d, topLevel) : []))
	)

/** The groups of one drafted file the reviewer confirms, as meta.json records them, in the file's order: each confirm's
 * statements as the file spells them. */
export const fileConfirms = (file: DraftFile): ReadonlyArray<MetaConfirm> =>
	file.drafts.flatMap((d): ReadonlyArray<MetaConfirm> =>
		d.kind === "confirm"
			? [{ file: file.name, statements: mapNonEmpty(d.keep, (k) => emitText(k)) }]
			: []
	)

/** The losses of one drafted file as meta.json records them, in the file's order: each loss, what it loses, its
 * statement as the reviewer writes it in, and the candidates that carry it instead; a loss in a rename's alternative,
 * a field the relation's rename drops, recorded as within that rename's candidate, wherever its choice is nested. */
const lossesIn = (file: string, d: Draft, within: MetaWithin): ReadonlyArray<MetaLoss> => {
	switch (d.kind) {
		case "loss":
			return [
				{
					file,
					within,
					loses: lossesOf(d.loses),
					statement: emitText(d.statement),
					carriers: d.carriers.map((c) => c.candidate)
				}
			]
		case "choice":
			return d.offers.flatMap((o) =>
				o.kind === "rename"
					? o.alternative.flatMap((a) =>
							lossesIn(file, a, { kind: "within", candidate: o.candidate })
						)
					: []
			)
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "placeholderHandles":
		case "violation":
		case "analyze":
		case "dropStatistics":
		case "confirm":
			return []
	}
}

export const fileLosses = (file: DraftFile): Result.Result<ReadonlyArray<MetaLoss>, CompileError> =>
	catchRefusal(() => file.drafts.flatMap((d) => lossesIn(file.name, d, topLevel)))

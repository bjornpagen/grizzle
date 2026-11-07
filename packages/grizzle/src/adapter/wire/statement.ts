/**
 * Catalog statements and the reading of their rows, a hot path: each row a catalog statement answers is parsed here,
 * in a native loop with no Option or closure per row, and a parser refuses a row with undefined.
 */
import { Result } from "effect"
import { CatalogRowRefused } from "#adapter/errors/failures.ts"
import { sentAnswer, type BatchOutcome } from "#adapter/wire/batch.ts"
import type { EmittedText, OutputRows, OutputText } from "#compiler/plan/common.ts"

/**
 * A catalog statement and the one reading of its rows: each row is parsed once, where its flight answers, into what it
 * says, so nothing downstream coerces a cell. Every result column arrives as its text (the session requests text,
 * parses nothing and admits no other answer, NULL included), so a parser reads what the text says. A row the parser
 * refuses, or a row count a one-row statement cannot answer, is an answer the statement cannot give. Parameters are
 * the slots' encoded texts, bound untyped and cast by the statement (`$n::type`). Its text is the engine's print of a
 * catalog-read AST (sql/catalog.ts, sql/emit.ts emitCatalog), so every name in it is absolute.
 */
export interface CatalogQuery<Row> {
	readonly sql: EmittedText
	/** What a row says, naming the answer when a row is refused. */
	readonly what: string
	readonly row: (cells: ReadonlyArray<OutputText>) => Row | undefined
}

/** Every row of `query`'s statement, parsed. */
export const catalogRows = <Row>(
	query: CatalogQuery<Row>,
	rows: OutputRows
): Result.Result<ReadonlyArray<Row>, CatalogRowRefused> => {
	const out: Array<Row> = []
	for (const cells of rows) {
		const row = query.row(cells)
		if (row === undefined) {
			return Result.fail(new CatalogRowRefused({ what: query.what }))
		}
		out.push(row)
	}
	return Result.succeed(out)
}

/** The one row of a statement that answers exactly one, parsed. */
export const catalogRow = <Row>(
	query: CatalogQuery<Row>,
	rows: OutputRows
): Result.Result<Row, CatalogRowRefused> => {
	const only = rows.length === 1 ? rows[0] : undefined
	const row = only === undefined ? undefined : query.row(only)
	return row === undefined
		? Result.fail(new CatalogRowRefused({ what: query.what }))
		: Result.succeed(row)
}

/** The rows of one statement's outcome: a flight answers every statement it sends, one outcome each. */
export const outcomeRows = (outcomes: ReadonlyArray<BatchOutcome>, index: number): OutputRows =>
	sentAnswer(outcomes, index).rows

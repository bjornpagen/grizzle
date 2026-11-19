import { nominal } from "#compiler/core/brand.ts"
import type { WriteText } from "#compiler/runtime/write/parted.ts"

declare const explainTextBrand: unique symbol

/**
 * A statement's EXPLAIN: the statement's own text, printed or assembled by the engine (runtime/write/parted.ts
 * WriteText), behind a fixed prefix, minted here alone (explainOf, explainAnalyzeOf), so the text an explain sends is a
 * served statement's and nothing a caller wrote.
 */
export type ExplainText = string & { readonly [explainTextBrand]: true }

const explained = nominal<string, ExplainText>()

/**
 * The estimate-only plan request of an emitted statement: EXPLAIN (FORMAT JSON, VERBOSE) before its text. VERBOSE has
 * PostgreSQL name the schema of every relation a node scans or writes, which the relation's own name alone leaves
 * ambiguous across an installation's levels.
 */
export const explainOf = (statement: WriteText): ExplainText =>
	explained(`EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)

/**
 * The executed plan request of an emitted statement: EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) before its text, which runs
 * the statement and reports each node's actual times, rows, loops and buffers beside its estimates (explainOf).
 */
export const explainAnalyzeOf = (statement: WriteText): ExplainText =>
	explained(`EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) ${statement}`)

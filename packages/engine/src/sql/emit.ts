import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import type { EmittedSql, EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import type { CatalogStatement } from "#compiler/sql/catalog.ts"
import type { NameMap } from "#compiler/sql/naming.ts"
import { printCatalogStatement, printStatement } from "#compiler/sql/print.ts"

const emitted = nominal<string, EmittedText>()

/**
 * Emission: print.
 *
 * Every statement a lowering produces leaves the compiler through here: the printer renders its AST (print.ts), and
 * refuses as ResourceBound, when the statement is built, what PostgreSQL would refuse of it: a select list past its
 * entries, a text past its longest message, more placeholders than a Bind message counts, and a text past V8's longest
 * string. The emission discipline the AST's constructors keep (no NULL-yielding form, every parameter cast, generated
 * names) is checked by the test kernel's structural audit over every statement the suites emit
 * (test/support/oracle/verify/sql.ts), never here.
 *
 * The text of `statement` and its generated-name map; a refusal of the printer is thrown as its Refusal, which the
 * pass that emits the statement returns.
 */
export const emitText = (statement: SqlStatement, nameMap: NameMap): EmittedSql => ({
	text: emitted(printStatement(statement)),
	nameMap
})

/**
 * The text of a catalog statement (sql/catalog.ts): a catalog read, the drift transaction's closed search path or a DO
 * block the shell sends.
 */
export const emitCatalog = (statement: CatalogStatement): EmittedText =>
	emitted(printCatalogStatement(statement))

/**
 * The estimate-only plan request of an emitted statement: EXPLAIN (FORMAT JSON, VERBOSE) before its text, one of the two
 * texts composed of another. VERBOSE has PostgreSQL name the schema of every relation a node scans or writes, which
 * the relation's own name alone leaves ambiguous across an installation's levels.
 */
export const explainOf = (statement: EmittedText): EmittedText =>
	emitted(`EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)

/**
 * The executed plan request of an emitted statement: EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) before its text, which runs
 * the statement and reports each node's actual times, rows, loops and buffers beside its estimates (explainOf).
 */
export const explainAnalyzeOf = (statement: EmittedText): EmittedText =>
	emitted(`EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) ${statement}`)

/** `nameMap` is the statement's generated-name map, from its NameSupply (naming.ts emptyNameMap when it has none). */
export const emit = (
	statement: SqlStatement,
	nameMap: NameMap
): Result.Result<EmittedSql, CompileError> => catchRefusal(() => emitText(statement, nameMap))

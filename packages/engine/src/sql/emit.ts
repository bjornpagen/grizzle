import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type {
	EmittedSql,
	EmittedText,
	Select,
	SqlStatement,
	StatementText,
	UnprintedSql
} from "#compiler/sql/ast.ts"
import {
	bindSelect,
	bindStatement,
	type BoundStatement,
	type ReadCatalog
} from "#compiler/sql/bind.ts"
import type { CatalogStatement } from "#compiler/sql/catalog.ts"
import { AdviceScope, type NameMap } from "#compiler/sql/naming.ts"
import { printCatalogStatement, printCommands, printStatement } from "#compiler/sql/print.ts"

const emitted = nominal<string, EmittedText>()

/**
 * What a statement is bound under where it is emitted (sql/bind.ts): the advice scope of the transaction that sends it,
 * which mints every alias of every statement the transaction may send, and the catalog of the installation it reads.
 */
export interface Emitting {
	readonly scope: AdviceScope
	readonly catalog: ReadCatalog
}

/** The catalog of no installation: a statement that reads no stored relation reads nothing of one. */
const noCatalog: ReadCatalog = { table: () => undefined, view: () => false, fired: () => undefined }

/**
 * The binding of a statement no advice holds, PostgreSQL choosing its plan by cost, each read of it whole: a
 * transaction's control, a lock, a call, a guard's bracket, a row of the deploy ledger, a refused commit's witness
 * (write/unmatched.ts), and an oracle's baseline, which no installation serves. Each is its own transaction's scope, as
 * it is sent by itself.
 */
export const costChosen = (): Emitting => ({ scope: new AdviceScope(), catalog: noCatalog })

/**
 * Emission: bind and print.
 *
 * Every statement a lowering produces leaves the compiler through here: bound under the transaction's binding
 * (sql/bind.ts), the only form anything prints or plans from, then printed (print.ts); the printer renders its AST, and
 * refuses as ResourceBound, when the statement is built, what PostgreSQL would refuse of it: a select list past its
 * entries, a text past its longest message, more placeholders than a Bind message counts, and a text past V8's longest
 * string. A statement that reads a name where nothing binds it is an internal compiler error the printer raises
 * (sql/scope.ts). The emission discipline the AST's constructors keep (no NULL-yielding form, every parameter cast,
 * generated names) is checked by the test kernel's structural audit over every statement the suites emit
 * (test/support/oracle/verify/sql.ts), never here.
 *
 * The text of `statement` bound under `binding`, its plan and its generated-name map; a refusal of the printer is
 * thrown as its Refusal, which the pass that emits the statement returns.
 */
export const emitText = (
	statement: SqlStatement,
	nameMap: NameMap,
	binding: Emitting
): EmittedSql =>
	printedOf(bindStatement(statement, binding.scope, binding.catalog, "keyed"), nameMap, statement)

/** A bound statement's text, the plan it was bound with, its generated-name map, and the statement it was bound from. */
const printedOf = (bound: BoundStatement, nameMap: NameMap, source: SqlStatement): EmittedSql => ({
	text: emitted(printStatement(bound.statement)),
	plan: bound.plan,
	nameMap,
	source
})

/**
 * A query bound under `binding` (`emitText`), with its bound AST, which a caller that cuts or rewrites the statement
 * after its print holds in place of the one it built, so its text is the print of the AST it holds.
 */
export const emitSelect = (
	query: Select,
	nameMap: NameMap,
	binding: Emitting
): { readonly ast: Select; readonly sql: EmittedSql } => {
	const bound = bindSelect(query, binding.scope, binding.catalog)
	return { ast: bound.statement, sql: printedOf(bound, nameMap, query) }
}

/**
 * How a builder makes a statement's text of its AST and its generated-name map (StatementText): its print where the
 * statement is sent (emitText), none where another statement composes it (unprintedText).
 */
export type TextOf<T extends StatementText> = (statement: SqlStatement, nameMap: NameMap) => T

/** The text a statement sent alone makes under `binding` (emitText). */
export const sentText =
	(binding: Emitting): TextOf<EmittedSql> =>
	(statement, nameMap) =>
		emitText(statement, nameMap, binding)

/**
 * The text of a statement another statement composes, which nothing prints: its generated-name map alone, the names
 * the composing statement names past. Its names may be bound by that statement alone, so its print apart would read
 * names nothing binds (sql/scope.ts).
 */
export const unprintedText: TextOf<UnprintedSql> = (_statement, nameMap) => ({ nameMap })

/**
 * The text of a catalog statement (sql/catalog.ts): a catalog read, the drift transaction's closed search path or a DO
 * block the shell sends.
 */
export const emitCatalog = (statement: CatalogStatement): EmittedText =>
	emitted(printCatalogStatement(statement))

/**
 * An emitted statement's text with its variables filled by `fill` (deploy/render/variables.ts resolveVariables), or
 * what `fill` refuses: the text the drift check's replay and an uninstall send, one text composed of another, as
 * runtime/explain.ts composes an EXPLAIN.
 */
export const filledText = <E>(
	statement: EmittedText,
	fill: (text: string) => Result.Result<string, E>
): Result.Result<EmittedText, E> => Result.map(fill(statement), emitted)

/**
 * The texts of `statement`'s commands (print.ts commandsOf), each one message's: what a driver that sends one command a
 * message sends, as the drift check's replay does, for a statement of several, a declared function's hand-over among
 * them.
 */
export const emitCommands = (
	statement: SqlStatement
): Result.Result<NonEmptyReadonlyArray<EmittedText>, CompileError> =>
	catchRefusal(() => mapNonEmpty(printCommands(statement), emitted))

/** `nameMap` is the statement's generated-name map, from its NameSupply (naming.ts emptyNameMap when it has none). */
export const emit = (
	statement: SqlStatement,
	nameMap: NameMap,
	binding: Emitting
): Result.Result<EmittedSql, CompileError> =>
	catchRefusal(() => emitText(statement, nameMap, binding))

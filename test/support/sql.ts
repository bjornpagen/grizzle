import type { FlightStatement } from "#adapter/wire/batch.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { EmittedText, TypeSchema } from "#compiler/sql/ast.ts"

/**
 * The tests' one door of SQL text to grizzle's wire: a statement a wire suite sends that neither the engine's AST nor
 * its catalog-read AST expresses (pg_sleep, pg_terminate_backend, a planted fault, a scripted answer's text). Product
 * code sends only the engine printer's text or a reviewed migration file's statement (adapter/wire/batch.ts SentText);
 * a test that needs another passes it through here, where a reader sees it is written by hand.
 */
export const testSql = nominal<string, EmittedText>()

/**
 * The tests' one door of a named type's schema (sql/ast.ts TypeSchema): an oracle or a fixture that builds a type of a
 * schema it names by its text, an installation's or the vector extension's. Product code takes it from the naming door
 * (physical/ddl/names.ts) or the snapshot's codec.
 */
export const testTypeSchema = nominal<string, TypeSchema>()

/** The SQL text a flight statement runs: a server statement's, or the unnamed statement's own. */
export const statementSql = (statement: FlightStatement): string =>
	"server" in statement ? statement.server.sql : statement.sql

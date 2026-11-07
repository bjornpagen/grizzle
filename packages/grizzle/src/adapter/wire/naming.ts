import type { FlightStatement } from "#adapter/wire/batch.ts"
import { type ServerStatement, serverStatement } from "#adapter/wire/session.ts"
import type { EmittedText } from "#compiler/plan/common.ts"

/**
 * The server statements of one compiled program, by the SQL text each runs: what the program's flights run named.
 *
 * A program compiled ahead (the workload's, db.compile's) mints one server statement for each statement text it can
 * send: every form of every statement of the artifact that runs. A statement an execution specializes (a relation
 * parameter sent as a VALUES list) has a text of its own, which no server statement names, and runs unnamed, as every
 * statement of a program compiled for one call does. The map is the program's own, built where it is
 * compiled and dropped with it.
 */
export type StatementNaming = ReadonlyMap<string, ServerStatement>

/** The naming of a program compiled for one call: every statement unnamed. */
export const unnamedNaming: StatementNaming = new Map()

/** `statements` as a program of `naming` runs them: each text the program named under its server statement. */
export const nameStatements = (
	naming: StatementNaming,
	statements: ReadonlyArray<FlightStatement>
): ReadonlyArray<FlightStatement> => {
	if (naming.size === 0) {
		return statements
	}
	return statements.map((statement): FlightStatement => {
		const server = "server" in statement ? undefined : naming.get(statement.sql)
		return server === undefined ? statement : { server, params: statement.params }
	})
}

/** The naming of `texts`: one server statement minted for each distinct text, in first-seen order. */
export const mintNaming = (texts: Iterable<EmittedText>): StatementNaming => {
	const naming = new Map<string, ServerStatement>()
	for (const sql of texts) {
		if (!naming.has(sql)) {
			naming.set(sql, serverStatement(sql))
		}
	}
	return naming
}

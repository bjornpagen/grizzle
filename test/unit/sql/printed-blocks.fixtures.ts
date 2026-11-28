/** What the properties of printed-blocks.test.ts read: the DO statement a migration's violation check prints. */

import { array, boolean, type Gen } from "@bjornpagen/testing/gen"
import { SourceLoc } from "#compiler/core/loc.ts"
import { violationCheck } from "#compiler/physical/ddl/recheck.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { cteGen, type StatementShape } from "#test/support/unit/sql/print-once.fixtures.ts"

/** The DO statement a migration prints to check one law over `query` (physical/ddl/recheck.ts violationCheck). */
export const checkText = (query: OperandSelect): string =>
	sqlText(SourceLoc("printed-blocks", []), (out) =>
		writeDoBlock(out, violationCheck(wild.lawId("printedblock"), query))
	)

/**
 * Print once's statements of one or two CTEs (test/unit/sql/print-once statementGen, cut to two), a finite box every
 * feature of print once is reached in: a chain needs two CTEs, and every other feature one.
 */
export const pairGen: Gen<StatementShape> = (source) => ({
	ctes: source.draw(array(cteGen, { min: 1, max: 2 })),
	recursive: source.draw(boolean)
})

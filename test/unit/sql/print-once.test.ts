/**
 * Print once (sql/print-once.ts): a statement's text states a CTE only where PostgreSQL plans it as one. A CTE the
 * statement reads exactly once, that is not MATERIALIZED, not recursive's and calls no VOLATILE function, PostgreSQL
 * inlines by a walk of the whole statement per CTE; the printer prints it in place, as the derived table that inlining
 * makes, and every other CTE stays one. A statement holding such a CTE is refused as an internal compiler error.
 *
 * Each case draws one to four CTEs, each plain, MATERIALIZED, NOT MATERIALIZED or calling a VOLATILE function, each
 * read by none, one or two references of the body, the CTE after it reading it once or not, under a WITH that is
 * recursive or not.
 *
 * Oracle: the statement built a second way, each CTE PostgreSQL would inline written in place by hand, printed; and
 * the invariant read off the shape.
 *
 * Features: a CTE printed in place, a chain of them, and each reason a CTE read once stays one or is read twice.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { assertPrintedOnce, printedOnce } from "#compiler/sql/print-once.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	featuresOf,
	inPlace,
	type PrintOnceFeature,
	printedByHand,
	printOnceFeatures,
	type StatementShape,
	statementGen,
	statementOf
} from "#test/support/unit/sql/print-once.fixtures.ts"

/** Exactly the CTEs PostgreSQL would inline are printed in place, and a statement holding one is refused. */
export const everyCteAStatementReadsOnceIsPrintedInPlaceExactlyWherePostgreSQLWouldInlineIt =
	property.explore(statementGen, {
		needs: {},
		situations: printOnceFeatures,
		check: (_, k: Case<PrintOnceFeature>) => (shape: StatementShape) =>
			Effect.sync(() => {
				for (const feature of featuresOf(shape)) {
					k.note(feature)
				}
				const statement = statementOf(shape)
				assert.equal(
					printStatement(statement),
					printStatement(printedByHand(shape)),
					`${Formatter.format(shape)}: each CTE PostgreSQL would inline printed in place, every other a CTE`
				)
				const inlined = Arr.some(shape.ctes, (_, i) => inPlace(shape, i))
				let refused = false
				try {
					assertPrintedOnce(statement)
				} catch {
					refused = true
				}
				assert.equal(
					refused,
					inlined,
					`${Formatter.format(shape)}: refused exactly where it holds a CTE PostgreSQL would inline`
				)
				assertPrintedOnce(printedOnce(statement))
			}),
		oracle: {
			kind: "second-implementation",
			name: "the shape's statement built with each CTE PostgreSQL would inline written in place by hand, and the invariant read off the shape"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print-once.ts",
				original: "\treferences === 1 &&\n",
				replacement: "\treferences >= 1 &&\n",
				why: "A CTE read twice printed at each reference: the one derivation printed and planned twice."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original: '\tcte.materialized !== "MATERIALIZED" &&\n',
				replacement: "",
				why: "A MATERIALIZED CTE printed in place: a fence its lowering asked for, gone."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original: "\t!callsVolatile(cte.query)\n",
				replacement: "\ttrue\n",
				why: "A CTE calling a VOLATILE function printed in place: PostgreSQL never inlines one, and a refusal moved into a join may raise for a row the CTE never kept."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original: "\tif (w.recursive) {\n\t\treturn new Map()\n\t}\n",
				replacement: "",
				why: "A recursive WITH's CTE printed in place, where a CTE may read one after it."
			},
			{
				file: "packages/engine/src/sql/print-once.ts",
				original:
					"\tconst nested = transformStatement(statement, { ...identityHooks, select: queryPrintedOnce })\n",
				replacement: "\tconst nested = statement\n",
				why: "No CTE printed in place: every single-use CTE left to PostgreSQL's walk of the whole statement, which the invariant refuses."
			}
		]
	})

/**
 * A DO statement's block is printed as every PL/pgSQL block is (sql/print-once.ts printedBlock): a migration's
 * violation check holding a query is printed with each CTE PostgreSQL would inline in place and each simple sub-query
 * of a FROM list flattened into its reader, exactly as a statement or a function's body is, and held to both
 * invariants. A DO block written straight to the PL/pgSQL printer left its query's CTEs and levels as the lowering
 * built them, and no invariant saw it.
 *
 * Box: the violation check of every statement of print pulled up's box (sql/pull-up.ts, test/unit/sql/pull-up), and of
 * every statement of print once's of one or two CTEs (test/unit/sql/print-once).
 *
 * Oracle: second implementation, the check of each statement as printed by hand, flattened or printed once, whose DO
 * statement the check's must be byte for byte; the check of a reader naming a column unqualified refused, its query
 * reading a name nothing binds there, held to its scope as the lowering built it (sql/scope.ts assertBlockScoped,
 * 962f3a9fd4).
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	featuresOf as printOnceFeaturesOf,
	type PrintOnceFeature,
	printedByHand,
	printOnceFeatures,
	type StatementShape,
	statementOf as printOnceStatementOf
} from "#test/support/unit/sql/print-once.fixtures.ts"
import { checkText, pairGen } from "#test/unit/sql/printed-blocks.fixtures.ts"
import {
	flattenedByHand,
	type PullUpFeature,
	pullUpFeatures,
	type ReaderShape,
	readerFeaturesOf as pullUpFeaturesOf,
	readerGen,
	readerStatementOf as pullUpStatementOf,
	refusesUnqualified
} from "#test/unit/sql/pull-up.fixtures.ts"

/** The DO block's bypass of the one route every block is printed by: the kill both properties share. */
const bypass = {
	file: "packages/engine/src/sql/print.ts",
	original: '\tdollarQuoted(out, "DO", printedBlock(block))\n',
	replacement: '\tdollarQuoted(out, "DO", block)\n',
	why: "A DO block written straight to the PL/pgSQL printer: a migration's check prints its query's single-use CTEs and simple sub-queries as the lowering built them, past both invariants."
} as const

/** A violation check's DO statement prints its query flattened, as print pulled up prints a statement. */
export const aViolationChecksDoBlockPrintsItsQueryPulledUpAsAStatementIs = property.exhaust(
	finite(readerGen),
	{
		needs: {},
		situations: pullUpFeatures,
		check: (_, k: Case<PullUpFeature>) => (shape: ReaderShape) =>
			Effect.sync(() => {
				for (const feature of pullUpFeaturesOf(shape)) {
					k.note(feature)
				}
				if (shape.unqualified) {
					assert.throws(
						() => checkText(pullUpStatementOf(shape)),
						refusesUnqualified,
						`${Formatter.format(shape)}: the check of a query naming a column unqualified, refused for its scope`
					)
					return
				}
				assert.equal(
					checkText(pullUpStatementOf(shape)),
					checkText(flattenedByHand(shape)),
					`${Formatter.format(shape)}: the check's query flattened as the statement's is`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the check of the statement flattened by hand, and the scope refusal of an unqualified reference"
		},
		box: "the violation check of every statement of print pulled up's box",
		kept: [],
		kills: [bypass]
	}
)

/** A violation check's DO statement prints its query's single-use CTEs in place, as print once prints a statement. */
export const aViolationChecksDoBlockPrintsItsQueryOnceAsAStatementIs = property.exhaust(
	finite(pairGen),
	{
		needs: {},
		situations: printOnceFeatures,
		check: (_, k: Case<PrintOnceFeature>) => (shape: StatementShape) =>
			Effect.sync(() => {
				for (const feature of printOnceFeaturesOf(shape)) {
					k.note(feature)
				}
				assert.equal(
					checkText(printOnceStatementOf(shape)),
					checkText(printedByHand(shape)),
					`${Formatter.format(shape)}: the check's query printed once as the statement's is`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the check of the statement with each CTE PostgreSQL would inline written in place by hand"
		},
		box: "the violation check of every statement of print once's box of one or two CTEs",
		kept: [],
		kills: [bypass]
	}
)

import { assert, containsText } from "@bjornpagen/testing/assert"
/**
 * A case on the worker's held transaction session (substrate.ts Substrate.transaction) leaves nothing to the next case
 * by construction: every case runs inside one owner transaction on the worker's own clone of the base template, each
 * statement under its own savepoint, and when it ends the transaction is rolled back, every sequence put back and the
 * session discarded (DISCARD ALL); a case that ended its transaction anyway (a COMMIT sent as text, the one way a case
 * can) fails, and its clone is replaced.
 *
 * Each case plants one thing, in a search of two cases nested in it and run in its process on one held session, on the
 * worker's own cluster service (runner.ts workerCluster) (transaction.fixtures.ts plantedThenRead): the first case plants it in its transaction, the second reads it on the
 * same held connection. A table, a temporary table, a database default and a session setting, each undone by the
 * rollback, and an advisory lock and a prepared statement, each kept by a session past a rollback and undone by the
 * discard, are none of them found by the next case, and both cases pass; a COMMIT fails the case that sent it, naming
 * the transaction it ended.
 *
 * Oracle: the planting itself, against the next case's reads and the planting case's verdict.
 *
 * Features: each planting.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { inlineRun, searchInline } from "@bjornpagen/testing/inline"
import { type Case, property } from "@bjornpagen/testing/property"
import { fnv1a32 } from "@bjornpagen/testing/random"
import { Effect, Formatter } from "effect"
import { plantingWords } from "#test/pg/substrate/transaction.dictionary.ts"
import { plantedThenRead, plantingName } from "#test/pg/substrate/transaction.fixtures.ts"
import { workerCluster } from "#test/support/runner.ts"

/** Nothing a case does outlives its transaction, and a case that ends its transaction fails. */
export const caseTransactionIsolation = property.exhaust(finite(word(plantingWords)), {
	needs: { cluster: workerCluster },
	situations: [],
	check:
		({ cluster }, c: Case<string>) =>
		(planting) =>
			Effect.gen(function* () {
				const name = plantingName(planting)
				const id = `test/pg/substrate/transaction.test.ts#planted/${name}`
				const services = yield* cluster
				const verdict = yield* Effect.provideContext(
					searchInline(plantedThenRead(planting), inlineRun(id, fnv1a32(id))),
					services
				)
				if (planting.kind === "outlived") {
					assert.equal(verdict.kind, "exhausted", Formatter.format(verdict))
					return c.note(name)
				}
				if (verdict.kind !== "failed") {
					return assert.fail("a case committed its transaction, and passed")
				}
				containsText(Formatter.format(verdict.finding), "the case ended its transaction")
				c.note(name)
			}),
	oracle: {
		kind: "specification",
		name: "a case's transaction, rolled back, sequences put back and session discarded, against what one case plants"
	},
	box: "everything a case may do that would outlive it on a committing session, and the commit that would end its transaction",
	kept: [],
	kills: [
		{
			file: "test/support/substrate/substrate.ts",
			original: '\trolledBack: bare("ROLLBACK"),',
			replacement: '\trolledBack: bare("COMMIT"),',
			why: "A case's transaction is committed rather than rolled back, so its table, temporary table, database default and session setting reach the next case."
		},
		{
			file: "test/support/substrate/substrate.ts",
			original: '\tdiscarded: bare("DISCARD ALL")',
			replacement: '\tdiscarded: bare("SELECT 1")',
			why: "The held session is rolled back but not discarded, so a case's advisory lock and prepared statement reach the next case."
		},
		{
			file: "test/support/substrate/substrate.ts",
			original: "\t\t\t\treturn still === began\n\t\t\t\t\t? left\n",
			replacement: "\t\t\t\treturn true\n\t\t\t\t\t? left\n",
			why: "A case that ends its transaction (a COMMIT sent as text) is not caught, so what it committed outlives it."
		}
	]
})

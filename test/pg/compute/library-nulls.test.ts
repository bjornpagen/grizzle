/**
 * grizzle's library functions on PostgreSQL 19 and the host alike over NULL: each is STRICT exactly where the host term
 * over it is (physical/ddl/library.ts strictOf, scalar/compute/registry.ts nullRules), so a call with a NULL argument
 * is the host's value.
 *
 * Over every library function (ir/physical.ts LibraryFn) and every native node that calls one, a scalar term each
 * (library-nulls.fixtures.ts calls), batches of drawn argument texts, each with every set of its arguments NULL in
 * turn, none and every one among them: PostgreSQL's value of the term, its library function created in the session's
 * pg_temp, and the host evaluator's (scalar/compute/evaluate.ts) are one, NULL or a value, in one round trip per call.
 *
 * Oracle: the host evaluator, the semantics a check, a contract and a generated field are judged by.
 *
 * Features: each library function with no argument NULL, each argument NULL alone, and every argument NULL.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	batchGen,
	calls,
	hostValue,
	type LibraryNullFeature,
	rowsJson,
	uncalledNodes
} from "#test/pg/compute/library-nulls.fixtures.ts"
import { inInstallation } from "#test/pg/compute/utf16-length.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A cell of a row PostgreSQL returned, a text or NULL. */
const cell = (row: ReadonlyArray<unknown>): string | null => {
	const v = row[0]
	return typeof v === "string" || v === null
		? v
		: assert.fail(`a text cell, not ${Formatter.format(v)}`)
}

/** grizzle's library on PostgreSQL 19: every library function's value over every set of NULL arguments is the host's. */
export const grizzlesLibraryOnPostgreSQL19EveryLibraryFunctionsValueOverEverySetOfNullArgumentsIsTheHosts =
	property.explore(batchGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"isXsdPattern with no argument NULL",
			"isXsdPattern with every argument NULL",
			"resolveReference with no argument NULL",
			"resolveReference with argument 1 NULL",
			"resolveReference with argument 2 NULL",
			"resolveReference with every argument NULL",
			"textDigest with no argument NULL",
			"textDigest with every argument NULL"
		] satisfies ReadonlyArray<Reached<LibraryNullFeature>>,
		check:
			({ substrate }, k: Case<LibraryNullFeature>) =>
			(batch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						yield* agree<ReadonlyArray<string>>(
							[
								["the native nodes that call a library function and no call holds", uncalledNodes],
								["none", []]
							],
							exact
						)
						const pinned = yield* s.admin.pin
						for (const [call, rows] of Arr.zip(calls, batch)) {
							for (const row of rows) {
								k.note(row.feature)
							}
							const answered = yield* inInstallation(
								pinned,
								[call.create],
								pinned.queryValues(call.sql, [jsonText(rowsJson(rows))])
							)
							yield* agree<ReadonlyArray<string | null>>(
								[
									["PostgreSQL", Arr.map(answered, cell)],
									["the host", Arr.map(rows, (row) => hostValue(call, row))]
								],
								ordered(exact)
							)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the host evaluator's value of the term, beside PostgreSQL's of the library function's SQL"
		},
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\t\t\tout.line(sqlConstantClauses("strict" in statement && statement.strict))\n',
				replacement: "\t\t\tout.line(sqlConstantClauses(false))\n",
				why: "A library function's CREATE drops STRICT, so its body runs over a NULL: isXsdPattern(NULL) is true and resolveReference(NULL, 'http://a/b') is 'http://a/b' in PostgreSQL, where the host reads NULL."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\tnativeOps.every((op) => libraryOf(op.sql) !== fn || nullRules[op.fn] === "strict")\n',
				replacement: "\tnativeOps.length === 0\n",
				why: "A library function is not STRICT though every host term over it is strict, so PostgreSQL runs isXsdPattern's body over a NULL pattern and reads it as a pattern."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: '\t\tcase "strict":\n\t\t\treturn { present, absent: () => nullValue }\n',
				replacement:
					'\t\tcase "strict":\n\t\t\treturn { present, absent: () => Result.ok(false) }\n',
				why: "The host reads a strict operation over a NULL operand as false, where PostgreSQL's STRICT library function returns NULL."
			}
		]
	})

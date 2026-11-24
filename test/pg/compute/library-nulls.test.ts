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

import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	batchGen,
	calls,
	hostValue,
	type LibraryNullFeature,
	type LibraryValue,
	libraryValue,
	rowsJson,
	sameLibraryValue,
	uncalledNodes
} from "#test/pg/compute/library-nulls.fixtures.ts"
import { inInstallation } from "#test/pg/compute/support.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The cell of a row PostgreSQL returned, the call's value in its own type. */
const cell = (row: ReadonlyArray<unknown>): LibraryValue => libraryValue(row[0], "PostgreSQL")

/**
 * grizzle's library on PostgreSQL 19: every library function's value over every set of NULL arguments is the host's.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/compute/library-nulls.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/compute/library-nulls.test.ts` at its budget
 *   before, `{ runs: 12, steered: 12 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 4 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const grizzlesLibraryOnPostgreSQL19EveryLibraryFunctionsValueOverEverySetOfNullArgumentsIsTheHosts =
	property.explore(batchGen, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"cutBefore with no argument NULL",
			"cutBefore with argument 1 NULL",
			"cutBefore with argument 2 NULL",
			"cutBefore with every argument NULL",
			"cutFrom with no argument NULL",
			"cutFrom with argument 1 NULL",
			"cutFrom with argument 2 NULL",
			"cutFrom with every argument NULL",
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
			({ tx }, k: Case<LibraryNullFeature>) =>
			(batch) =>
				Effect.gen(function* () {
					const { bare } = yield* tx
					yield* agree<ReadonlyArray<string>>(
						[
							["the native nodes that call a library function and no call holds", uncalledNodes],
							["none", []]
						],
						exact
					)
					for (const [call, rows] of Arr.zip(calls, batch)) {
						for (const row of rows) {
							k.note(row.feature)
						}
						const answered = yield* inInstallation(
							bare,
							[call.create],
							bare.queryValues(call.sql, [jsonText(rowsJson(rows))])
						)
						yield* agree<ReadonlyArray<LibraryValue>>(
							[
								["PostgreSQL", Arr.map(answered, cell)],
								["the host", Arr.map(rows, (row) => hostValue(call, row))]
							],
							ordered(sameLibraryValue)
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the host evaluator's value of the term, beside PostgreSQL's of the library function's SQL"
		},
		budget: { runs: 1, steered: 12 },
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
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\tbody: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])\n',
				replacement:
					'\tbody: call("sha224", [call("convert_to", [param(1, types.text), text("UTF8")])])\n',
				why: "textDigest's body digests a text by SHA-224, 28 bytes, where the host's digest of it is SHA-256's 32: PostgreSQL's digest of every text no NULL is other bytes than the host's."
			}
		]
	})

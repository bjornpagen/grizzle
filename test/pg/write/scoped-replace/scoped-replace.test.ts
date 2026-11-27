/**
 * A scoped replace reads its scope and its input, however many rows its relation holds beside them, on PostgreSQL 19: a
 * ChangeSet putting a relation parameter's facts into R beside the deletion of R's facts in the parameter's scope whose
 * key it lacks (write/put/choose.ts), the deletion one statement reading the scope at its key (write/delete/), the put
 * the pair, its displacing deletion at the input's keys and its insert half. One MERGE whose WHEN NOT MATCHED BY SOURCE
 * absorbed the deletion read every row of R at every call, PostgreSQL planning it as a FULL join.
 *
 * The bound: O((|input| + |scope|) log n), the scope's rows and the input's read by their keys. Each case stores the
 * scope's two or eight facts beside 256 or 1,024 other scopes of one fact each, measures the replace's statements, each
 * explained with ANALYZE in its place and its transaction rolled back (bench/write/support/writes.ts explainedChange),
 * then multiplies the background by four, twice, measuring each time, with no planner setting and no ANALYZE. The
 * oracle: the rows the statements read and pair (bench/harness/explain.ts rowsScannedAndPaired) are the same at every
 * size, never a clock; and the replace, applied, leaves the scope holding exactly the facts it put, its fresh key
 * among them.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ReplaceFeature,
	replaceGen,
	runReplace
} from "#test/pg/write/scoped-replace/scoped-replace.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A scoped replace reads the same rows however many rows its relation holds beside its scope. */
export const aScopedReplaceReadsItsScopeAndItsInputHoweverManyRowsItsRelationHoldsBesideThem =
	property.exhaust(finite(replaceGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["2 facts replaced", "8 facts replaced"] satisfies ReadonlyArray<
			Reached<ReplaceFeature>
		>,
		check:
			({ substrate }, c: Case<ReplaceFeature>) =>
			(drawn) =>
				Effect.provideServiceEffect(
					runReplace(drawn, (f) => c.note(f)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: the replace's statements read and pair the same rows beside a background and beside four and sixteen times it, and the scope holds exactly the facts put"
		},
		box: "two or eight facts in the replaced scope, beside 256 or 1,024 other scopes, then four and sixteen times as many",
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/scoped-replace/scoped-replace.test.ts#aScopedReplaceReadsItsScopeAndItsInputHoweverManyRowsItsRelationHoldsBesideThem:-:0.0"
				),
				reason:
					"Two facts replaced beside 256 other scopes, then 1,024: the scope's deletion, `DELETE FROM R USING <the scope's facts the input lacks> WHERE (R.s, R.a, R.c) = (…)`, its row equality no binding read, read R whole, 306 rows and then 1,074, where the MERGE it replaced read R whole at every call (main 9dba01d9)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t: (rowEqualities(e)?.flatMap(conjunctsIn) ?? [asRead(e)])\n",
				replacement: "\t\t\t: [asRead(e)]\n",
				why: "A row equality read as no binding: the scope's deletion joins R to the rows it removes by `(R.s, R.a, R.c) = (…)`, and reads R whole for them, every scope's facts at every replace."
			}
		]
	})

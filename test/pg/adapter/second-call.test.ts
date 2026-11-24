/**
 * A brand-new backend's second call of a write plans nothing, on PostgreSQL 19: a session stands a write up once, in a
 * transaction of its own before its first call (adapter/apply/stand-up.ts), its carriers with their emptying functions
 * and the rule judge's session tables of the tables it writes (physical/ddl/rules.ts addStandUps), so no call's
 * transaction makes a relation, a catalog change the session would read at its next transaction, which made every plan
 * over the relation again: metis's assign planned 28 statements and 70 in functions again at its second call. And a
 * carrier's emptying is a session function's call, which PostgreSQL plans once in a session, where a DO block planned
 * its statements at every call. Every call after the first plans nothing either, a carrier filled past a page at every
 * call among them: every statement reads a carrier through its reader (sql/print.ts carrierReader), so no plan depends
 * on the carrier's file, and its emptying gives the file back only past the pages it keeps (sql/print.ts
 * sessionTableKeptPages), where at one page it truncated at every call, three invalidations each, and replanned what
 * read the table (edullm's PERF-COMMIT grade at c1 bound 2.7 s at every call).
 *
 * Each case: a put of a candidate-keyed relation a rule over a query reads (second-call.fixtures.ts), its facts staged
 * in a carrier of the program's own, served by a Db of the full world's login on a fresh clone whose backends count
 * every statement's plans (pg_stat_statements, turned on for the clone alone); one key, sixteen, four hundred, past a
 * carrier's page, four calls on one brand-new backend.
 *
 * Oracle: PostgreSQL's pg_stat_statements, track all, its plans and calls of the clone's statements before and after
 * each call after the first, and the catalog rows of the session's own relations and functions.
 */

import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { callsGen, runCalls } from "#test/pg/adapter/second-call.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A brand-new backend's calls of a write after its first plan nothing and change no catalog row of its session's own. */
export const aBrandNewBackendsCallsOfAWriteAfterItsFirstPlanNothingAndChangeNoCatalogRowOfItsSessionsOwn =
	property.exhaust(finite(callsGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["one key", "sixteen keys", "a carrier past a page at every call"],
		check:
			({ substrate }, c) =>
			(calls) =>
				Effect.provideServiceEffect(
					Effect.scoped(runCalls(calls, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "pg_stat_statements' plans and calls of the clone's statements around each call after the first, none planned and some run, and the catalog rows of the session's temporary relations and functions, unchanged"
		},
		box: "a put of one key, sixteen and four hundred of a candidate-keyed relation a rule over a query reads, four calls on one brand-new backend of a served Db",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/stand-up.ts",
				original: "\t\tif (!Arr.isReadonlyArrayNonEmpty(missing)) {\n",
				replacement: "\t\tif (Arr.isReadonlyArrayNonEmpty(missing)) {\n",
				why: "The session's stand-up is skipped: no carrier and no judge's table stands at the first call, which the capture refuses (55Z03) or PostgreSQL refuses as a relation that does not exist."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "const sessionTableKeptPages = 100\n",
				replacement: "const sessionTableKeptPages = 1\n",
				why: "The emptying keeps one page: a carrier and deltas filled past a page at every call are truncated at every call, a new file of each and three invalidations a TRUNCATE, and every reader's SELECT is planned again."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn out.line(\`SELECT \${printObjectName(objectName(temporarySchema, statement.name))}()\`)\n`,
				replacement:
					"\t\t\treturn writeDoBlock(out, { declare: [], body: [sessionTableEmptied(statement.name)] })\n",
				why: "A carrier's emptying is a DO block of its body, which PostgreSQL compiles anew at every run: its size check and its DELETE are planned at every call, the second's among them."
			}
		]
	})

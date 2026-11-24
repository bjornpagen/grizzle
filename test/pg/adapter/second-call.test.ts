/**
 * A brand-new backend's second call of a write plans nothing, on PostgreSQL 19: a session stands a write up once, in a
 * transaction of its own before its first call (adapter/apply/stand-up.ts), its carriers with their emptying functions
 * and the rule judge's session tables of the tables it writes (physical/ddl/rules.ts addStandUps), so no call's
 * transaction makes a relation, a catalog change the session would read at its next transaction, which made every plan
 * over the relation again: metis's assign planned 28 statements and 70 in functions again at its second call. And a
 * carrier's emptying is a session function's call, which PostgreSQL plans once in a session, where a DO block planned
 * its statements at every call.
 *
 * Each case: a put of a candidate-keyed relation a rule over a query reads (second-call.fixtures.ts), its facts staged
 * in a carrier of the program's own, served by a Db of the full world's login on a fresh clone whose backends count
 * every statement's plans (pg_stat_statements, turned on for the clone alone); one key and sixteen, two calls on one
 * brand-new backend.
 *
 * Oracle: PostgreSQL's pg_stat_statements, track all, its plans and calls of the clone's statements before and after the
 * second call, and the catalog rows of the session's own relations and functions.
 */

import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { callsGen, runCalls } from "#test/pg/adapter/second-call.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A brand-new backend's second call of a write plans nothing and changes no catalog row of its session's own. */
export const aBrandNewBackendsSecondCallOfAWritePlansNothingAndChangesNoCatalogRowOfItsSessionsOwn =
	property.exhaust(finite(callsGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["one key", "sixteen keys"],
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
			name: "pg_stat_statements' plans and calls of the clone's statements around the second call, none planned and some run, and the catalog rows of the session's temporary relations and functions, unchanged"
		},
		box: "a put of one key and of sixteen of a candidate-keyed relation a rule over a query reads, two calls on one brand-new backend of a served Db",
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
				original: `\t\t\treturn out.line(\`SELECT \${printObjectName(objectName(temporarySchema, statement.name))}()\`)\n`,
				replacement:
					"\t\t\treturn writeDoBlock(out, { declare: [], body: [sessionTableEmptied(statement.name)] })\n",
				why: "A carrier's emptying is a DO block of its body, which PostgreSQL compiles anew at every run: its size check and its DELETE are planned at every call, the second's among them."
			}
		]
	})

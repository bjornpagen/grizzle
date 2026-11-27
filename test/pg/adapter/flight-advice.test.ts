/**
 * A Db transaction's statements are planned under the advice its prologue sets (CARRY THE PLAN, Law 1's vehicle): the
 * prologue's `enter` sets pg_plan_advice.advice local to the transaction (deploy/ledger/ledger.ts enterQuery, its $4
 * the frame's advice, wire/batch.ts enterOf), and the flight sends it ahead of every statement, so the server executes
 * it before it binds, and so plans, any statement behind it: a prepared statement's first Bind in a session, where
 * PostgreSQL makes the generic plan it keeps for the session, is planned under that transaction's advice, never the
 * session's before it.
 *
 * Each case, on a fresh clone (flight-advice.fixtures.ts runTiming): a table of 32 rows keyed by k; on one new session,
 * a transaction whose advice reads the table whole or through its key's index sends the key's read, which the session
 * prepares and plans there; a second transaction, of advice naming another alias, asks EXPLAIN of the plan the session
 * kept, which PostgreSQL answers without planning again.
 *
 * Oracle: the specification, the kept plan's scan the first transaction's advice names, whichever the planner would
 * pick, the read run.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { planNodeOf, runTiming, timingCases } from "#test/pg/adapter/flight-advice.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A prepared statement a Db transaction sends is planned at its first Bind under the advice that transaction's prologue sets. */
export const aStatementIsPlannedUnderItsTransactionsAdvice = property.explore(timingCases, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: ["read whole", "read through the key's index"],
	budget: { runs: 8, steered: 16 },
	check:
		({ substrate }, c) =>
		(x) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.map(runTiming(x), (ran) => {
						c.note(x.scan === "seq" ? "read whole" : "read through the key's index")
						assert.deepEqual(
							{
								first: ran.first,
								scanned: Arr.some(ran.plan, Str.includes(planNodeOf[x.scan]))
							},
							{ first: "ran", scanned: true },
							Arr.join(ran.plan, "\n")
						)
					})
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the plan a session keeps of a statement it first bound in a Db transaction reads the table by the scan that transaction's advice names, a second transaction's advice of another alias aside, the read run"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/wire/batch.ts",
			original: "\t\ttextParam(frame.advice)\n",
			replacement: '\t\ttextParam("")\n',
			why: "A transaction's prologue sets no advice, so a statement it sends is planned, and its plan kept for the session, by PostgreSQL's costs alone; the property fails at the scan the planner would not have picked."
		},
		{
			file: "packages/engine/src/deploy/ledger/ledger.ts",
			original: '\t\t\ttargetAs(localSetting(adviceSettingName, 4), "c4")\n',
			replacement: '\t\t\ttargetAs(lit.bool(true), "c4")\n',
			why: "The prologue binds the advice but sets none, so every statement of the transaction is planned under the session's advice, none; the property fails."
		}
	]
})

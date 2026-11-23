/**
 * What a migration statement's refusal tells its operator beside the server's report (adapter/migrate/errors.ts
 * StatementFailed): a drop of something in use (55006), a replication slot a leader still streams from, is told to stop
 * that leader and migrate again, since grizzle signals no other process's backend; a statement over an object the
 * catalog departs in is told the installation may have drifted; any other refusal is the server's report alone.
 *
 * The box: every SQLSTATE the runtime branches on (core/sqlstate.ts sqlstates), each a statement's refusal.
 *
 * Oracle: the specification of each fix, by the state alone.
 *
 * Features: a drop of something in use, a statement over a departed object, any other refusal.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Record as Rec, String as Str } from "effect"
import { ServerError } from "#adapter/errors/failures.ts"
import { StatementFailed } from "#adapter/migrate/errors.ts"
import { catalogDeparted, type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"

type Refused =
	| "a drop of something in use"
	| "a statement over a departed object"
	| "any other refusal"

/** Every SQLSTATE the runtime branches on, once each. */
const states = nonEmpty(Rec.values(sqlstates), "the SQLSTATEs the runtime branches on")

/** The fix's words a drop of something in use is told, and no other refusal. */
const stopTheLeader = "stop the leaders of the deployment before this one"

/** The refusal of statement 1 of a folder's first file with `sqlstate`, the server's report naming nothing else. */
const refusedWith = (sqlstate: Sqlstate): StatementFailed =>
	new StatementFailed({
		schema: "s",
		folder: "20260101000000_f",
		file: "01-setup.sql",
		statement: 1,
		failure: new ServerError({
			sqlstate,
			message: `refused with ${sqlstate}`,
			constraint: undefined,
			schema: undefined,
			table: undefined,
			column: undefined,
			dataType: undefined,
			detail: undefined,
			hint: undefined
		}),
		laws: []
	})

/** A drop of something in use is told to stop the leader that streams from it, and no other refusal is. */
export const aDropOfSomethingInUseIsToldToStopItsLeaderAndMigrateAgainAndNoOtherRefusalIs =
	property.exhaust(
		finite((source) => source.draw(element(states))),
		{
			needs: {},
			box: "every SQLSTATE the runtime branches on",
			situations: [
				"a drop of something in use",
				"a statement over a departed object",
				"any other refusal"
			] satisfies ReadonlyArray<Reached<Refused>>,
			check: (_, c: Case<Refused>) => (sqlstate) =>
				Effect.sync(() => {
					const message = refusedWith(sqlstate).message
					const inUse = sqlstate === sqlstates.objectInUse
					assert.equal(
						Str.includes(stopTheLeader)(message),
						inUse,
						`${sqlstate}: the in-use fix exactly for 55006: ${message}`
					)
					c.note(
						inUse
							? "a drop of something in use"
							: catalogDeparted.has(sqlstate)
								? "a statement over a departed object"
								: "any other refusal"
					)
				}),
			oracle: {
				kind: "specification",
				name: "the in-use fix exactly for 55006, by the state alone"
			},
			kept: [],
			kills: [
				{
					file: "packages/grizzle/src/adapter/migrate/errors.ts",
					original:
						'\tfailure._tag === "ServerError" && failure.sqlstate === sqlstates.objectInUse',
					replacement: "\tfalse",
					why: "A drop of a slot a leader still streams from is told nothing beside the server's 55006, so the operator of an upgrade that drops a former leader's slot is never told to stop that leader."
				}
			]
		}
	)

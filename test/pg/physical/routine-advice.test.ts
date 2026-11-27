/**
 * A routine carries its own plan advice (sql/ast.ts CreateFunction `advice`), printed as a SET clause beside its
 * search_path (sql/print.ts createFunctionBlock): PostgreSQL sets it on every call of the routine and gives the caller's
 * back on return, so each plan and replan of a statement the routine runs, a PL/pgSQL plan cached for the session
 * among them, is made under the routine's own advice, never its caller's, a Db transaction's included, whose own holds
 * again once the routine returns.
 *
 * Each case, inside one owner transaction of the shared clone that rolls back: a PL/pgSQL routine of a drawn plan's
 * advice, printed by the one printer, created; the caller's advice, another drawn plan's or none, set local to the
 * transaction as a Db's prologue sets it; the routine called, which answers whether the advice in force inside it is its
 * own; then the advice in force read after it returned.
 *
 * Oracle: the specification, the routine's own advice inside its call and the caller's after it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { routineCases, runRoutine } from "#test/pg/physical/routine-advice.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A routine's statements are planned under its own advice in every call, and its caller's holds again after it returns. */
export const aRoutineIsPlannedUnderItsOwnAdviceInEveryCall = property.explore(routineCases, {
	needs: { tx: Substrate.rolledBack(baseSubstrate) },
	situations: ["a caller under advice of its own", "a caller under none"],
	check:
		({ tx }, c) =>
		(x) =>
			Effect.flatMap(tx, ({ connection }) =>
				Effect.map(runRoutine(connection, x), (ran) => {
					c.note(x.caller === "" ? "a caller under none" : "a caller under advice of its own")
					assert.deepEqual(ran, { sawOwn: ["true"], after: [x.caller] })
				})
			),
	oracle: {
		kind: "specification",
		name: "inside a call of a routine created with its own advice, that advice is in force; after the call, the caller's transaction's advice, a drawn plan's or none"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original: `SET search_path = \${printedSearchPath}\${adviceClause(fn.advice)}\`\n`,
			replacement: `SET search_path = \${printedSearchPath}\`\n`,
			why: "An installed routine carries no advice of its own, so every plan and replan of its statements is made under its caller's, a Db transaction's advice naming other relations, or none at all, the planner's costs alone; the property fails, the routine seeing its caller's advice."
		}
	]
})

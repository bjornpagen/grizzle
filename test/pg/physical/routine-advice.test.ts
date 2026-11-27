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
import {
	declaredCases,
	routineCases,
	runDeclared,
	runRoutine
} from "#test/pg/physical/routine-advice.fixtures.ts"
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

/**
 * An application's declared function runs under no advice, its caller's included (sql/print.ts declaredAdviceClause):
 * grizzle proves no plan of its body, and a body that reads a relation under an alias a scope mints, `r1`, would
 * otherwise be planned under an item of the calling transaction's advice of that alias. Each case, inside one owner
 * transaction of the shared clone that rolls back: a declared SQL function whose body reads pg_class as `r1` and answers
 * the advice in force where it is planned, created by its one printer; the caller's advice, a drawn plan's or none, set
 * local as a Db's prologue sets it; the function called. Oracle: the specification, the empty advice inside, the
 * caller's after.
 */
export const aDeclaredFunctionIsPlannedUnderNoAdvice = property.explore(declaredCases, {
	needs: { tx: Substrate.rolledBack(baseSubstrate) },
	situations: ["a caller under advice of its own", "a caller under none"],
	check:
		({ tx }, c) =>
		(x) =>
			Effect.flatMap(tx, ({ connection }) =>
				Effect.map(runDeclared(connection, x), (ran) => {
					c.note(x.caller === "" ? "a caller under none" : "a caller under advice of its own")
					assert.deepEqual(ran, { inside: [""], after: [x.caller] })
				})
			),
	oracle: {
		kind: "specification",
		name: "inside a call of a declared function the empty advice is in force, whatever its caller's; after it, the caller's"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original: `.join(", ")}\${declaredAdviceClause}\`\n`,
			replacement: `.join(", ")}\`\n`,
			why: "A declared function plans its body under its caller's advice, whose items name relations by the aliases a grizzle scope mints, so a body that reads one under the same alias is held to a scan grizzle proved of another statement; the property fails, the function seeing the caller's advice."
		}
	]
})

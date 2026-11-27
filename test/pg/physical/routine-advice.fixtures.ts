import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Predicate } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { type Advice, printAdvice } from "#compiler/sql/advice.ts"
import { type CreateDeclaredFunction, declaredBody, type PlFunction } from "#compiler/sql/ast.ts"
import { call, eq, lit, types } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { adviceSettingName } from "#compiler/sql/print.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { planGen } from "#test/unit/sql/advice.fixtures.ts"

/**
 * A case: the routine's own advice, the printed advice of a drawn plan (sql/advice.ts printAdvice over
 * test/unit/sql/advice.fixtures.ts planGen), and the advice its caller's transaction is in force under, another plan's
 * or none.
 */
export interface RoutineCase {
	readonly own: Advice
	readonly caller: string
}

/** A drawn plan's advice: every drawn plan holds a level, and so an item, whose NO_GATHER it prints at least. */
const adviceGen: Gen<Advice> = (source) =>
	defined(printAdvice(source.draw(planGen)), "the advice of a plan of an item")

/** A routine's advice and its caller's, drawn apart. */
export const routineCases: Gen<RoutineCase> = (source) => ({
	own: source.draw(adviceGen),
	caller: source.draw(boolean) ? source.draw(adviceGen) : ""
})

/** The schema a case's routine is created in, inside the case's transaction, which rolls it back. */
const caseSchema = "routine_advice"

/**
 * The routine of a case: a PL/pgSQL function of `own` advice whose body answers whether the advice in force inside the
 * call is its own, `current_setting('pg_plan_advice.advice') = '<own>'`, printed by the one printer every installed
 * routine is printed by (sql/print.ts createFunctionBlock).
 */
const routineOf = (own: Advice): PlFunction => ({
	kind: "createFunction",
	language: "plpgsql",
	name: { schema: caseSchema, name: "own_advice" },
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	returns: "boolean",
	params: [],
	advice: own,
	body: {
		declare: [],
		body: [
			{
				kind: "return",
				value: eq(
					call("current_setting", [lit.text(adviceSettingName, types.text)]),
					lit.text(own, types.text)
				)
			}
		]
	}
})

/** One owner statement's text cells, in order. */
const cells = (connection: PgConnection, sql: string, params: ReadonlyArray<unknown>) =>
	Effect.map(connection.queryValues(sql, params), (rows) =>
		Arr.flatMap(rows, (row) => Arr.filter(row, Predicate.isString))
	)

/**
 * A case on the owner's connection, in its one transaction: the routine created, the caller's advice set local to the
 * transaction as a Db's prologue sets it, then the routine called, and the advice in force read again after it returns.
 * What it answers: whether the call saw its own advice, and the advice in force after it.
 */
export const runRoutine = (connection: PgConnection, x: RoutineCase) =>
	Effect.gen(function* () {
		const created = emit(routineOf(x.own), emptyNameMap)
		if (!created.ok) {
			return yield* Effect.die(created.error)
		}
		yield* connection.query(`CREATE SCHEMA ${quoteIdent(caseSchema)}`, [])
		yield* connection.query(created.value.text, [])
		yield* connection.query("SELECT pg_catalog.set_config($1, $2, true)", [
			adviceSettingName,
			x.caller
		])
		const sawOwn = yield* cells(
			connection,
			`SELECT ${quoteIdent(caseSchema)}."own_advice"()::text`,
			[]
		)
		const after = yield* cells(connection, "SELECT pg_catalog.current_setting($1)", [
			adviceSettingName
		])
		return { sawOwn, after }
	})

/** A declared function's case: the advice its caller's transaction is in force under, a drawn plan's or none. */
export interface DeclaredCase {
	readonly caller: string
}

/** A caller's advice, a drawn plan's or none. */
export const declaredCases: Gen<DeclaredCase> = (source) => ({
	caller: source.draw(boolean) ? source.draw(adviceGen) : ""
})

/**
 * A declared function as the application declares one (sql/ast.ts CreateDeclaredFunction), printed by its one printer
 * (sql/print.ts createDeclaredFunction): an SQL body that reads a system catalog every role reads, under the alias a
 * scope mints first, `r1`, and answers the advice in force where its statement is planned.
 */
const declaredOf: CreateDeclaredFunction = {
	kind: "createDeclaredFunction",
	name: { schema: caseSchema, name: "declared_advice" },
	params: [],
	returns: types.text,
	language: "sql",
	volatility: "STABLE",
	nullInput: undefined,
	namedAlone: [],
	body: declaredBody(
		"SELECT pg_catalog.current_setting('pg_plan_advice.advice') FROM pg_catalog.pg_class AS r1 WHERE r1.oid = 'pg_catalog.pg_class'::pg_catalog.regclass"
	)
}

/**
 * A declared function's case on the owner's connection, in its one transaction: the function created, the caller's
 * advice set local to the transaction as a Db's prologue sets it, then the function called. What it answers: the advice
 * in force inside the call, and after it.
 */
export const runDeclared = (connection: PgConnection, x: DeclaredCase) =>
	Effect.gen(function* () {
		const created = emit(declaredOf, emptyNameMap)
		if (!created.ok) {
			return yield* Effect.die(created.error)
		}
		yield* connection.query(`CREATE SCHEMA ${quoteIdent(caseSchema)}`, [])
		yield* connection.query(created.value.text, [])
		yield* connection.query("SELECT pg_catalog.set_config($1, $2, true)", [
			adviceSettingName,
			x.caller
		])
		const inside = yield* cells(
			connection,
			`SELECT ${quoteIdent(caseSchema)}."declared_advice"()`,
			[]
		)
		const after = yield* cells(connection, "SELECT pg_catalog.current_setting($1)", [
			adviceSettingName
		])
		return { inside, after }
	})

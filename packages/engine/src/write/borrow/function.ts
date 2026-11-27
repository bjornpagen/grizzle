/**
 * The installed borrow function of a schema, `<schema>.__borrow(ids bigint[], exclusive boolean[]) RETURNS void`
 * (core/identity.ts identity.borrow): the one function every lock a call borrows is taken by. It walks its two arrays
 * in lockstep, in subscript order, and takes each id's transaction-scoped advisory lock, exclusive where `exclusive`
 * holds at its subscript and shared otherwise, so a caller that hands it its ids in order takes them in that order, an
 * order PL/pgSQL's FOR over a query with ORDER BY states (PostgreSQL 19 documentation, "Looping Through Query
 * Results"), whatever the planner does with the statement that calls it. NULL arrays, a call that borrows nothing,
 * take no lock. Every role executes it (physical/ddl/roles.ts); it reads and writes no table, and a lock it takes is
 * the transaction's until it ends.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	CreateFunction,
	Expr,
	FunctionName,
	FunctionParam,
	Revoke,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	arrayOf,
	asc,
	call,
	col,
	core,
	distinctCore,
	lit,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

export const borrowFunctionName: string = identifierOf(identity.borrow())

/** An array of a builtin type with one. */
const arrayType = (element: TypeRef): TypeRef =>
	defined(arrayOf(element), "an array of a builtin type")

/** The lock ids, in the order they are taken. */
const idsParam: FunctionParam = { name: "ids", type: arrayType(types.bigint) }

/** Whether each id at its subscript is taken exclusive. */
const exclusiveParam: FunctionParam = { name: "exclusive", type: arrayType(types.boolean) }

/** The subscript the walk is at. */
const at = "at"

export const borrowFunction = (schema: string): FunctionName => ({
	schema,
	name: borrowFunctionName,
	args: [idsParam.type, exclusiveParam.type]
})

const v = (name: string): Expr => ({ kind: "plVar", name })

/** One of the arrays at the walk's subscript. */
const atWalk = (array: FunctionParam): Expr => ({
	kind: "subscript",
	array: v(array.name),
	index: v(at)
})

/** PERFORM <lock>(ids[at]). */
const lockAt = (lock: "pg_advisory_xact_lock" | "pg_advisory_xact_lock_shared") => ({
	kind: "perform" as const,
	query: {
		body: core([target(call(lock, [atWalk(idsParam)]))], [], undefined),
		orderBy: [],
		limit: undefined,
		offset: undefined
	}
})

/** The borrow function's DDL: its CREATE FUNCTION, then the REVOKE EXECUTE ... FROM PUBLIC that follows it at once. */
export const borrowFunctionDdl = (schema: string): readonly [CreateFunction, Revoke] => [
	{
		kind: "createFunction",
		advice: noAdvice,
		language: "plpgsql",
		name: { schema, name: borrowFunctionName },
		params: [idsParam, exclusiveParam],
		returns: "void",
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: {
			declare: [{ name: at, type: types.integer }],
			body: [
				{
					kind: "forQuery",
					variable: at,
					query: {
						...select(
							distinctCore(
								[target(col("r1", "c1"))],
								[
									{
										kind: "function",
										call: call("generate_subscripts", [
											v(idsParam.name),
											lit.int(1, types.integer)
										]),
										alias: "r1",
										columns: { kind: "named", names: ["c1"], ordinality: false },
										lateral: false
									}
								],
								undefined
							)
						),
						orderBy: [asc(col("r1", "c1"))]
					},
					body: [
						{
							kind: "if",
							branches: [
								{
									condition: atWalk(exclusiveParam),
									body: [lockAt("pg_advisory_xact_lock")]
								}
							],
							else: [lockAt("pg_advisory_xact_lock_shared")]
						}
					]
				}
			]
		}
	},
	{
		kind: "revoke",
		privileges: ["EXECUTE"],
		on: { kind: "FUNCTION", names: [borrowFunction(schema)] },
		from: [{ kind: "PUBLIC" }]
	}
]

import { Array as Arr, Effect, Record as Rec, Result as EffectResult } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Expr, Insert, ObjectName, Select } from "#compiler/sql/ast.ts"
import {
	builtinType,
	call,
	col,
	table as fromTable,
	lit,
	simpleSelect,
	targetAs
} from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printExpr, printObjectName } from "#compiler/sql/print.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { InstallPlan, OracleTable } from "#test/support/oracle/install/model.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"

type Fact = Readonly<Record<string, unknown>>
export type FactSet = Readonly<Record<string, ReadonlyArray<Fact>>>

/** The most rows one INSERT carries. */
const rowsPerStatement = 1000

const refuse = (location: string, capability: string): Result.Result<never, CompileError> =>
	Result.err(malformedDescription(SourceLoc(location, []), capability))

/**
 * SELECT setval('<seq>'::regclass, greatest(r1.last_value, <max>)) AS c1 FROM <seq> AS r1: the sequence moves past
 * `max` and never backwards.
 */
const advanceSequence = (sequence: ObjectName, max: bigint): Select =>
	simpleSelect(
		[
			targetAs(
				call("setval", [
					lit.text(printObjectName(sequence), builtinType("regclass")),
					{ kind: "greatest", args: [col("r1", "last_value"), lit.int(max, builtinType("bigint"))] }
				]),
				"c1"
			)
		],
		[fromTable(sequence.schema, sequence.name, "r1")],
		undefined
	)

/**
 * The INSERT statements, in load order, that store `facts` in the installed plan.
 * A sequence-backed column's value in a fact literalFor admitted: an integer carrier's host value.
 */
const sequenceValue = (value: unknown, field: string): bigint => {
	if (typeof value === "bigint") {
		return value
	}
	if (typeof value === "number") {
		return BigInt(value)
	}
	throw new Error(`the sequence-backed field ${field} holds ${typeof value}, not an integer`)
}

export const factStatements = (
	plan: InstallPlan,
	facts: FactSet
): Result.Result<ReadonlyArray<string>, CompileError> => {
	for (const relation of Rec.keys(facts)) {
		if (!Rec.has(plan.tables, relation)) {
			return refuse(
				formatLoc(SourceLoc(`facts of ${relation}`, [plan.declared, "facts", relation])),
				Rec.has(plan.enums, relation)
					? `${relation} is a closed relation, whose facts the schema declares`
					: `${relation} is no stored relation of the installed schema`
			)
		}
	}
	const statements: Array<string> = []
	for (const relation of plan.loadOrder) {
		const table = plan.tables[relation]
		if (table === undefined) {
			throw new Error(`the load order names ${relation}, which the plan has no table for`)
		}
		const given = Rec.has(facts, relation) ? (facts[relation] ?? []) : []
		const emitted = relationStatements(plan, relation, table, given)
		if (!emitted.ok) {
			return Result.err(emitted.error)
		}
		statements.push(...emitted.value)
	}
	return Result.ok(statements)
}

/** One fact as the row of typed literals its relation's INSERT stores. */
const factRow = (
	table: OracleTable,
	fact: Fact,
	location: string
): Result.Result<ReadonlyArray<Expr>, CompileError> => {
	const row: Array<Expr> = []
	for (const column of table.columns) {
		const expr = literalFor(column.type, fact[column.field], `${location}.${column.field}`)
		if (EffectResult.isFailure(expr)) {
			return Result.err(expr.failure)
		}
		row.push(expr.success)
	}
	return Result.ok(row)
}

/** One relation's statements: its distinct facts in chunks of INSERTs, then each sequence advanced past them. */
const relationStatements = (
	plan: InstallPlan,
	relation: string,
	table: OracleTable,
	given: ReadonlyArray<Fact>
): Result.Result<ReadonlyArray<string>, CompileError> => {
	const fields = Arr.map(table.columns, (c) => c.field)
	const rows: Array<ReadonlyArray<Expr>> = []
	const seen = new Set<string>()
	const maxima = new Map<string, bigint>()
	for (const [index, fact] of given.entries()) {
		const location = formatLoc(
			SourceLoc(`fact ${relation}[${index}]`, [plan.declared, "facts", relation, index])
		)
		const keys = Rec.keys(fact)
		if (keys.length !== fields.length || !Arr.every(keys, (k) => fields.includes(k))) {
			return refuse(
				location,
				`a complete fact of ${relation}: exactly the fields ${Arr.join(fields, ", ")}`
			)
		}
		const row = factRow(table, fact, location)
		if (!row.ok) {
			return Result.err(row.error)
		}
		for (const column of Arr.filter(table.columns, (c) => c.sequence.kind === "identity")) {
			const value = sequenceValue(fact[column.field], column.field)
			const max = maxima.get(column.field)
			maxima.set(column.field, max === undefined || value > max ? value : max)
		}
		const identity = Arr.join(Arr.map(row.value, printExpr), "\u0000")
		if (!seen.has(identity)) {
			seen.add(identity)
			rows.push(row.value)
		}
	}
	const statements: Array<string> = []
	const serial = Arr.some(table.columns, (c) => c.sequence.kind === "identity")
	for (let start = 0; start < rows.length; start += rowsPerStatement) {
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: table.name,
			alias: undefined,
			columns: Arr.map(table.columns, (c) => c.column),
			overriding: serial ? "SYSTEM VALUE" : undefined,
			source: { kind: "values", rows: rows.slice(start, start + rowsPerStatement) },
			onConflict: undefined,
			returning: []
		}
		const emitted = emit(insert, emptyNameMap, unmetered)
		if (!emitted.ok) {
			return Result.err(emitted.error)
		}
		statements.push(emitted.value.text)
	}
	for (const column of table.columns) {
		const max = maxima.get(column.field)
		const advanced =
			column.sequence.kind === "none" || max === undefined || max < 1n
				? undefined
				: emit(advanceSequence(column.sequence.name, max), emptyNameMap, unmetered)
		if (advanced !== undefined && !advanced.ok) {
			return Result.err(advanced.error)
		}
		if (advanced !== undefined) {
			statements.push(advanced.value.text)
		}
	}
	return Result.ok(statements)
}

/**
 * Fact loading for the oracle: a loader emitting typed literal INSERTs.
 *
 * A fact set maps each stored relation to its facts, each a complete record of the relation's fields. The loader
 * emits one INSERT ... VALUES of typed literals per relation (in chunks), in the plan's load order so every immediate
 * foreign key is satisfied when its statement ends. Facts are a set: an exact repeat of a fact in the input collapses
 * on the host, so the loader never asks PostgreSQL to store a duplicate tuple. Two facts that are equal
 * under native equality but spelled differently (1.0 and 1.00 in a key), or that conflict at a key, are left to
 * PostgreSQL, which refuses them with 23505 as it would any direct writer.
 *
 * A relation with a serial field is loaded with OVERRIDING SYSTEM VALUE, because its facts carry their values, and
 * the load then advances each identity sequence past the largest value it stored, in the same transaction, as an
 * addition that supplies serial values does.
 *
 * Loads `facts` in one transaction on `connection`, which needs INSERT on every loaded relation and, for serial
 * fields, SELECT and UPDATE on their sequences: the owner.
 */
export const loadFacts = (
	connection: PgConnection,
	plan: InstallPlan,
	facts: FactSet
): Effect.Effect<void, CompileError | SqlError | TransactionRolledBack> =>
	Effect.flatMap(fromEngine(factStatements(plan, facts)), (statements) =>
		transaction(connection, statements)
	)

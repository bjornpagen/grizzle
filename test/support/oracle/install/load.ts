import { Array as Arr, Effect, Option, Record as Rec, Result as EffectResult } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Expr, Insert, ObjectName, Select } from "#compiler/sql/ast.ts"
import {
	builtinType,
	call,
	col,
	lit,
	provedSelect,
	table as fromTable,
	targetAs
} from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { type FilledRelation, familyRows } from "#test/support/oracle/install/fill.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { InstallPlan, OracleColumn, OracleTable } from "#test/support/oracle/install/model.ts"
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
	provedSelect(
		"keyed",
		[
			targetAs(
				call("setval", [
					{ kind: "regclass", relation: sequence },
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
	const filled = familyRows(plan, facts)
	if (!filled.ok) {
		return Result.err(filled.error)
	}
	for (const relation of Rec.keys(facts)) {
		if (!Rec.has(plan.tables, relation)) {
			return refuse(
				formatLoc(SourceLoc(`facts of ${relation}`, [plan.declared, "facts", relation])),
				Rec.has(plan.rosters, relation)
					? `${relation} is a roster, whose handles the schema declares`
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
		const family = filled.value.get(relation)
		const rows =
			family === undefined ? factRows(plan, relation, table, given) : filledRows(table, family)
		if (!rows.ok) {
			return Result.err(rows.error)
		}
		const emitted = relationStatements(table, rows.value)
		if (!emitted.ok) {
			return Result.err(emitted.error)
		}
		appendAll(statements, emitted.value)
	}
	return Result.ok(statements)
}

/**
 * A column one relation's INSERTs write: a field's, with its sequence where it is serial, or a family's drawn law
 * column, which no sequence draws.
 */
type WrittenColumn = Pick<OracleColumn, "field" | "column" | "type" | "sequence">

/** The rows one relation's INSERTs store: their columns, and each row's values in their order, at its location. */
interface RelationRows {
	readonly columns: ReadonlyArray<WrittenColumn>
	readonly rows: ReadonlyArray<{
		readonly values: ReadonlyArray<unknown>
		readonly location: string
	}>
}

/** A relation's facts as its rows, each a complete fact: exactly the fields of the relation, which no family names. */
const factRows = (
	plan: InstallPlan,
	relation: string,
	table: OracleTable,
	given: ReadonlyArray<Fact>
): Result.Result<RelationRows, CompileError> => {
	const fields = Arr.map(table.columns, (c) => c.field)
	const rows: Array<RelationRows["rows"][number]> = []
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
		rows.push({ values: Arr.map(fields, (f) => fact[f]), location })
	}
	return Result.ok({ columns: table.columns, rows })
}

/** A family relation's filled rows (fill.ts familyRows), each field's column the table's own. */
const filledRows = (
	table: OracleTable,
	filled: FilledRelation
): Result.Result<RelationRows, CompileError> => {
	const columns: Array<WrittenColumn> = []
	for (const c of filled.columns) {
		if (c.kind === "law") {
			columns.push({ field: c.column, column: c.column, type: c.type, sequence: { kind: "none" } })
			continue
		}
		const column = Arr.findFirst(table.columns, (t) => t.field === c.field)
		if (Option.isNone(column)) {
			return refuse(table.location, `a column of ${table.relation} for its field ${c.field}`)
		}
		columns.push(column.value)
	}
	return Result.ok({
		columns,
		rows: Arr.map(filled.rows, (values, index) => ({
			values,
			location: `${table.location}, filled row ${index}`
		}))
	})
}

/** One row as the typed literals its relation's INSERT stores. */
const literalRow = (
	columns: ReadonlyArray<WrittenColumn>,
	values: ReadonlyArray<unknown>,
	location: string
): Result.Result<ReadonlyArray<Expr>, CompileError> => {
	const row: Array<Expr> = []
	for (const [i, column] of columns.entries()) {
		const expr = literalFor(column.type, values[i], `${location}.${column.field}`)
		if (EffectResult.isFailure(expr)) {
			return Result.err(expr.failure)
		}
		row.push(expr.success)
	}
	return Result.ok(row)
}

/** One relation's statements: its distinct rows in chunks of INSERTs, then each sequence advanced past them. */
const relationStatements = (
	table: OracleTable,
	given: RelationRows
): Result.Result<ReadonlyArray<string>, CompileError> => {
	const rows: Array<ReadonlyArray<Expr>> = []
	const seen = new Set<string>()
	const maxima = new Map<string, bigint>()
	for (const { values, location } of given.rows) {
		const row = literalRow(given.columns, values, location)
		if (!row.ok) {
			return Result.err(row.error)
		}
		for (const [i, column] of given.columns.entries()) {
			if (column.sequence.kind !== "identity") {
				continue
			}
			const value = sequenceValue(values[i], column.field)
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
	const serial = Arr.some(given.columns, (c) => c.sequence.kind === "identity")
	const columns = Arr.map(given.columns, (c) => c.column)
	if (!Arr.isReadonlyArrayNonEmpty(columns)) {
		return refuse(
			formatLoc(SourceLoc(`facts of ${table.relation}`, [])),
			"a table of at least one column"
		)
	}
	for (const chunk of Arr.chunksOf(rows, rowsPerStatement)) {
		const insert: Insert = {
			kind: "insert",
			with: undefined,
			table: table.name,
			alias: undefined,
			columns,
			overriding: serial ? "SYSTEM VALUE" : undefined,
			source: { kind: "values", rows: chunk },
			onConflict: undefined,
			returning: []
		}
		const emitted = emit(insert, emptyNameMap)
		if (!emitted.ok) {
			return Result.err(emitted.error)
		}
		statements.push(emitted.value.text)
	}
	for (const column of given.columns) {
		const max = maxima.get(column.field)
		const advanced =
			column.sequence.kind === "none" || max === undefined || max < 1n
				? undefined
				: emit(advanceSequence(column.sequence.name, max), emptyNameMap)
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
 * A fact set maps each stored relation to its facts, each a complete record of the relation's fields, or, for a relation
 * a family names, a written one: its caller's and serial fields, whose family's drawn values the loader fills as
 * grizzle's host fill does (fill.ts), every column its row layout writes and no generated one. The loader
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

import { Array as Arr, Effect, Option, Record as Rec, Result } from "effect"
import type { Expr, Insert, SqlStatement } from "#compiler/sql/ast.ts"
import { col, eq } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { defined } from "#test/support/assert.ts"
import {
	type LiveCase,
	type LiveCommit,
	type LiveWrite,
	relationName,
	writesOf
} from "#test/support/live/world.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { InstallPlan, OracleTable } from "#test/support/oracle/install/model.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pgErrorFields, type TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * The live world's direct SQL writer: a session of the role's login that has taken on the role, as the README's direct
 * writer is, writing each commit of a history in one SERIALIZABLE transaction of statements built as typed ASTs over the
 * installation's tables (test/support/oracle/install/model.ts OracleTable) and emitted, never written.
 */

/** A row a direct writer writes: each field's value by its declared name, `id` its key. */
export type DirectRow = Readonly<Record<string, number>>

const columnOf = (table: OracleTable, field: string): string =>
	defined(
		Option.getOrUndefined(Arr.findFirst(table.columns, (c) => c.field === field)),
		`${table.relation}.${field}`
	).column

const literalOf = (table: OracleTable, field: string, value: number): Expr => {
	const column = defined(
		Option.getOrUndefined(Arr.findFirst(table.columns, (c) => c.field === field)),
		`${table.relation}.${field}`
	)
	const literal = literalFor(column.type, value, `${table.relation}.${field}`)
	if (Result.isFailure(literal)) {
		throw new Error(`no literal of ${value} in ${table.relation}.${field}`)
	}
	return literal.success
}

const keyOf = (table: OracleTable, row: DirectRow): Expr =>
	eq(col("r1", columnOf(table, "id")), literalOf(table, "id", defined(row["id"], "the row's id")))

/** A row's fields in its own order: at least one, since every row a writer writes holds its key. */
const fieldsOf = (row: DirectRow): Arr.NonEmptyReadonlyArray<readonly [string, number]> => {
	const entries = Rec.toEntries(row)
	if (!Arr.isReadonlyArrayNonEmpty(entries)) {
		throw new Error("a direct writer's row holds at least its key")
	}
	return entries
}

const insertOf = (table: OracleTable, row: DirectRow): Insert => {
	const fields = fieldsOf(row)
	return {
		kind: "insert",
		with: undefined,
		table: table.name,
		alias: undefined,
		columns: Arr.map(fields, ([f]) => columnOf(table, f)),
		overriding: undefined,
		source: {
			kind: "values",
			rows: [Arr.map(fields, ([f, value]) => literalOf(table, f, value))]
		},
		onConflict: undefined,
		returning: []
	}
}

const deleteOf = (table: OracleTable, row: DirectRow): SqlStatement => ({
	kind: "delete",
	table: table.name,
	alias: "r1",
	where: keyOf(table, row),
	with: undefined,
	using: [],
	returning: []
})

const updateOf = (table: OracleTable, row: DirectRow): SqlStatement => {
	const set = Arr.flatMap(fieldsOf(row), ([f, value]) =>
		f === "id" ? [] : [{ column: columnOf(table, f), value: literalOf(table, f, value) }]
	)
	if (!Arr.isReadonlyArrayNonEmpty(set)) {
		throw new Error("a direct writer's update sets at least one field beside the key")
	}
	return {
		kind: "update",
		table: table.name,
		alias: "r1",
		set,
		where: keyOf(table, row),
		with: undefined,
		from: [],
		returning: []
	}
}

const emitted = (statement: SqlStatement): string => {
	const text = emit(statement, emptyNameMap)
	if (!text.ok) {
		throw new Error(`the direct writer's statement does not emit: ${text.error.message}`)
	}
	return text.value.text
}

/** The table `relation` is installed as in `plan`. */
const tableOf = (plan: InstallPlan, relation: string): OracleTable =>
	defined(plan.tables[relation], `the table of ${relation}`)

/** An INSERT of `row` into `relation`'s table, its fields listed in the row's order. */
export const insertRow = (plan: InstallPlan, relation: string, row: DirectRow): string =>
	emitted(insertOf(tableOf(plan, relation), row))

/** An UPDATE of `relation`'s row at `row`'s id, to its other fields. */
export const updateRow = (plan: InstallPlan, relation: string, row: DirectRow): string =>
	emitted(updateOf(tableOf(plan, relation), row))

/**
 * The statements one write sends: an INSERT, a DELETE by key, and an update an UPDATE of its relation where the relation
 * is mutable, else its DELETE then its INSERT at the same key, since no role holds UPDATE on an immutable relation.
 */
const writeStatements = (
	plan: InstallPlan,
	c: LiveCase,
	write: LiveWrite
): ReadonlyArray<string> => {
	const table = tableOf(plan, relationName(write.relation))
	switch (write.kind) {
		case "insert":
			return [emitted(insertOf(table, write.fact))]
		case "delete":
			return [emitted(deleteOf(table, write.fact))]
		case "update":
			return c.mutable[write.relation]
				? [emitted(updateOf(table, write.to))]
				: [emitted(deleteOf(table, write.from)), emitted(insertOf(table, write.to))]
	}
}

/** Every statement a direct writer's commit sends, in order. */
export const commitStatements = (
	plan: InstallPlan,
	c: LiveCase,
	commit: LiveCommit
): ReadonlyArray<string> =>
	Arr.flatMap(writesOf(commit), (write) => writeStatements(plan, c, write))

/** Whether a failure is one PostgreSQL asks a SERIALIZABLE transaction to run again for: 40001 or 40P01. */
const transient = (error: unknown): boolean => {
	const code = pgErrorFields(error)?.code
	return code === "40001" || code === "40P01"
}

/**
 * Commits `statements` in one SERIALIZABLE transaction of `session`, run again from its BEGIN, as an application runs
 * a transaction again, while PostgreSQL refuses it as transient: a re-run of a subscription beside it may be its
 * serialization's other side. Any other failure fails the case. The transaction commits once, so the history's
 * commits are exactly its commits, in order.
 */
export const commitDirectly = (
	session: RawSession,
	statements: ReadonlyArray<string>
): Effect.Effect<void, SqlError | TransactionRolledBack> =>
	Effect.gen(function* () {
		yield* session.begin
		for (const sql of statements) {
			yield* session.query(sql, [])
		}
		yield* session.commit
	}).pipe(
		Effect.tapError(() => Effect.ignore(session.rollback)),
		Effect.retry({ while: transient })
	)

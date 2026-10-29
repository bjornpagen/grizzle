import {
	Array as Arr,
	Effect,
	Function,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	cast,
	col,
	eq,
	lit,
	ne,
	qualifiedCall,
	simpleSelect,
	table,
	tableCol,
	target,
	types
} from "#compiler/sql/build.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printExpr, printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { valueText } from "#test/pg/laws/families/model.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { OracleTable } from "#test/support/oracle/install/model.ts"
import { carrierOf, sendable } from "#test/support/worlds/execute/host.ts"
import { claimsText } from "#test/support/worlds/model/session/claims.ts"
import type {
	DirectStatement,
	FieldDomain,
	HostFact,
	Isolation,
	RoleRef,
	HostValue,
	ViewFilter,
	WorldFunction
} from "#test/support/worlds/model/types.ts"

/**
 * A direct SQL writer's statements as the SQL a psql session sends: each built as a typed SQL AST over the
 * installation's own names and emitted, but for the session commands no AST node states (BEGIN, SET ROLE, SET SESSION
 * AUTHORIZATION, RESET ROLE, TRUNCATE) and a call of an installed function, whose arguments are untyped literals that
 * take its parameters' types, as a person at a terminal writes them.
 */
export interface DirectNames {
	/** A relation's installed table, as the installer's plan has it. */
	readonly table: (relation: string) => Effect.Effect<OracleTable>
	readonly domain: (relation: string, field: string) => Effect.Effect<FieldDomain>
	/** A role relation's view in its role's schema, and its columns by field, with each field's domain. */
	readonly view: (
		role: string,
		relation: string
	) => Effect.Effect<{
		readonly schema: string
		readonly name: string
		readonly fields: ReadonlyArray<{
			readonly field: string
			readonly column: string
			readonly domain: FieldDomain
		}>
	}>
	/** The PostgreSQL role a reference names. */
	readonly role: (ref: RoleRef) => Effect.Effect<string>
	/** An installed function, schema-qualified and quoted. */
	readonly function: (fn: WorldFunction) => Effect.Effect<string>
}

/** What a statement reads back: nothing, or rows of the fields named, each read by its domain. */
export type Reads =
	| { readonly kind: "none" }
	| {
			readonly kind: "rows"
			readonly fields: ReadonlyArray<{ readonly field: string; readonly domain: FieldDomain }>
	  }

export interface DirectSql {
	readonly sql: string
	readonly reads: Reads
}

const none: Reads = { kind: "none" }

const emitted = (ast: SqlStatement): Effect.Effect<string> => {
	const text = emit(ast, emptyNameMap, unmetered)
	return text.ok
		? Effect.succeed(text.value.text)
		: Effect.die(new Error(`a direct statement does not emit: ${text.error.message}`))
}

const columnOf = (t: OracleTable, field: string): Effect.Effect<OracleTable["columns"][number]> =>
	Option.match(
		Arr.findFirst(t.columns, (x) => x.field === field),
		{
			onNone: () => Effect.die(new Error(`${t.relation} has no column ${field}`)),
			onSome: Effect.succeed
		}
	)

/** A value as a typed literal of its column. */
const literalOf = (
	names: DirectNames,
	t: OracleTable,
	field: string,
	value: HostValue
): Effect.Effect<Expr> =>
	Effect.gen(function* () {
		const c = yield* columnOf(t, field)
		const domain = yield* names.domain(t.relation, field)
		const expr = literalFor(c.type, carrierOf(domain, value), `${t.relation}.${field}`)
		return Result.isFailure(expr)
			? yield* Effect.die(new Error(`no literal of ${valueText(value)} in ${t.relation}.${field}`))
			: expr.success
	})

/** Every field of `fact` equal to its value: the WHERE of a keyed DELETE or UPDATE. */
const matching = (names: DirectNames, t: OracleTable, fact: HostFact): Effect.Effect<Expr> =>
	Effect.map(
		Effect.forEach(Rec.toEntries(fact), ([field, value]) =>
			Effect.flatMap(columnOf(t, field), (c) =>
				Effect.map(literalOf(names, t, field, value), (l) => eq(col("r", c.column), l))
			)
		),
		(parts) => and(...parts)
	)

/** A predicate that divides by zero exactly on the rows whose field reads `value`, true on every other row. */
const raising = (column: Expr, value: HostValue): Expr =>
	eq(
		binary(
			"/",
			lit.int(1, types.integer),
			cast(
				ne(cast(column, types.text), lit.text(valueText(sendable(value)), types.text)),
				types.integer
			)
		),
		lit.int(1, types.integer)
	)

const viewSql = (
	names: DirectNames,
	role: string,
	relation: string,
	filter: ViewFilter
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		const view = yield* names.view(role, relation)
		const where =
			filter.kind === "none"
				? undefined
				: yield* Option.match(
						Arr.findFirst(view.fields, (f) => f.field === filter.field),
						{
							onNone: () =>
								Effect.die(new Error(`the view ${relation} has no field ${filter.field}`)),
							onSome: (f) => Effect.succeed(raising(col("v", f.column), filter.value))
						}
					)
		const sql = yield* emitted(
			simpleSelect(
				Arr.map(view.fields, (f) => target(col("v", f.column))),
				[table(view.schema, view.name, "v")],
				where
			)
		)
		return { sql, reads: { kind: "rows", fields: view.fields } }
	})

const tableSql = (
	names: DirectNames,
	relation: string,
	filter: ViewFilter
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		const t = yield* names.table(relation)
		const fields = yield* Effect.forEach(t.columns, (c) =>
			Effect.map(names.domain(relation, c.field), (domain) => ({
				field: c.field,
				column: c.column,
				domain
			}))
		)
		const where =
			filter.kind === "none"
				? undefined
				: yield* Option.match(
						Arr.findFirst(fields, (f) => f.field === filter.field),
						{
							onNone: () =>
								Effect.die(new Error(`the table of ${relation} has no field ${filter.field}`)),
							onSome: (f) => Effect.succeed(raising(col("r", f.column), filter.value))
						}
					)
		const sql = yield* emitted(
			simpleSelect(
				Arr.map(fields, (f) => target(col("r", f.column))),
				[table(t.name.schema, t.name.name, "r")],
				where
			)
		)
		return { sql, reads: { kind: "rows", fields } }
	})

/**
 * Whether a fact names a serial field's value: a direct writer inserting one writes OVERRIDING SYSTEM VALUE, as the
 * README's writer does (the identity column is GENERATED ALWAYS), whether or not its INSERT resolves a conflict, and
 * then calls the field's advance function (advancesOf).
 */
const namesSerial = (
	names: DirectNames,
	relation: string,
	fields: ReadonlyArray<string>
): Effect.Effect<boolean> =>
	Effect.map(
		Effect.forEach(fields, (f) => names.domain(relation, f)),
		(domains) => Arr.some(domains, (d) => d.kind === "serial")
	)

/** An INSERT that meets a conflicting primary key, resolved by ON CONFLICT: nothing, the existing row, or an update. */
const onConflictSql = (
	names: DirectNames,
	relation: string,
	fact: HostFact,
	resolution: "nothing" | "select" | "update"
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		const t = yield* names.table(relation)
		const fields = Rec.keys(fact)
		const columns = yield* Effect.forEach(fields, (f) =>
			Effect.map(columnOf(t, f), (c) => c.column)
		)
		const values = yield* Effect.forEach(Rec.toEntries(fact), ([f, v]) => literalOf(names, t, f, v))
		const key = yield* Effect.forEach(t.primaryKey.fields, (f) =>
			Effect.map(columnOf(t, f), (c) => c.column)
		)
		const keyed = new Set([...t.primaryKey.fields, ...Arr.flatMap(t.keys, (k) => k.fields)])
		const payload = yield* Effect.forEach(
			Arr.filter(fields, (f) => !keyed.has(f)),
			(f) => Effect.map(columnOf(t, f), (c) => c.column)
		)
		const read = yield* Effect.forEach(t.columns, (c) =>
			Effect.map(names.domain(relation, c.field), (domain) => ({
				field: c.field,
				column: c.column,
				domain
			}))
		)
		/**
		 * What DO UPDATE sets: the fact's columns outside every key to the proposed values, or, for a fact all key, its
		 * primary key's columns to their own, the one update such a writer can state (an empty SET is no statement).
		 */
		const updated = Arr.isReadonlyArrayNonEmpty(payload) ? payload : key
		const action =
			resolution === "nothing"
				? { kind: "doNothing" as const }
				: resolution === "select"
					? { kind: "doSelect" as const, where: undefined }
					: {
							kind: "doUpdate" as const,
							set: Arr.map(updated, (column) => ({ column, value: col("excluded", column) })),
							where: undefined
						}
		const sql = yield* emitted({
			kind: "insert",
			with: undefined,
			table: t.name,
			alias: undefined,
			columns,
			overriding: (yield* namesSerial(names, relation, fields)) ? "SYSTEM VALUE" : undefined,
			source: { kind: "values", rows: [values] },
			onConflict: { kind: "columns", columns: key, action },
			returning: resolution === "select" ? Arr.map(read, (f) => target(tableCol(f.column))) : []
		})
		return { sql, reads: resolution === "select" ? { kind: "rows", fields: read } : none }
	})

/** A MERGE deleting the facts at the given keys: under row security, exactly the ones the role sees. */
const mergeDeleteSql = (
	names: DirectNames,
	relation: string,
	keys: ReadonlyArray<HostFact>
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		const t = yield* names.table(relation)
		const [first] = keys
		if (first === undefined) {
			return yield* Effect.die(new Error(`a MERGE into ${relation} at no key`))
		}
		const fields = Rec.keys(first)
		const columns = yield* Effect.forEach(fields, (f) =>
			Effect.map(columnOf(t, f), (c) => c.column)
		)
		const rows = yield* Effect.forEach(keys, (k) =>
			Effect.map(
				Effect.forEach(fields, (f) => {
					const v = k[f]
					return v === undefined
						? Effect.die(new Error(`a MERGE key without ${f}`))
						: literalOf(names, t, f, v)
				}),
				(exprs) => `(${Arr.join(Arr.map(exprs, printExpr), ", ")})`
			)
		)
		const on = Arr.join(
			Arr.map(columns, (c) => `r.${quoteIdent(c)} = k.${quoteIdent(c)}`),
			" AND "
		)
		const sql = `MERGE INTO ${printObjectName(t.name)} AS r USING (VALUES ${Arr.join(rows, ", ")}) AS k(${Arr.join(Arr.map(columns, quoteIdent), ", ")}) ON ${on} WHEN MATCHED THEN DELETE`
		return { sql, reads: none }
	})

const insertSql = (
	names: DirectNames,
	relation: string,
	fact: HostFact
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		const t = yield* names.table(relation)
		const fields = Rec.keys(fact)
		const columns = yield* Effect.forEach(fields, (f) =>
			Effect.map(columnOf(t, f), (c) => c.column)
		)
		const values = yield* Effect.forEach(Rec.toEntries(fact), ([f, v]) => literalOf(names, t, f, v))
		const sql = yield* emitted({
			kind: "insert",
			with: undefined,
			table: t.name,
			alias: undefined,
			columns,
			overriding: (yield* namesSerial(names, relation, fields)) ? "SYSTEM VALUE" : undefined,
			source: { kind: "values", rows: [values] },
			onConflict: undefined,
			returning: []
		})
		return { sql, reads: none }
	})

/**
 * The advance calls of the serial fields a fact of `relation` names, key fields first and the rest in the table's
 * order, as grizzle's own write path orders its advances (packages/engine/src/write/serial/advance.ts serialOrder): each
 * a call of the field's advance function with the value the fact names there.
 */
const advancesAfter = (
	names: DirectNames,
	relation: string,
	fact: HostFact
): Effect.Effect<ReadonlyArray<DirectStatement>> =>
	Effect.gen(function* () {
		const t = yield* names.table(relation)
		const key = t.primaryKey.fields
		const order = [
			...key,
			...Arr.filter(
				Arr.map(t.columns, (c) => c.field),
				(f) => !key.includes(f)
			)
		]
		const calls: Array<DirectStatement> = []
		for (const field of order) {
			const value = fact[field]
			if (value !== undefined && (yield* names.domain(relation, field)).kind === "serial") {
				calls.push({ kind: "call", fn: { kind: "advance", relation, field }, args: [value] })
			}
		}
		return calls
	})

/**
 * What the README's direct writer sends after a statement that succeeded, in the same transaction: after an INSERT
 * naming serial values (with or without ON CONFLICT), `SELECT <schema>.<advance function>(<value inserted>)` for each
 * serial field it names (advancesAfter), as grizzle's own writes advance past the values they insert, so a later
 * generated value never repeats a written one (README "Direct SQL access"); after any other statement, nothing. A role that
 * inserts into a table writes it, and so holds EXECUTE on its advance functions, which never move a sequence back: the
 * statement's outcome is its INSERT's.
 */
export const advancesOf = (
	names: DirectNames,
	statement: DirectStatement
): Effect.Effect<ReadonlyArray<DirectStatement>> => {
	switch (statement.kind) {
		case "insert":
		case "insert-on-conflict":
			return advancesAfter(names, statement.relation, statement.fact)
		case "set-role":
		case "reset-role":
		case "set-session-authorization":
		case "set-claims":
		case "select-view":
		case "select-table":
		case "delete":
		case "update":
		case "truncate":
		case "call":
		case "setval":
		case "merge-delete":
		case "prepare":
		case "execute-prepared":
			return Effect.succeed([])
	}
}

const isolationText = (isolation: Isolation): string => Str.toUpperCase(isolation)

/**
 * A role name as a Unicode-escaped quoted identifier, `U&"..."`, as a person at a terminal spells any name: each
 * backslash doubled, each double quote doubled, and a NUL, which no statement text can carry (libpq ends the text at
 * it), written as the escape `\0000`, which PostgreSQL refuses as no character an identifier holds.
 */
const roleIdent = (name: string): string =>
	`U&"${Function.pipe(name, Str.replaceAll("\\", "\\\\"), Str.replaceAll('"', '""'), Str.replaceAll("\u0000", "\\0000"))}"`

/** The BEGIN of a direct writer's transaction at its isolation level. */
export const beginSql = (isolation: Isolation): string =>
	`BEGIN ISOLATION LEVEL ${isolationText(isolation)}`

/** The SQL of one direct statement, and what it reads back. */
export const directSql = (
	names: DirectNames,
	prepared: Map<string, Reads>,
	statement: DirectStatement
): Effect.Effect<DirectSql> =>
	Effect.gen(function* () {
		switch (statement.kind) {
			case "set-role":
				return { sql: `SET ROLE ${roleIdent(yield* names.role(statement.role))}`, reads: none }
			case "reset-role":
				return { sql: "RESET ROLE", reads: none }
			case "set-session-authorization":
				return {
					sql: `SET SESSION AUTHORIZATION ${roleIdent(yield* names.role(statement.role))}`,
					reads: none
				}
			case "set-claims": {
				const setting = statement.setting
				const text = setting.kind === "facts" ? claimsText(setting.facts) : setting.text
				const sql = yield* emitted(
					simpleSelect(
						[
							target(
								qualifiedCall("pg_catalog", "set_config", [
									lit.text("grizzle.claims", types.text),
									lit.text(text, types.text),
									lit.bool(setting.scope === "transaction")
								])
							)
						],
						[],
						undefined
					)
				)
				return { sql, reads: none }
			}
			case "select-view":
				return yield* viewSql(names, statement.role, statement.relation, statement.filter)
			case "select-table":
				return yield* tableSql(names, statement.relation, statement.filter)
			case "insert-on-conflict":
				return yield* onConflictSql(names, statement.relation, statement.fact, statement.onConflict)
			case "merge-delete":
				return yield* mergeDeleteSql(names, statement.relation, statement.keys)
			case "prepare": {
				const read = statement.read
				const body =
					read.kind === "view"
						? yield* viewSql(names, read.role, read.relation, { kind: "none" })
						: yield* tableSql(names, read.relation, { kind: "none" })
				prepared.set(statement.name, body.reads)
				return { sql: `PREPARE ${quoteIdent(statement.name)} AS ${body.sql}`, reads: none }
			}
			case "execute-prepared":
				return {
					sql: `EXECUTE ${quoteIdent(statement.name)}`,
					reads: prepared.get(statement.name) ?? none
				}
			case "insert":
				return yield* insertSql(names, statement.relation, statement.fact)
			case "delete": {
				const t = yield* names.table(statement.relation)
				const sql = yield* emitted({
					kind: "delete",
					table: t.name,
					alias: "r",
					where: yield* matching(names, t, statement.key),
					with: undefined,
					using: [],
					returning: []
				})
				return { sql, reads: none }
			}
			case "update": {
				const t = yield* names.table(statement.relation)
				const set = yield* Effect.forEach(Rec.toEntries(statement.set), ([f, v]) =>
					Effect.flatMap(columnOf(t, f), (c) =>
						Effect.map(literalOf(names, t, f, v), (value) => ({ column: c.column, value }))
					)
				)
				const sql = yield* emitted({
					kind: "update",
					table: t.name,
					alias: "r",
					set,
					where: yield* matching(names, t, statement.key),
					with: undefined,
					from: [],
					returning: []
				})
				return { sql, reads: none }
			}
			case "truncate": {
				const t = yield* names.table(statement.relation)
				return { sql: `TRUNCATE ${printObjectName(t.name)}`, reads: none }
			}
			case "call": {
				const fn = yield* names.function(statement.fn)
				const args = Arr.join(
					Arr.map(statement.args, (a) => quoteString(valueText(sendable(a)))),
					", "
				)
				return { sql: `SELECT ${fn}(${args})`, reads: none }
			}
			case "setval": {
				const t = yield* names.table(statement.relation)
				const c = yield* columnOf(t, statement.field)
				const sequence = `pg_catalog.pg_get_serial_sequence(${quoteString(printObjectName(t.name))}, ${quoteString(c.column)})`
				return {
					sql: `SELECT pg_catalog.setval(${sequence}, ${String(statement.value)})`,
					reads: none
				}
			}
		}
	})

import {
	Array as Arr,
	Effect,
	Function,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { type Codebook, codeNames } from "#compiler/ir/codes.ts"
import type { Expr, InsertTarget, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	cast,
	col,
	eq,
	lit,
	ne,
	provedSelect,
	qualifiedCall,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { printExpr, printObjectName } from "#compiler/sql/print.ts"
import { valueText } from "#test/support/laws/model.ts"
import { literalFor } from "#test/support/oracle/install/literal.ts"
import type { OracleTable } from "#test/support/oracle/install/model.ts"
import { carrierOf } from "#test/support/worlds/execute/host.ts"
import { rosterCodesOf } from "#test/support/worlds/execute/names.ts"
import { claimsText } from "#test/support/worlds/model/session/claims.ts"
import type {
	ContextSpec,
	DirectStatement,
	FieldDomain,
	HostFact,
	Isolation,
	ConflictResolution,
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
	/**
	 * An installed function, schema-qualified and quoted, and its parameters' domains where the installation defines it
	 * (model/session/direct.ts parametersOf), none where it defines no such function.
	 */
	readonly function: (fn: WorldFunction) => Effect.Effect<{
		readonly name: string
		readonly parameters: Option.Option<ReadonlyArray<FieldDomain>>
	}>
	/** The installation's codebook: the code each closed id's column holds for its handle (ir/codes.ts). */
	readonly codes: Codebook
	/** The base's contexts, whose fields' types a facts setting's claims are spelled by. */
	readonly contexts: ReadonlyArray<ContextSpec>
	/** The call of each stand-up of the installation, each where the role may run it (kernel/naming.ts standUpCallsOf). */
	readonly standUps: ReadonlyArray<string>
}

/**
 * Whether `statement` makes the session act as another role, after which its writer sends the stand-ups the role may
 * run (DirectNames standUps), as the README tells a writer outside grizzle (Direct SQL access): each makes what the
 * session holds none of, so a transaction begun again, whose statements are sent again, makes only what the
 * rolled-back one took with it.
 */
export const takesRole = (statement: DirectStatement): boolean =>
	statement.kind === "set-role" || statement.kind === "set-session-authorization"

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
	const text = emit(ast, emptyNameMap)
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

/** Every field of `fact` equal to its value: the WHERE of a keyed DELETE or UPDATE, true for no field. */
const matching = (names: DirectNames, t: OracleTable, fact: HostFact): Effect.Effect<Expr> =>
	Effect.map(
		Effect.forEach(Rec.toEntries(fact), ([field, value]) =>
			Effect.zipWith(columnOf(t, field), literalOf(names, t, field, value), (c, l) =>
				eq(col("r", c.column), l)
			)
		),
		(parts) => (Arr.isReadonlyArrayNonEmpty(parts) ? and(parts) : lit.bool(true))
	)

/**
 * A field's value as its column's text reads it: a closed id's column holds its handle's code, the handle's index in its
 * roster's names (ir/codes.ts); every other value is its own text.
 */
const columnText = (codes: Codebook, domain: FieldDomain, value: HostValue): string => {
	const text = valueText(value)
	if (domain.kind !== "handle") {
		return text
	}
	const code = codeNames(codes)(domain.closed).indexOf(text)
	return code < 0 ? text : String(code)
}

/** A predicate that divides by zero exactly on the rows whose column's text is `text` (columnText), true on every other. */
const raising = (column: Expr, text: string): Expr =>
	eq(
		binary(
			"/",
			lit.int(1, types.integer),
			cast(ne(cast(column, types.text), lit.text(text, types.text)), types.integer)
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
							onSome: (f) =>
								Effect.succeed(
									raising(col("v", f.column), columnText(names.codes, f.domain, filter.value))
								)
						}
					)
		const sql = yield* emitted(
			provedSelect(
				"keyed",
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
							onSome: (f) =>
								Effect.succeed(
									raising(col("r", f.column), columnText(names.codes, f.domain, filter.value))
								)
						}
					)
		const sql = yield* emitted(
			provedSelect(
				"keyed",
				Arr.map(fields, (f) => target(col("r", f.column))),
				[table(t.name.schema, t.name.name, "r")],
				where
			)
		)
		return { sql, reads: { kind: "rows", fields } }
	})

/** What a direct writer's INSERT of one fact writes: a VALUES row of the fact's columns, its key's among them. */
const factTarget = (
	columns: ReadonlyArray<string>,
	values: ReadonlyArray<Expr>
): Effect.Effect<InsertTarget> =>
	Arr.isReadonlyArrayNonEmpty(columns)
		? Effect.succeed({ columns, source: { kind: "values", rows: [values] } })
		: Effect.die(new Error("a fact of no field, where every fact holds its relation's key"))

/**
 * An INSERT that meets a conflicting primary key, resolved by ON CONFLICT: nothing, the existing row, or an update. Its
 * target is the key as PostgreSQL arbitrates it: a key of scalar fields by its columns; a span key, WITHOUT OVERLAPS,
 * only as its constraint and only to do nothing (ON CONSTRAINT, by overlap), since PostgreSQL infers no arbiter for it
 * from a column list (42P10). Its DO SELECT and DO UPDATE are spelled by the key's columns, as a writer would try them,
 * and PostgreSQL refuses them at planning (42P10; through the constraint, 42809), before any privilege is checked. The
 * target is aliased `r`, which the writer's predicate over the stored row names (`raising`) and its RETURNING reads the
 * row by, and DO UPDATE sets each column from EXCLUDED's: every name it reads is bound where it reads it, which the
 * printer holds every statement to (sql/scope.ts, 962f3a9fd4), where its RETURNING named the columns unqualified and
 * its SET read EXCLUDED as a relation no FROM binds.
 */
const onConflictSql = (
	names: DirectNames,
	relation: string,
	fact: HostFact,
	resolution: ConflictResolution
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
		const where = (filter: ViewFilter): Effect.Effect<Expr | undefined> =>
			filter.kind === "none"
				? Effect.undefined
				: Option.match(
						Arr.findFirst(read, (f) => f.field === filter.field),
						{
							onNone: () =>
								Effect.die(new Error(`the table of ${relation} has no field ${filter.field}`)),
							onSome: (f) =>
								Effect.succeed(
									raising(col("r", f.column), columnText(names.codes, f.domain, filter.value))
								)
						}
					)
		const action =
			resolution.kind === "nothing"
				? { kind: "doNothing" as const }
				: resolution.kind === "select"
					? { kind: "doSelect" as const, where: yield* where(resolution.where) }
					: {
							kind: "doUpdate" as const,
							set: assignments(
								ungenerated,
								"r",
								Arr.map(updated, (column) => ({ column, value: { kind: "excluded", column } }))
							),
							where: yield* where(resolution.where)
						}
		const sql = yield* emitted({
			kind: "insert",
			with: undefined,
			table: t.name,
			alias: "r",
			...(yield* factTarget(columns, values)),
			onConflict:
				t.primaryKey.span.kind === "span" && action.kind === "doNothing"
					? { kind: "constraint", constraint: t.primaryKey.name, action }
					: { kind: "columns", columns: key, action },
			returning:
				resolution.kind === "select" ? Arr.map(read, (f) => target(col("r", f.column))) : []
		})
		return { sql, reads: resolution.kind === "select" ? { kind: "rows", fields: read } : none }
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
			...(yield* factTarget(columns, values)),
			onConflict: undefined,
			returning: []
		})
		return { sql, reads: none }
	})

const isolationText = (isolation: Isolation): string => Str.toUpperCase(isolation)

/**
 * A role name as a Unicode-escaped quoted identifier, `U&"..."`, as a person at a terminal spells any name: each
 * backslash doubled, each double quote doubled, and a NUL, which no statement text can carry (libpq ends the text at
 * it), written as the escape `\0000`, which PostgreSQL refuses as no character an identifier holds.
 */
const roleIdent = (name: string): string =>
	`U&"${Function.pipe(name, Str.replaceAll("\\", "\\\\"), Str.replaceAll('"', '""'), Str.replaceAll("\u0000", "\\0000"))}"`

/**
 * An UPDATE that assigns no column, which is no statement: PostgreSQL refuses its text at parse (42601), as the host
 * model refuses it (model/session/direct.ts, "other").
 */
const noAssignmentSql = (table: ObjectName): string => `UPDATE ${printObjectName(table)} SET`

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
			case "set-role": {
				const role = yield* names.role(statement.role)
				return { sql: `SET ROLE ${roleIdent(role)}`, reads: none }
			}
			case "reset-role":
				return { sql: "RESET ROLE", reads: none }
			case "set-session-authorization": {
				const role = yield* names.role(statement.role)
				return { sql: `SET SESSION AUTHORIZATION ${roleIdent(role)}`, reads: none }
			}
			case "set-claims": {
				const setting = statement.setting
				const text =
					setting.kind === "facts"
						? claimsText(names.contexts, rosterCodesOf(names.codes), setting.facts)
						: setting.text
				const sql = yield* emitted(
					provedSelect(
						"oneRow",
						[
							target(
								qualifiedCall(
									{
										kind: "qualified",
										schema: "pg_catalog",
										name: "set_config",
										volatility: "VOLATILE"
									},
									[
										lit.text("grizzle.claims", types.text),
										lit.text(text, types.text),
										lit.bool(setting.scope === "transaction")
									]
								)
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
					Effect.zipWith(columnOf(t, f), literalOf(names, t, f, v), (c, value) => ({
						column: c.column,
						value
					}))
				)
				if (!Arr.isReadonlyArrayNonEmpty(set)) {
					return { sql: noAssignmentSql(t.name), reads: none }
				}
				const sql = yield* emitted({
					kind: "update",
					table: t.name,
					alias: "r",
					set: assignments(ungenerated, "r", set),
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
				/** An argument as its parameter's column text (columnText), or its own where no parameter types it. */
				const argText = (a: HostValue, i: number): string =>
					Option.match(
						Option.flatMap(fn.parameters, (parameters) => Arr.get(parameters, i)),
						{
							onNone: () => valueText(a),
							onSome: (domain) => columnText(names.codes, domain, a)
						}
					)
				const args = Arr.join(
					Arr.map(statement.args, (a, i) => quoteString(argText(a, i))),
					", "
				)
				return { sql: `SELECT ${fn.name}(${args})`, reads: none }
			}
		}
	})

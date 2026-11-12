import { Array as Arr, Data, Option, Order, Result, String as Str } from "effect"
import type { Action } from "#compiler/deploy/diff/plan.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type ColumnDef,
	type Expr,
	type FrameBound,
	type FromItem,
	type FromSource,
	type FunctionCall,
	type ObjectName,
	type PackConstant,
	type OperandSelect,
	type Select,
	type SelectCore,
	type SetOperand,
	type SqlStatement,
	type TableConstraint,
	type TypeRef,
	type Update,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { namedType } from "#compiler/sql/build.ts"
import { printObjectName, printType } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr, transformSelect } from "#compiler/sql/transform.ts"
import { textOfHex } from "#test/support/closed/bit-text.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { transformOperand, testTypeSchema } from "#test/support/sql.ts"
import { upTo } from "#test/support/up-to.ts"

/** Where a cell's value came from.
 *
 * A host model of PostgreSQL's catalog for one schema, and of the rows of its tables, that a reviewed migration runs on
 * statement by statement.
 *
 * Rule: the model runs the reviewed plan's actions in order, each statement with its effects on the catalog
 * and its preconditions, which PostgreSQL's dependency facts state, and fails where PostgreSQL would, with the SQLSTATE
 * it would raise:
 *
 * - Namespaces. Tables, materialized views, sequences and indexes share one relation namespace (pg_class); domains
 *   and the row type of every table and view share the type namespace (pg_type), a sequence and an index
 *   taking none (heap.c heap_create_with_catalog); extended
 *   statistics have their own; a table's constraints share one per table, and its triggers another. A name taken in
 *   its namespace is refused (42P07 for a relation, 42710 otherwise); a key's or an exclusion's index takes its
 *   constraint's name in the relation namespace.
 * - Existence. A statement naming an object that is not there is refused (42P01, 42703, 42704, 42883), an IF EXISTS
 *   drop aside.
 * - Dependencies. A foreign key binds, when it is added, the first unique index of the referenced table in creation
 *   order whose keys are exactly its referenced columns, as a set, a key's own index among them, and with none it is
 *   refused (42830); that index then cannot be dropped, nor its constraint, nor a column under it (2BP01). A key's or
 *   an exclusion's index goes only with its constraint (2BP01). A table another table's foreign key references cannot
 *   be dropped (2BP01). A materialized view pins the tables and views it reads and the columns it names (2BP01 on a
 *   drop, 0A000 on a type change); a trigger's UPDATE OF and WHEN pin their columns the same way, and a trigger its function
 *   (2BP01). A world's view, in its own schema, pins what it reads of this schema the same way, and so does a row
 *   security policy the columns its predicate names; a world's schema holding a view cannot be dropped (2BP01). A
 *   domain cannot be dropped while a column or a domain is of it (2BP01), nor a sequence an identity column owns. A
 *   function is dropped RESTRICT, as every grizzle DROP FUNCTION is: while a domain's CHECK, a table's CHECK, a
 *   generated column, a view, another function's body or a trigger calls it, it is refused naming that dependent
 *   (2BP01), as PostgreSQL's pg_depend records each (recordDependencyOnExpr). Every foreign key's columns compare (42804, see comparable) at the end of each statement, as PostgreSQL adds
 *   every key over a converted column again.
 * - What goes along. A dropped column takes the constraints, indexes and statistics objects over it, and its identity
 *   sequence; a dropped table its constraints, indexes, triggers, statistics and sequences; a dropped view its indexes.
 *   A rename is followed by everything that names the object: a table's constraints, indexes, triggers, statistics,
 *   sequences and the foreign keys and views that reference it; a column's every constraint, index, statistics
 *   object, trigger column and view column; an index's constraint and a constraint's index, which PostgreSQL renames
 *   together; a type's columns and domains.
 * - Rows. A NOT NULL column added to a table with rows needs a value (23502); a column converted by its cast to a type
 *   of its base, the domains of both read through, keeps each row's value; a set column converted to a wider bits
 *   domain by its cast to bit(n′) is padded with zeros on the right, and every row must meet the new domain's CHECKs
 *   (23514); a column converted by an expression the model does not know needs the reviewer's value. A closed id is
 *   stored as its code, an int cell, and a set as its bit string, a text cell of 0s and 1s.
 * - Constants and domains. A constant (CREATE FUNCTION … IMMUTABLE RETURN) holds a value the model computes: a names
 *   constant's name[], a live-codes constant's and a closed constant's bit string, each one hex literal's digits read
 *   four bits a digit (the test oracle textOfHex). A domain's CHECK added without NOT VALID, or VALIDATEd, is evaluated over every stored value of
 *   the domain, as PostgreSQL validates it, and a value it does not admit is refused (23514) naming the table and the
 *   column; so a removed handle's code, or a set holding its bit, fails the VALIDATE of the re-pointed CHECK. A CHECK
 *   outside the fragment the model evaluates (a contract's predicate) is taken to hold, a limit of the model.
 *   Each cell remembers where its value came from: a loaded fact, a value a reviewer wrote at a placeholder, or a
 *   value the column generates.
 * - The database's privileges. A GRANT or REVOKE on the current database adds or takes away each privilege it names
 *   from each role it names, ALL every privilege a database has; a role still holding one cannot be dropped (2BP01,
 *   "privileges for database"), so a migration revokes it first, and a renamed role keeps it. PUBLIC's is the database
 *   owner's, which the model does not keep.
 * - Data steps. A column added with a DEFAULT takes the default's value on every row; a family's backfill (deploy/diff
 *   backfill.ts) is an UPDATE … FROM a query, which the model runs exactly as PostgreSQL does (#update): every target
 *   row joined to the FROM rows its WHERE keeps, all rows assigned at once, each value stored as its column's type
 *   stores it (NOT NULL, 23502; a domain's CHECKs, 23514; an integer's range, 22003; a bit string's length, 22026) and
 *   every CHECK of the table, NOT VALID ones too, judging each new row. Its queries' windows (row_number, lag, lead,
 *   count, sum, max, min, bit_or and string_agg over PARTITION BY, ORDER BY and a ROWS or the default RANGE frame),
 *   GROUP BY aggregates, joins, UNION and WITH RECURSIVE are the SQL standard's; where PostgreSQL's own choice decides
 *   the result (a window function whose value hangs on the order of peers, a target row joined to two FROM rows) the
 *   model throws, a defect of the statement, never a guess. Keys and foreign keys are judged by their build and their
 *   VALIDATE, which the model does not run over rows.
 * - One rule of the draft, not of PostgreSQL: a migration converts each column at most once, by its one fate (a field's
 *   own conversion or a chosen rename's, never both), so a second conversion of a column in one run, under any name it
 *   has by then, is refused.
 *
 * So the model says, without a database, whether every statement's preconditions hold at its position, which value
 * every row holds after a migration (for a test to compare with the carry model, `carry`),
 * and the catalog it ends with (catalogOf), for a test to compare with the catalog of the target snapshot installed
 * from nothing (installState). Column order is no fact, as admission keys columns by name.
 *
 * Every statement kind is decided in the switch: a kind with no effect on the catalog or the rows is named as such,
 * and a kind whose effect the model does not know (DML but a data step's UPDATE, transaction control) is a defect of
 * the case, thrown, never skipped. It is a second implementation of what the migration does, small enough to read, against which every drafted
 * and reviewed migration of a small space is checked. */
export type Cell =
	| { readonly kind: "value"; readonly value: TypedLiteral }
	| { readonly kind: "generated" }

/** What a conversion makes of a row's cell: the cell kept, as a cast to a type of the column's base keeps its value;
 * or the one cell `value` gives every row, asked for only when the table holds rows, none when the model does not
 * know the expression. */
type Conversion =
	| { readonly kind: "kept" }
	| { readonly kind: "given"; readonly value: () => Cell | undefined }
const unknownExpression: Conversion = { kind: "given", value: () => undefined }

/**
 * What generates a column's values: nothing, its identity sequence, its `uuidv7()` default, which fills it only where
 * an INSERT leaves it out, its stored expression, or a partial projection's stored CASE, which is NULL outside its
 * selection.
 */
export type Generation =
	| { readonly kind: "none" }
	| { readonly kind: "identity"; readonly sequence: string }
	| { readonly kind: "uuidv7" }
	| { readonly kind: "stored"; readonly calls: ReadonlyArray<string> }
	| { readonly kind: "partial"; readonly calls: ReadonlyArray<string> }

export interface Column {
	readonly name: string
	readonly type: TypeRef
	readonly generation: Generation
}

export interface Table {
	readonly columns: ReadonlyArray<Column>
	readonly rows: ReadonlyArray<ReadonlyMap<string, Cell>>
}

/** The tables of the schema by name. */
export type Tables = ReadonlyMap<string, Table>

/** A constraint of a table, by its name: a key or an exclusion, implemented by the index of its name; a foreign key,
 * bound to the referenced table's index it was added over; or a CHECK over the columns it names. Each is valid, or
 * added NOT VALID and not yet validated. */
export type Constraint =
	| {
			readonly kind: "primaryKey" | "unique" | "exclude"
			readonly columns: ReadonlyArray<string>
			readonly index: string
			readonly valid: boolean
	  }
	| {
			readonly kind: "foreignKey"
			readonly columns: ReadonlyArray<string>
			readonly references: string
			readonly referenced: ReadonlyArray<string>
			readonly index: string
			readonly valid: boolean
	  }
	| {
			readonly kind: "check"
			readonly columns: ReadonlyArray<string>
			readonly predicate: Expr
			/** The schema's functions its predicate calls, which it pins. */
			readonly calls: ReadonlyArray<string>
			readonly valid: boolean
	  }

/** What owns an index: nothing, or the key or exclusion constraint it implements. */
export type IndexOwner =
	| { readonly kind: "free" }
	| { readonly kind: "constraint"; readonly name: string }

/** An index of a table or a materialized view: the columns its keys are (an expression key is none), every column it
 * reads (its keys, INCLUDE columns and the columns its expressions and predicate name), whether a foreign key may bind
 * it (unique, without a predicate, every key a column), what owns it, and its place in creation order. */
export interface Index {
	readonly on: string
	readonly method: string
	readonly unique: boolean
	readonly keys: ReadonlyArray<string>
	readonly reads: ReadonlyArray<string>
	readonly bindable: boolean
	readonly owner: IndexOwner
	readonly order: number
}

/** A sequence: free, or the identity of a table's column, which owns it. */
export type Sequence =
	| { readonly kind: "free" }
	| { readonly kind: "identity"; readonly table: string; readonly column: string }

export interface Statistics {
	readonly table: string
	readonly columns: ReadonlyArray<string>
}

/** A trigger of a table: its function, the columns its UPDATE OF names and its WHEN reads, and the types its WHEN casts
 * to, which it pins as a column of the type does. */
export interface Trigger {
	readonly function: string
	readonly columns: ReadonlyArray<string>
	readonly types: ReadonlyArray<TypeRef>
}

/** A materialized view: its columns, the columns it names of each relation it reads, and the schema's functions it
 * calls, which it pins. */
export interface View {
	readonly columns: ReadonlyArray<string>
	readonly reads: ReadonlyMap<string, ReadonlySet<string>>
	readonly calls: ReadonlyArray<string>
}

/** A domain's CHECK: its predicate over VALUE, the schema's functions it calls, and whether it is valid or not yet
 * validated. */
export interface DomainCheck {
	readonly predicate: Expr
	readonly calls: ReadonlyArray<string>
	readonly valid: boolean
}

/** A domain: its base type, and its constraints by name. */
export interface Domain {
	readonly base: TypeRef
	readonly constraints: ReadonlyMap<string, DomainCheck>
}

/**
 * A function of the schema: the schema's functions its body calls, which pin them, and what it returns when it is a
 * constant the model computes: a constant's RETURN expression, or a pack's bit string. A PL/pgSQL function (a refusal,
 * advance or isolation function) is opaque.
 */
export interface Function {
	readonly body:
		| { readonly kind: "opaque" }
		| { readonly kind: "constant"; readonly expr: Expr }
		| { readonly kind: "packed"; readonly bits: string }
	readonly calls: ReadonlyArray<string>
}

/** What the model knows of a schema. */
export interface State {
	readonly tables: Tables
	readonly domains: ReadonlyMap<string, Domain>
	/** Each table's constraints, by table, then by constraint name. */
	readonly constraints: ReadonlyMap<string, ReadonlyMap<string, Constraint>>
	readonly indexes: ReadonlyMap<string, Index>
	readonly sequences: ReadonlyMap<string, Sequence>
	readonly statistics: ReadonlyMap<string, Statistics>
	/** Each table's triggers, by table, then by trigger name. */
	readonly triggers: ReadonlyMap<string, ReadonlyMap<string, Trigger>>
	readonly views: ReadonlyMap<string, View>
	/** What lives outside the schema's namespaces yet pins its relations and columns: each world's view
	 * (`view <schema>.<name>`) and each row security policy (`policy <table>.<name>`), with what it reads. */
	readonly dependents: ReadonlyMap<string, View>
	readonly functions: ReadonlyMap<string, Function>
	/** Each role's own privileges on the current database, by the role's name: what the migrations grant it there and
	 * have not revoked. */
	readonly databasePrivileges: ReadonlyMap<string, ReadonlySet<string>>
	/** The next index's place in creation order. */
	readonly created: number
}

export const emptyState: State = {
	tables: new Map(),
	domains: new Map(),
	constraints: new Map(),
	indexes: new Map(),
	sequences: new Map(),
	statistics: new Map(),
	triggers: new Map(),
	views: new Map(),
	dependents: new Map(),
	functions: new Map(),
	databasePrivileges: new Map(),
	created: 0
}

/** Every privilege PostgreSQL defines on a database, which a GRANT or REVOKE of ALL on it names. */
const databasePrivilegeTypes = ["CREATE", "CONNECT", "TEMPORARY"] as const

/** The SQLSTATEs the model refuses a statement with, each where PostgreSQL raises it. */
export type ModelSqlstate =
	| "0A000"
	| "22003"
	| "22026"
	| "23502"
	| "23514"
	| "2BP01"
	| "42601"
	| "42611"
	| "42701"
	| "42703"
	| "42704"
	| "42710"
	| "42723"
	| "42804"
	| "42830"
	| "42883"
	| "428C9"
	| "42P01"
	| "42P07"
	| "42P16"
	| "55000"

/**
 * Why the model stops a reviewed migration at a statement: PostgreSQL refuses it, with the SQLSTATE it raises there; it
 * converts a column a second time in one run, which the draft's own rule forbids and PostgreSQL would allow; or it
 * converts a column holding rows by an expression the model does not evaluate, where a reviewer's value is needed.
 */
export type Refusal =
	| Readonly<{ kind: "sqlstate"; code: ModelSqlstate }>
	| Readonly<{ kind: "converted twice" }>
	| Readonly<{ kind: "unknown conversion" }>

/** Where a reviewed migration fails, as PostgreSQL would, and why (`refusal`), with the reason in words. */
export interface InterpretFailure {
	readonly file: string
	readonly action: number
	readonly refusal: Refusal
	readonly reason: string
}

/** The value a reviewer writes at a placeholder. */
export type PlaceholderValue = (placeholder: Placeholder) => TypedLiteral

/** A table while it changes. */
interface Live {
	columns: Array<Column>
	rows: Array<Map<string, Cell>>
}

/** A statement the model refuses, and why, with the reason in words. */
class Refused extends Data.TaggedError("Refused")<{
	readonly refusal: Refusal
	readonly reason: string
}> {}

/** A statement PostgreSQL refuses with `code`; a function declaration, so that control flow knows a call never returns. */
function refuse(code: ModelSqlstate, reason: string): never {
	throw new Refused({ refusal: { kind: "sqlstate", code }, reason })
}

/** A statement the model stops at for a reason of its own, which PostgreSQL would not refuse. */
function stop(refusal: Exclude<Refusal, { readonly kind: "sqlstate" }>, reason: string): never {
	throw new Refused({ refusal, reason })
}

/** Indexes in creation order. */
const byCreation = Order.mapInput(Order.Number, ([, x]: readonly [string, Index]) => x.order)

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (x) => b.includes(x)) && Arr.every(b, (x) => a.includes(x))

/** The builtins whose btree operator family compares across them: the integers of every width, and the two floats. */
const families: ReadonlyArray<ReadonlySet<string>> = [
	new Set(["smallint", "integer", "bigint"]),
	new Set(["real", "double precision"])
]

/** PostgreSQL's implicit casts among the builtins a column can have: each type to the types it casts to implicitly. */
const implicitCasts: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["smallint", new Set<string>(["integer", "bigint", "numeric", "real", "double precision"])],
	["integer", new Set<string>(["bigint", "numeric", "real", "double precision"])],
	["bigint", new Set<string>(["numeric", "real", "double precision"])],
	["numeric", new Set<string>(["real", "double precision"])],
	["real", new Set<string>(["double precision"])]
])

/** Whether a foreign key's referencing column of type `from` compares with its referenced column of type `to`, each its
 * base type, a domain read through: PostgreSQL implements the key by an equality of the operator family of the
 * referenced key's index, and refuses it when there is none (42804, "cannot be implemented"). The two compare when
 * they are one type, its typmod aside; when they are builtins of one family that compares across its types; or when
 * `from` casts implicitly to `to`, so the referenced key's own equality applies. An array compares only with the array
 * of its own element type, a domain or any other named type only with itself. */
const comparable = (from: TypeRef, to: TypeRef): boolean => {
	if (from.array !== to.array) {
		return false
	}
	if (from.kind === "named" || to.kind === "named") {
		return (
			from.kind === "named" &&
			to.kind === "named" &&
			from.schema === to.schema &&
			from.name === to.name
		)
	}
	if (from.name === to.name) {
		return true
	}
	if (from.array) {
		return false
	}
	return (
		Arr.some(families, (f) => f.has(from.name) && f.has(to.name)) ||
		implicitCasts.get(from.name)?.has(to.name) === true
	)
}

/** The columns an expression names. */
const columnsOf = (e: Expr): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column") {
				out.push(x.column)
			}
			return x
		}
	})
	return out
}

/** The relations of the schema a query reads, each with the columns it names: every column a column reference of the
 * query names that the relation has, since the model resolves no alias. */
const readsOf = (
	query: Select,
	schema: string,
	columnsOfRelation: (name: string) => ReadonlyArray<string>
): ReadonlyMap<string, ReadonlySet<string>> => {
	const relations: Array<string> = []
	const named = new Set<string>()
	transformSelect(query, {
		...identityHooks,
		fromSource: (item: FromSource) => {
			if (item.kind === "table" && typeof item.table !== "string" && item.table.schema === schema) {
				relations.push(item.table.name)
			}
			return item
		},
		expr: (x) => {
			if (x.kind === "column") {
				named.add(x.column)
			}
			return x
		}
	})
	return new Map(
		Arr.map(relations, (r) => [r, new Set(Arr.filter(columnsOfRelation(r), (c) => named.has(c)))])
	)
}

/** The functions of `schema` an expression calls, each once, its subqueries' and their FROM functions' included. */
const callsOf = (exprs: ReadonlyArray<Expr>, schema: string): ReadonlyArray<string> => {
	const out = new Set<string>()
	const hooks = {
		...identityHooks,
		expr: (x: Expr) => {
			if (x.kind === "call" && x.fn.kind === "qualified" && x.fn.schema === schema) {
				out.add(x.fn.name)
			}
			return x
		}
	}
	for (const e of exprs) {
		transformExpr(e, hooks)
	}
	return [...out]
}

/** The functions of `schema` a query calls. */
const queryCalls = (query: Select, schema: string): ReadonlyArray<string> => {
	const out = new Set<string>()
	transformSelect(query, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "call" && x.fn.kind === "qualified" && x.fn.schema === schema) {
				out.add(x.fn.name)
			}
			return x
		}
	})
	return [...out]
}

const generationOf = (c: ColumnDef, schema: string): Generation => {
	if (c.generated === undefined) {
		return { kind: "none" }
	}
	switch (c.generated.kind) {
		case "identity":
			return { kind: "identity", sequence: c.generated.sequence.name }
		case "uuidv7":
			return { kind: "uuidv7" }
		case "stored":
			return { kind: "stored", calls: callsOf([c.generated.expr], schema) }
		case "partial":
			return { kind: "partial", calls: callsOf([c.generated.when, c.generated.expr], schema) }
	}
}

const columnOf = (c: ColumnDef, schema: string): Column => ({
	name: c.name,
	type: c.type,
	generation: generationOf(c, schema)
})

/**
 * A value as the model evaluates a constant's body or a domain's CHECK: an integer, a text, a Boolean, a bit string
 * (its 0s and 1s), or a name[] (a hole's element the empty name); undefined is SQL's NULL.
 */
type SqlValue =
	| { readonly kind: "int"; readonly value: bigint }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "bits"; readonly value: string }
	| { readonly kind: "names"; readonly value: ReadonlyArray<string> }
	| undefined

/** An expression outside the fragment the model evaluates: a constant or a CHECK it cannot compute. */
class Unevaluable extends Data.TaggedError("Unevaluable")<{ readonly what: string }> {}

/** A function declaration, so that control flow knows a call never returns. */
function unevaluable(what: string): never {
	throw new Unevaluable({ what })
}

/**
 * The elements of an array literal's text, `{"a","",b}`: each quoted element unescaped (a backslash takes the next
 * character), each bare one as written, so a hole's quoted empty name is the empty name. NULL never appears: a names
 * constant quotes every element.
 */
const arrayElements = (text: string): ReadonlyArray<string> => {
	if (!Str.startsWith("{")(text) || !Str.endsWith("}")(text)) {
		return unevaluable(`the array text ${text}`)
	}
	const body = Str.slice(1, -1)(text)
	const out: Array<string> = []
	let at = 0
	while (at < body.length) {
		let element = ""
		if (body[at] === '"') {
			at += 1
			while (at < body.length && body[at] !== '"') {
				if (body[at] === "\\") {
					at += 1
				}
				element += body[at] ?? ""
				at += 1
			}
			at += 1
		} else {
			while (at < body.length && body[at] !== ",") {
				element += body[at] ?? ""
				at += 1
			}
			if (element === "NULL") {
				return unevaluable("a NULL element of an array text")
			}
		}
		out.push(element)
		if (body[at] === ",") {
			at += 1
		}
	}
	return out
}

/** A builtin type's value kind, as a literal or a cast of it is read. */
const valueOf = (value: string, type: TypeRef): SqlValue => {
	if (type.kind !== "builtin") {
		return unevaluable(`a value of ${printType(type)}`)
	}
	if (type.array) {
		return type.name === "name" || type.name === "text"
			? { kind: "names", value: arrayElements(value) }
			: unevaluable(`an array of ${type.name}`)
	}
	switch (type.name) {
		case "bit":
		case "bit varying":
			return { kind: "bits", value }
		case "text":
		case "name":
			return { kind: "text", value }
		case "smallint":
		case "integer":
		case "bigint":
			return { kind: "int", value: BigInt(value) }
		case "boolean":
		case "double precision":
		case "int4multirange":
		case "int4range":
		case "int8multirange":
		case "int8range":
		case "jsonb":
		case "money":
		case "numeric":
		case "real":
		case "record":
		case "bytea":
		case "uuid":
		case "date":
		case "daterange":
		case "datemultirange":
			return unevaluable(`a ${type.name} literal`)
	}
}

/**
 * The bit string a closed constant's statement installs: its hex literal's digits, four bits each, its cells' bits then
 * the 0s that pad them to whole digits (test/support/closed/bit-text.ts textOfHex).
 */
const packedBits = (s: PackConstant): string => textOfHex(s.hex)

/** A bit string cast to bit(n): padded with zeros on the right, or truncated, as PostgreSQL's bit(n) cast does. */
const toLength = (bits: string, length: number): string =>
	bits.length >= length ? Str.slice(0, length)(bits) : bits + Str.repeat(length - bits.length)("0")

/**
 * What the evaluator reads besides an expression: VALUE, the columns a FROM item binds (`<alias>.<column>`, and
 * `.<column>` for a column one FROM item alone has), and the schema's constants; and, where a statement of a migration's
 * data step runs, the schema's domains a cast or a literal reads through (`types`) and the window functions of the
 * query row it evaluates (`window`), or the aggregates of the group a grouped query's row stands for (`aggregate`).
 * Without them, a domain's cast or literal, a window function and an aggregate are Unevaluable.
 */
interface Scope {
	readonly value: SqlValue
	readonly columns: ReadonlyMap<string, SqlValue>
	readonly constant: (name: string) => SqlValue
	readonly types?: TypeReader
	readonly window?: (call: FunctionCall) => SqlValue
	/** A grouped query's aggregates over the rows of the group its row stands for. */
	readonly aggregate?: (call: FunctionCall) => SqlValue
}

/** The schema's domains as a cast or a literal of a data step reads them: a type's base, and a value of the type
 * refused unless every CHECK of each domain it is admits it (23514). */
interface TypeReader {
	readonly base: (type: TypeRef) => TypeRef
	readonly admit: (type: TypeRef, value: SqlValue) => void
}

/** The values each builtin integer type holds: a cast or an assignment outside them is refused (22003). */
const integerRanges: ReadonlyMap<string, readonly [bigint, bigint]> = new Map([
	["smallint", [-32_768n, 32_767n] as const],
	["integer", [-2_147_483_648n, 2_147_483_647n] as const],
	["bigint", [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n] as const]
])

/** An integer as a value of the builtin integer type `name`, or the refusal PostgreSQL raises when it is out of range. */
const inRange = (name: string, value: bigint): SqlValue => {
	const range = integerRanges.get(name)
	if (range !== undefined && (value < range[0] || value > range[1])) {
		refuse("22003", `${name} out of range`)
	}
	return { kind: "int", value }
}

/** The order of two non-NULL values of one kind, as PostgreSQL's btree compares them: integers numerically, texts by
 * code point (every stored text is collated pg_c_utf8), booleans false first, and bit strings bit by bit, a prefix
 * first. */
const compareValues = (a: NonNullable<SqlValue>, b: NonNullable<SqlValue>): number => {
	if (a.kind === "int" && b.kind === "int") {
		return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
	}
	if ((a.kind === "text" && b.kind === "text") || (a.kind === "bits" && b.kind === "bits")) {
		return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
	}
	if (a.kind === "bool" && b.kind === "bool") {
		return Number(a.value) - Number(b.value)
	}
	return unevaluable(`an order of ${a.kind} and ${b.kind}`)
}

/** A comparison's truth over two values, NULL with either NULL. */
const compared = (a: SqlValue, b: SqlValue, holds: (order: number) => boolean): SqlValue =>
	a === undefined || b === undefined
		? undefined
		: { kind: "bool", value: holds(compareValues(a, b)) }

/** The truth of a Boolean value: true, false, or NULL; Unevaluable for a value of another kind. */
const truthOf = (v: SqlValue): boolean | undefined => {
	if (v === undefined) {
		return undefined
	}
	return v.kind === "bool" ? v.value : unevaluable(`a truth of ${v.kind}`)
}

const boolValue = (b: boolean | undefined): SqlValue =>
	b === undefined ? undefined : { kind: "bool", value: b }

/** A value cast to `t`: a domain's through its base, then judged by its CHECKs (TypeReader), and a builtin's as
 * PostgreSQL casts it: an integer to an integer type within its range or to numeric, which keeps it; a bit string to
 * bit(n), padded or cut, or to bit varying; a text to text or name. */
const castTo = (v: SqlValue, t: TypeRef, scope: Scope): SqlValue => {
	if (v === undefined) {
		return undefined
	}
	if (t.kind === "named") {
		const types = scope.types
		const base = types?.base(t)
		if (types === undefined || base === undefined || base.kind === "named") {
			return unevaluable(`a cast of ${v.kind} to ${printType(t)}`)
		}
		const out = castTo(v, base, scope)
		types.admit(t, out)
		return out
	}
	if (!t.array) {
		if (t.name === "bit" && v.kind === "bits") {
			return { kind: "bits", value: toLength(v.value, t.length) }
		}
		if (t.name === "bit varying" && (v.kind === "bits" || v.kind === "text")) {
			return { kind: "bits", value: v.value }
		}
		if ((t.name === "text" || t.name === "name") && v.kind === "text") {
			return v
		}
		if (
			(t.name === "smallint" || t.name === "integer" || t.name === "bigint") &&
			v.kind === "int"
		) {
			return inRange(t.name, v.value)
		}
		if (t.name === "numeric" && v.kind === "int") {
			return v
		}
		if (t.name === "integer" && v.kind === "bits" && v.value.length <= 32) {
			return { kind: "int", value: v.value === "" ? 0n : BigInt(`0b${v.value}`) }
		}
	}
	return unevaluable(`a cast of ${v.kind} to ${printType(t)}`)
}

/** Whether two values are equal, as PostgreSQL's = compares two of one type; NULL with either is NULL. */
const equal = (a: SqlValue, b: SqlValue): SqlValue => {
	if (a === undefined || b === undefined) {
		return undefined
	}
	if (a.kind !== b.kind || a.kind === "names" || b.kind === "names") {
		return unevaluable(`a comparison of ${a.kind} with ${b.kind}`)
	}
	return { kind: "bool", value: a.value === b.value }
}

/** Two bit strings combined bit by bit; PostgreSQL refuses two of different lengths (22026). */
const bitwise = (op: "&" | "|", a: string, b: string): string => {
	if (a.length !== b.length) {
		refuse("22026", `cannot ${op === "&" ? "AND" : "OR"} bit strings of different sizes`)
	}
	return Arr.join(
		Arr.map(
			upTo(a.length, (i) => i),
			(i) =>
				op === "&"
					? a[i] === "1" && b[i] === "1"
						? "1"
						: "0"
					: a[i] === "1" || b[i] === "1"
						? "1"
						: "0"
		),
		""
	)
}

const intOf = (v: SqlValue, what: string): bigint | undefined =>
	v === undefined ? undefined : v.kind === "int" ? v.value : unevaluable(`${what} of ${v.kind}`)

/**
 * The value of `e`, evaluated as PostgreSQL would over the fragment a constant's body and a roster's or a set's domain
 * CHECK are written in: literals, a bit string's hex literal among them, casts, VALUE, + and -, = and <>, & and |, a
 * subscript, a CASE, substring and a call of the schema's constant. Any other expression is Unevaluable.
 */
const evaluate = (e: Expr, scope: Scope): SqlValue => {
	switch (e.kind) {
		case "domainValue":
			return scope.value
		case "literal":
			switch (e.value.kind) {
				case "int":
					return { kind: "int", value: e.value.value }
				case "bool":
					return { kind: "bool", value: e.value.value }
				case "text": {
					const base = e.type.kind === "named" ? scope.types?.base(e.type) : undefined
					return base === undefined
						? valueOf(e.value.value, e.type)
						: castTo(valueOf(e.value.value, base), e.type, scope)
				}
				case "bits":
					return castTo({ kind: "bits", value: textOfHex(e.value.hex) }, e.type, scope)
				case "decimal":
				case "float":
				case "floatSpecial":
					return unevaluable(`a ${e.value.kind} literal`)
			}
		case "cast":
			return castTo(evaluate(e.expr, scope), e.type, scope)
		case "binary": {
			const left = evaluate(e.left, scope)
			const right = evaluate(e.right, scope)
			switch (e.op) {
				case "+":
				case "-":
				case "*": {
					const a = intOf(left, e.op)
					const b = intOf(right, e.op)
					return a === undefined || b === undefined
						? undefined
						: { kind: "int", value: e.op === "+" ? a + b : e.op === "-" ? a - b : a * b }
				}
				case "<":
					return compared(left, right, (o) => o < 0)
				case "<=":
					return compared(left, right, (o) => o <= 0)
				case ">":
					return compared(left, right, (o) => o > 0)
				case ">=":
					return compared(left, right, (o) => o >= 0)
				case "=":
					return equal(left, right)
				case "<>": {
					const eq = equal(left, right)
					return eq?.kind === "bool" ? { kind: "bool", value: !eq.value } : eq
				}
				case "&":
				case "|":
					if (left === undefined || right === undefined) {
						return undefined
					}
					return left.kind === "bits" && right.kind === "bits"
						? { kind: "bits", value: bitwise(e.op, left.value, right.value) }
						: unevaluable(`${left.kind} ${e.op} ${right.kind}`)
				case "%":
				case "&&":
				case "&<":
				case "&>":
				case "-|-":
				case "/":
				case "<<":
				case "<=>":
				case "<@":
				case ">>":
				case "@>":
				case "||":
				case "~":
					return unevaluable(`the operator ${e.op}`)
			}
		}
		case "subscript": {
			const array = evaluate(e.array, scope)
			const index = intOf(evaluate(e.index, scope), "a subscript")
			if (array === undefined || index === undefined) {
				return undefined
			}
			if (array.kind !== "names") {
				return unevaluable(`a subscript of ${array.kind}`)
			}
			const element = index >= 1n ? array.value[Number(index) - 1] : undefined
			return element === undefined ? undefined : { kind: "text", value: element }
		}
		case "case": {
			if (e.operand !== undefined) {
				return unevaluable("a simple CASE")
			}
			for (const w of e.whens) {
				const v = evaluate(w.when, scope)
				if (v?.kind === "bool" && v.value) {
					return evaluate(w.result, scope)
				}
			}
			return evaluate(e.else, scope)
		}
		case "column":
			return scope.columns.has(`${e.table ?? ""}.${e.column}`)
				? scope.columns.get(`${e.table ?? ""}.${e.column}`)
				: unevaluable(`the column ${e.column}`)
		case "call": {
			if (e.over !== undefined) {
				return scope.window === undefined ? unevaluable("a window function") : scope.window(e)
			}
			if (isAggregate(e)) {
				return scope.aggregate === undefined ? unevaluable("an aggregate") : scope.aggregate(e)
			}
			if (e.star) {
				return unevaluable("count(*)")
			}
			if (e.fn.kind === "qualified") {
				return e.args.length === 0 ? scope.constant(e.fn.name) : unevaluable(`${e.fn.name}(…)`)
			}
			if (e.fn.name === "substring" && e.args.length === 3) {
				const [bits, from, length] = Arr.map(e.args, (a) => evaluate(a, scope))
				const start = intOf(from, "substring's start")
				const count = intOf(length, "substring's length")
				if (bits === undefined || start === undefined || count === undefined) {
					return undefined
				}
				if (bits.kind !== "bits") {
					return unevaluable(`substring of ${bits.kind}`)
				}
				const first = Math.max(Number(start), 1)
				const last = Number(start) + Number(count)
				return {
					kind: "bits",
					value: Str.slice(first - 1, Math.max(last - 1, first - 1))(bits.value)
				}
			}
			return unevaluable(`the function ${e.fn.name}`)
		}
		case "and": {
			const truths = Arr.map(e.args, (a) => truthOf(evaluate(a, scope)))
			return boolValue(
				Arr.some(truths, (t) => t === false)
					? false
					: Arr.some(truths, (t) => t === undefined)
						? undefined
						: true
			)
		}
		case "or": {
			const truths = Arr.map(e.args, (a) => truthOf(evaluate(a, scope)))
			return boolValue(
				Arr.some(truths, (t) => t === true)
					? true
					: Arr.some(truths, (t) => t === undefined)
						? undefined
						: false
			)
		}
		case "not": {
			const t = truthOf(evaluate(e.expr, scope))
			return boolValue(t === undefined ? undefined : !t)
		}
		case "isTrue":
			return boolValue(truthOf(evaluate(e.expr, scope)) === true)
		case "negate": {
			const v = intOf(evaluate(e.expr, scope), "a negation")
			return v === undefined ? undefined : { kind: "int", value: -v }
		}
		case "array":
		case "between":
		case "coalesce":
		case "collate":
		case "complement":
		case "excluded":
		case "exists":
		case "field":
		case "greatest":
		case "inList":
		case "inQuery":
		case "least":
		case "mergeAction":
		case "nullif":
		case "param":
		case "plSpecial":
		case "plVar":
		case "regclass":
		case "returning":
		case "row":
		case "subquery":
		case "user":
			return unevaluable(`an expression of kind ${e.kind}`)
	}
}

/** The aggregates a data step calls, each over a group's or a frame's non-NULL values. */
const aggregateNames: ReadonlySet<string> = new Set(["count", "sum", "max", "min", "bit_or"])

/** Whether a call outside any window is an aggregate: count(*), or a builtin aggregate. */
const isAggregate = (call: FunctionCall): boolean =>
	call.star || (call.fn.kind === "builtin" && aggregateNames.has(call.fn.name))

/** Whether an expression calls an aggregate outside any window and any subquery, as a grouped query's target does. */
const callsAggregate = (e: Expr): boolean => {
	switch (e.kind) {
		case "call":
			return e.over === undefined && isAggregate(e)
				? true
				: !e.star && Arr.some(e.args, callsAggregate)
		case "binary":
			return callsAggregate(e.left) || callsAggregate(e.right)
		case "cast":
		case "collate":
		case "complement":
		case "isTrue":
		case "negate":
		case "not":
			return callsAggregate(e.expr)
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
			return Arr.some(e.args, callsAggregate)
		case "case":
			return (
				(e.operand !== undefined && callsAggregate(e.operand)) ||
				Arr.some(e.whens, (w) => callsAggregate(w.when) || callsAggregate(w.result)) ||
				callsAggregate(e.else)
			)
		case "between":
			return callsAggregate(e.expr) || callsAggregate(e.low) || callsAggregate(e.high)
		case "inList":
			return callsAggregate(e.expr) || Arr.some(e.list, callsAggregate)
		case "row":
			return Arr.some(e.items, callsAggregate)
		case "nullif":
			return callsAggregate(e.expr) || callsAggregate(e.absent)
		case "subscript":
			return callsAggregate(e.array) || callsAggregate(e.index)
		case "inQuery":
			return callsAggregate(e.expr)
		case "array":
		case "column":
		case "domainValue":
		case "excluded":
		case "exists":
		case "field":
		case "literal":
		case "mergeAction":
		case "param":
		case "plSpecial":
		case "plVar":
		case "regclass":
		case "returning":
		case "subquery":
		case "user":
			return false
	}
}

/** An aggregate over a group's rows, each evaluated in its own scope: count(*) of the rows its FILTER keeps, count of
 * the non-NULL values, and sum, max, min or bit_or of them (aggregated). */
const aggregateOver = (
	call: FunctionCall,
	rows: ReadonlyArray<number>,
	scopeOf: (row: number) => Scope
): SqlValue => {
	if (call.star) {
		const filter = call.filter
		return {
			kind: "int",
			value: BigInt(
				Arr.filter(
					rows,
					(r) => filter === undefined || truthOf(evaluate(filter, scopeOf(r))) === true
				).length
			)
		}
	}
	if (call.distinct || call.orderBy.length > 0 || call.withinGroup.length > 0) {
		return unevaluable("an aggregate's DISTINCT, ORDER BY or WITHIN GROUP")
	}
	const [arg, ...more] = call.args
	if (arg === undefined || more.length > 0 || call.fn.kind !== "builtin") {
		return unevaluable(`the aggregate ${call.fn.name} of ${call.args.length} arguments`)
	}
	const values = Arr.map(rows, (r) => evaluate(arg, scopeOf(r)))
	return call.fn.name === "count"
		? { kind: "int", value: BigInt(Arr.filter(values, (v) => v !== undefined).length) }
		: aggregated(call.fn.name, values)
}

/** A relation's rows under `names`, position by position: a set operation's arms, and a recursive CTE's steps, are
 * read by position. */
const positional = (r: Relation, names: ReadonlyArray<string>): ReadonlyArray<Tuple> =>
	Arr.map(
		r.rows,
		(row) => new Map(Arr.map(names, (n, i) => [n, row.get(r.names[i] ?? n)] as const))
	)

/** Each row once, in its first place: a UNION's rows, and DISTINCT's. */
const distinctRows = (
	names: ReadonlyArray<string>,
	rows: ReadonlyArray<Tuple>
): ReadonlyArray<Tuple> => {
	const seen = new Set<string>()
	return Arr.filter(rows, (row) => {
		const key = groupText(Arr.map(names, (n) => row.get(n)))
		const fresh = !seen.has(key)
		seen.add(key)
		return fresh
	})
}

/**
 * The rounds a recursive CTE may run on the model: a recursion over the stored rows of a test's box ends long before.
 *
 * @formatConstant rounds
 */
const recursionBound = 10_000

/** Whether a query reads the CTE `name`. */
const readsCte = (q: OperandSelect, name: string): boolean => {
	let reads = false
	transformOperand(q, {
		...identityHooks,
		fromSource: (source: FromSource) => {
			if (source.kind === "cte" && source.name === name) {
				reads = true
			}
			return source
		}
	})
	return reads
}

/** A row of a relation the evaluator reads or a query yields: each column's value by name, a cell the model does not
 * hold (a generated one, a value of a kind it does not evaluate) absent, so reading it is Unevaluable. */
type Tuple = ReadonlyMap<string, SqlValue>

/** A relation the evaluator reads or yields: its column names in order, and its rows. */
interface Relation {
	readonly names: ReadonlyArray<string>
	readonly rows: ReadonlyArray<Tuple>
}

/** The CTEs a query sees, by name. */
type Ctes = ReadonlyMap<string, Relation>

/** A tuple bound under its FROM item's alias: each column as `<alias>.<column>` and as `.<column>`. */
const bound = (alias: string, tuple: Tuple): Map<string, SqlValue> => {
	const out = new Map<string, SqlValue>()
	for (const [name, value] of tuple) {
		out.set(`${alias}.${name}`, value)
		out.set(`.${name}`, value)
	}
	return out
}

/** Two FROM items' bindings of one row joined: an unqualified column both bind is ambiguous, so neither binds it, and
 * its `!` mark keeps a third from binding it again; reading it is Unevaluable, as PostgreSQL refuses it (42702). */
const joined = (
	a: ReadonlyMap<string, SqlValue>,
	b: ReadonlyMap<string, SqlValue>
): Map<string, SqlValue> => {
	const out = new Map(a)
	for (const [key, value] of b) {
		const marked = Str.startsWith("!")(key)
		const unqualified = marked ? Str.slice(1)(key) : key
		if (marked || (Str.startsWith(".")(key) && (out.has(key) || out.has(`!${key}`)))) {
			out.delete(unqualified)
			out.set(`!${unqualified}`, undefined)
		} else {
			out.set(key, value)
		}
	}
	return out
}

/** A relation's row under a column alias list: the list names its first columns, in order; an empty one renames none. */
const renamed = (r: Relation, columns: ReadonlyArray<string>, row: Tuple): Tuple =>
	columns.length === 0
		? row
		: new Map(Arr.map(r.names, (name, i) => [columns[i] ?? name, row.get(name)] as const))

/** A relation under a column alias list (renamed). */
const renamedRelation = (r: Relation, columns: ReadonlyArray<string>): Relation => ({
	names: Arr.map(r.names, (name, i) => columns[i] ?? name),
	rows: Arr.map(r.rows, (row) => renamed(r, columns, row))
})

/** The text a list of values is partitioned or deduplicated by: equal lists, NULLs among them, share one text. */
const groupText = (values: ReadonlyArray<SqlValue>): string =>
	Arr.join(
		Arr.map(values, (v) =>
			v === undefined
				? "null"
				: `${v.kind}:${v.kind === "names" ? Arr.join(v.value, "\u0000") : String(v.value)}`
		),
		"\u0001"
	)

/** Two values in an ORDER BY's direction: ascending NULLS LAST, descending NULLS FIRST, PostgreSQL's defaults. */
const orderedBy = (a: SqlValue, b: SqlValue, direction: "ASC" | "DESC"): number => {
	if (a === undefined || b === undefined) {
		if (a === undefined && b === undefined) {
			return 0
		}
		const nullLast = direction === "ASC" ? 1 : -1
		return a === undefined ? nullLast : -nullLast
	}
	const c = compareValues(a, b)
	return direction === "ASC" ? c : -c
}

/** The positions of a sorted partition a window function's frame holds for the row at `at`: with no explicit frame, the
 * whole partition when it is unordered, else RANGE from its first row to the current row's last peer; an explicit ROWS
 * frame from its start bound to its end bound, clamped to the partition. */
const frameOf = (
	spec: NonNullable<FunctionCall["over"]>,
	length: number,
	at: number,
	lastPeer: number
): readonly [number, number] => {
	if (spec.frame === undefined) {
		return spec.orderBy.length === 0 ? [0, length - 1] : [0, lastPeer]
	}
	const bound = (b: FrameBound): number => {
		switch (b.kind) {
			case "unboundedPreceding":
				return 0
			case "currentRow":
				return at
			case "unboundedFollowing":
				return length - 1
			case "offset":
				return b.direction === "PRECEDING" ? at - Number(b.offset) : at + Number(b.offset)
		}
	}
	return [Math.max(0, bound(spec.frame.start)), Math.min(length - 1, bound(spec.frame.end))]
}

/**
 * string_agg over a frame: its non-NULL texts in the frame's order, the delimiter between each two, NULL over none, as
 * a concat fold's running value is backfilled (deploy/diff/backfill.ts runningOf).
 */
const textsJoined = (values: ReadonlyArray<SqlValue>, delimiter: SqlValue): SqlValue => {
	if (delimiter?.kind !== "text") {
		return unevaluable("string_agg's delimiter, a text")
	}
	const texts = Arr.map(
		Arr.filter(values, (v): v is NonNullable<SqlValue> => v !== undefined),
		(v) => (v.kind === "text" ? v.value : unevaluable(`string_agg of ${v.kind}`))
	)
	return texts.length === 0 ? undefined : { kind: "text", value: Arr.join(texts, delimiter.value) }
}

/** The aggregate of a frame's non-NULL values, NULL over none: sum, max, min or bit_or. */
const aggregated = (name: string, values: ReadonlyArray<SqlValue>): SqlValue => {
	const present = Arr.filter(values, (v): v is NonNullable<SqlValue> => v !== undefined)
	const [first, ...rest] = present
	if (first === undefined) {
		return undefined
	}
	switch (name) {
		case "sum":
			return {
				kind: "int",
				value: Arr.reduce(present, 0n, (total, v) => total + (intOf(v, "sum") ?? 0n))
			}
		case "max":
			return Arr.reduce(rest, first, (m, v) => (compareValues(v, m) > 0 ? v : m))
		case "min":
			return Arr.reduce(rest, first, (m, v) => (compareValues(v, m) < 0 ? v : m))
		case "bit_or":
			return Arr.reduce(rest, first, (m, v) =>
				m.kind === "bits" && v.kind === "bits"
					? { kind: "bits", value: bitwise("|", m.value, v.value) }
					: unevaluable(`bit_or of ${v.kind}`)
			)
		default:
			return unevaluable(`the aggregate ${name}`)
	}
}

/**
 * The values of a window function over a query's rows, one per row, as the SQL standard defines them: the rows
 * partitioned by its PARTITION BY, each partition sorted by its ORDER BY; row_number() a row's position from 1, lag
 * and lead the value `offset` rows before or after it in that order or the default, and count, sum, max, min and
 * bit_or the aggregate of the frame (frameOf). PostgreSQL orders peers, rows equal under the ORDER BY, as it chooses,
 * so a function whose value depends on their order (row_number, lag, lead, or any aggregate over a ROWS frame) over a
 * partition with peers has no one value: the model throws, a defect of the statement, never a guess.
 */
const windowColumn = (
	call: FunctionCall,
	count: number,
	scopeOf: (row: number) => Scope
): ReadonlyArray<SqlValue> => {
	const spec = call.over
	if (spec === undefined) {
		throw new Error("a window function has its window")
	}
	if (!call.star && (call.distinct || call.orderBy.length > 0 || call.withinGroup.length > 0)) {
		return unevaluable("a window function's DISTINCT, ORDER BY or WITHIN GROUP")
	}
	const name =
		call.fn.kind === "builtin" ? call.fn.name : unevaluable(`the window function ${call.fn.name}`)
	const at = (e: Expr, row: number): SqlValue => evaluate(e, scopeOf(row))
	const partitions = new Map<string, Array<number>>()
	for (const row of upTo(count, (i) => i)) {
		const key = groupText(Arr.map(spec.partitionBy, (e) => at(e, row)))
		const members = partitions.get(key) ?? []
		members.push(row)
		partitions.set(key, members)
	}
	const out = new Map<number, SqlValue>()
	for (const members of partitions.values()) {
		const keys = new Map(
			Arr.map(members, (row) => [row, Arr.map(spec.orderBy, (o) => at(o.expr, row))] as const)
		)
		const order = (x: number, y: number): -1 | 0 | 1 => {
			for (const [k, o] of spec.orderBy.entries()) {
				const c = orderedBy(keys.get(x)?.[k], keys.get(y)?.[k], o.direction)
				if (c !== 0) {
					return c < 0 ? -1 : 1
				}
			}
			return 0
		}
		const sorted = Arr.sort(members, Order.make(order))
		const length = sorted.length
		const peered = (p: number): boolean =>
			p + 1 < length && order(Arr.getUnsafe(sorted, p), Arr.getUnsafe(sorted, p + 1)) === 0
		const tied = spec.orderBy.length > 0 && Arr.some(sorted, (_, p) => peered(p))
		const lastPeer = (p: number): number => (peered(p) ? lastPeer(p + 1) : p)
		const ordered = (what: string): void => {
			if (tied) {
				throw new Error(
					`${what} over peers of its window's ORDER BY, which PostgreSQL orders as it chooses`
				)
			}
		}
		for (const [p, row] of sorted.entries()) {
			const args = call.star ? [] : call.args
			if (name === "row_number") {
				ordered("row_number()")
				out.set(row, { kind: "int", value: BigInt(p + 1) })
				continue
			}
			if (name === "lag" || name === "lead") {
				ordered(`${name}()`)
				const [value, offsetArg, fallback] = args
				if (value === undefined) {
					return unevaluable(`${name}() of no value`)
				}
				const offset = offsetArg === undefined ? 1n : intOf(at(offsetArg, row), "an offset")
				if (offset === undefined) {
					out.set(row, undefined)
					continue
				}
				const target = name === "lag" ? p - Number(offset) : p + Number(offset)
				const from = sorted[target]
				out.set(
					row,
					from !== undefined
						? at(value, from)
						: fallback === undefined
							? undefined
							: at(fallback, row)
				)
				continue
			}
			if (spec.frame !== undefined) {
				ordered("an aggregate over a ROWS frame")
			}
			const [start, end] = frameOf(spec, length, p, lastPeer(p))
			const frame = sorted.slice(start, end + 1)
			if (call.star) {
				const filter = call.filter
				out.set(row, {
					kind: "int",
					value: BigInt(
						Arr.filter(frame, (r) => filter === undefined || truthOf(at(filter, r)) === true).length
					)
				})
				continue
			}
			if (name === "string_agg") {
				const [value, delimiter] = args
				if (value === undefined || delimiter === undefined || args.length !== 2) {
					return unevaluable(`string_agg of ${args.length} arguments`)
				}
				out.set(
					row,
					textsJoined(
						Arr.map(frame, (r) => at(value, r)),
						at(delimiter, row)
					)
				)
				continue
			}
			const [arg] = args
			if (arg === undefined || args.length !== 1) {
				return unevaluable(`the window aggregate ${name} of ${args.length} arguments`)
			}
			const values = Arr.map(frame, (r) => at(arg, r))
			out.set(
				row,
				name === "count"
					? { kind: "int", value: BigInt(Arr.filter(values, (v) => v !== undefined).length) }
					: aggregated(name, values)
			)
		}
	}
	return upTo(count, (row) => out.get(row))
}

class Model {
	readonly #schema: string
	readonly #tables = new Map<string, Live>()
	readonly #constraints = new Map<string, Map<string, Constraint>>()
	readonly #indexes = new Map<string, Index>()
	readonly #sequences = new Map<string, Sequence>()
	readonly #statistics = new Map<string, Statistics>()
	readonly #triggers = new Map<string, Map<string, Trigger>>()
	readonly #views = new Map<string, View>()
	readonly #dependents = new Map<string, View>()
	readonly #domains = new Map<string, Domain>()
	readonly #functions = new Map<string, Function>()
	readonly #databasePrivileges = new Map<string, ReadonlySet<string>>()
	/** The columns this run converted, by `<table>.<column>` under their current names. */
	readonly #converted = new Set<string>()
	#created: number

	constructor(schema: string, state: State) {
		this.#schema = schema
		for (const [name, t] of state.tables) {
			this.#tables.set(name, { columns: [...t.columns], rows: Arr.map(t.rows, (r) => new Map(r)) })
		}
		for (const [table, of] of state.constraints) {
			this.#constraints.set(table, new Map(of))
		}
		for (const [table, of] of state.triggers) {
			this.#triggers.set(table, new Map(of))
		}
		for (const [name, x] of state.indexes) {
			this.#indexes.set(name, x)
		}
		for (const [name, x] of state.sequences) {
			this.#sequences.set(name, x)
		}
		for (const [name, x] of state.statistics) {
			this.#statistics.set(name, x)
		}
		for (const [name, x] of state.views) {
			this.#views.set(name, x)
		}
		for (const [key, x] of state.dependents) {
			this.#dependents.set(key, x)
		}
		for (const [name, d] of state.domains) {
			this.#domains.set(name, d)
		}
		for (const [name, f] of state.functions) {
			this.#functions.set(name, f)
		}
		for (const [role, held] of state.databasePrivileges) {
			this.#databasePrivileges.set(role, held)
		}
		this.#created = state.created
	}

	/** Whether a name is of this schema; a statement on another schema's object is outside the model. */
	#ours(name: ObjectName): boolean {
		return name.schema === this.#schema
	}

	/** The relation namespace (pg_class): tables, views, sequences and indexes. */
	#relationTaken(name: string): boolean {
		return (
			this.#tables.has(name) ||
			this.#views.has(name) ||
			this.#sequences.has(name) ||
			this.#indexes.has(name)
		)
	}

	/** The type namespace (pg_type): domains, and the row types of tables and views; a sequence has none. */
	#typeTaken(name: string): boolean {
		return this.#domains.has(name) || this.#tables.has(name) || this.#views.has(name)
	}

	/** A name a new relation with a row type takes in both namespaces. */
	#claimRelation(name: string, what: string): void {
		if (this.#relationTaken(name)) {
			refuse("42P07", `the relation ${name} already exists, so ${what} cannot take it`)
		}
		if (this.#typeTaken(name)) {
			refuse("42710", `the type ${name} already exists, so ${what} cannot take it`)
		}
	}

	#table(name: ObjectName): Live {
		const t = this.#tables.get(name.name)
		if (t === undefined) {
			return refuse("42P01", `the table ${printObjectName(name)} does not exist`)
		}
		return t
	}

	#column(t: Live, table: ObjectName, column: string): Column {
		const c = Option.getOrUndefined(Arr.findFirst(t.columns, (x) => x.name === column))
		if (c === undefined) {
			return refuse("42703", `the column ${column} of ${printObjectName(table)} does not exist`)
		}
		return c
	}

	/** The position of a column a statement names, which must be there. */
	#columnAt(t: Live, table: ObjectName, column: string, what: string): number {
		const at = Arr.findFirstIndex(t.columns, (c) => c.name === column)
		return Option.isSome(at)
			? at.value
			: refuse("42703", `the ${what} column ${column} of ${printObjectName(table)} does not exist`)
	}

	/** The columns of a table or a view. */
	#columnsOfRelation(name: string): ReadonlyArray<string> {
		const t = this.#tables.get(name)
		if (t !== undefined) {
			return Arr.map(t.columns, (c) => c.name)
		}
		const v = this.#views.get(name)
		return v === undefined ? refuse("42P01", `the relation ${name} does not exist`) : v.columns
	}

	/** A table or a view the statement names, which must be there. */
	#relation(name: ObjectName): void {
		if (this.#ours(name) && !this.#tables.has(name.name) && !this.#views.has(name.name)) {
			refuse("42P01", `the relation ${printObjectName(name)} does not exist`)
		}
	}

	#constraintsOf(table: string): Map<string, Constraint> {
		const of = this.#constraints.get(table) ?? new Map<string, Constraint>()
		this.#constraints.set(table, of)
		return of
	}

	/** A table holds at most one primary key: a second is refused while the first stands. */
	#secondPrimaryKey(table: ObjectName, of: ReadonlyMap<string, Constraint>): void {
		if (Arr.some([...of.values()], (c) => c.kind === "primaryKey")) {
			refuse("42P16", `multiple primary keys for table ${printObjectName(table)} are not allowed`)
		}
	}

	#triggersOf(table: string): Map<string, Trigger> {
		const of = this.#triggers.get(table) ?? new Map<string, Trigger>()
		this.#triggers.set(table, of)
		return of
	}

	/** The foreign keys bound to an index, each as `<table>.<constraint>`. */
	#boundTo(index: string): ReadonlyArray<string> {
		return Arr.flatMap([...this.#constraints], ([table, of]) =>
			Arr.flatMap([...of], ([name, c]) =>
				c.kind === "foreignKey" && c.index === index ? [`${table}.${name}`] : []
			)
		)
	}

	/** What pins a column of a relation: each view that names it, each world's view and policy that names it, and each
	 * trigger whose UPDATE OF names it. */
	#pinning(relation: string, column: string): ReadonlyArray<string> {
		const views = Arr.flatMap([...this.#views], ([name, v]) =>
			v.reads.get(relation)?.has(column) === true ? [`the materialized view ${name}`] : []
		)
		const dependents = Arr.flatMap([...this.#dependents], ([key, v]) =>
			v.reads.get(relation)?.has(column) === true ? [`the ${key}`] : []
		)
		const triggers = Arr.flatMap(
			[...(this.#triggers.get(relation) ?? new Map<string, Trigger>())],
			([name, t]) => (t.columns.includes(column) ? [`the trigger ${name}`] : [])
		)
		return [...views, ...dependents, ...triggers]
	}

	/** Drops an index; its constraint, or a foreign key bound to it, stops the drop unless the constraint itself goes. */
	#dropIndex(name: string, by: string): void {
		const x = this.#indexes.get(name)
		if (x === undefined) {
			return
		}
		const [bound] = this.#boundTo(name)
		if (bound !== undefined) {
			refuse("2BP01", `${by} drops the index ${name}, which the foreign key ${bound} depends on`)
		}
		this.#indexes.delete(name)
	}

	/** Drops a constraint of a table, with its index; a foreign key bound to that index stops the drop. */
	#dropConstraint(table: string, name: string, by: string): void {
		const of = this.#constraints.get(table)
		const c = of?.get(name)
		if (of === undefined || c === undefined) {
			refuse("42704", `the constraint ${name} of ${table} does not exist`)
		}
		if (c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude") {
			this.#dropIndex(c.index, by)
		}
		of.delete(name)
	}

	#addColumn(table: ObjectName, column: Column, value: () => Cell | undefined): void {
		const t = this.#table(table)
		if (Arr.some(t.columns, (c) => c.name === column.name)) {
			refuse("42701", `the column ${column.name} of ${printObjectName(table)} already exists`)
		}
		const cell = t.rows.length === 0 ? undefined : value()
		if (t.rows.length > 0 && cell === undefined) {
			refuse(
				"23502",
				`the NOT NULL column ${column.name} is added to ${printObjectName(table)}, which holds rows, without a value`
			)
		}
		if (column.generation.kind === "identity") {
			this.#claimSequence(column.generation.sequence, table.name, column.name)
		}
		t.columns.push(column)
		if (cell !== undefined) {
			for (const row of t.rows) {
				row.set(column.name, cell)
			}
		}
	}

	/** A sequence takes its name in the relation namespace alone: it has no row type. */
	#claimSequence(name: string, table: string, column: string): void {
		if (this.#relationTaken(name)) {
			refuse(
				"42P07",
				`the relation ${name} already exists, so the identity sequence of ${table}.${column} cannot take it`
			)
		}
		this.#sequences.set(name, { kind: "identity", table, column })
	}

	#dropColumn(table: ObjectName, column: string): void {
		const t = this.#table(table)
		const at = this.#columnAt(t, table, column, "dropped")
		const c = t.columns[at]
		if (c === undefined) {
			return refuse(
				"42703",
				`the dropped column ${column} of ${printObjectName(table)} does not exist`
			)
		}
		const [pinned] = this.#pinning(table.name, column)
		if (pinned !== undefined) {
			refuse(
				"2BP01",
				`the column ${column} of ${printObjectName(table)} is dropped while ${pinned} depends on it`
			)
		}
		const by = `dropping the column ${column} of ${printObjectName(table)}`
		/** The constraints over the column go with it, foreign keys first, each key with its index. */
		const of = this.#constraintsOf(table.name)
		for (const [name, x] of Arr.filter(Arr.fromIterable(of), ([, c]) => c.kind === "foreignKey")) {
			if (x.columns.includes(column)) {
				of.delete(name)
			}
		}
		for (const [name, x] of Arr.fromIterable(of)) {
			if (x.columns.includes(column)) {
				this.#dropConstraint(table.name, name, by)
			}
		}
		for (const [name, x] of Arr.fromIterable(this.#indexes)) {
			if (x.on === table.name && x.owner.kind === "free" && x.reads.includes(column)) {
				this.#dropIndex(name, by)
			}
		}
		for (const [name, s] of Arr.fromIterable(this.#statistics)) {
			if (s.table === table.name && s.columns.includes(column)) {
				this.#statistics.delete(name)
			}
		}
		if (c.generation.kind === "identity") {
			this.#sequences.delete(c.generation.sequence)
		}
		t.columns.splice(at, 1)
		for (const row of t.rows) {
			row.delete(column)
		}
	}

	/** A column converted in this run, which it may be once. */
	#convertOnce(table: string, column: string): void {
		const key = `${table}.${column}`
		if (this.#converted.has(key)) {
			stop(
				{ kind: "converted twice" },
				`the column ${column} of ${table} is converted twice in one migration, where a draft converts it once`
			)
		}
		this.#converted.add(key)
	}

	/**
	 * A column converted to `type`, each row's cell as `conversion` makes it. PostgreSQL converts a column's default with
	 * it, by an assignment cast: a `uuidv7()` default casts to text, which keeps it, and to no other type the model
	 * holds (42804).
	 */
	#retype(table: ObjectName, column: string, type: TypeRef, conversion: Conversion): void {
		const t = this.#table(table)
		const at = this.#columnAt(t, table, column, "retyped")
		if (t.columns[at]?.generation.kind === "uuidv7" && !this.#ofBase(type, "text")) {
			refuse(
				"42804",
				`default for column "${column}" cannot be cast automatically to type ${printType(type)}`
			)
		}
		this.#convertOnce(table.name, column)
		const [pinned] = this.#pinning(table.name, column)
		if (pinned !== undefined) {
			refuse(
				"0A000",
				`the type of ${printObjectName(table)}.${column} is changed while ${pinned} depends on it`
			)
		}
		const cell = conversion.kind === "kept" || t.rows.length === 0 ? undefined : conversion.value()
		if (conversion.kind === "given" && t.rows.length > 0 && cell === undefined) {
			stop(
				{ kind: "unknown conversion" },
				`the column ${column} of ${printObjectName(table)}, which holds rows, is converted by an expression the model does not know`
			)
		}
		const c = t.columns[at]
		if (c !== undefined) {
			t.columns[at] = { ...c, type }
		}
		if (cell !== undefined) {
			for (const row of t.rows) {
				row.set(column, cell)
			}
		}
	}

	/** Whether `using` converts the column `column` of `table` by its cast to `type`, a type of the column's base, the
	 * domains of both read through: the cast keeps each row's value. */
	#byCast(table: ObjectName, column: string, using: Expr, type: TypeRef): boolean {
		if (
			using.kind !== "cast" ||
			using.expr.kind !== "column" ||
			using.expr.column !== column ||
			printType(using.type) !== printType(type)
		) {
			return false
		}
		const from = this.#column(this.#table(table), table, column).type
		return printType(this.#base(from)) === printType(this.#base(type))
	}

	/** Whether a type is the builtin `name`, a domain of the schema over it read through, and no array of it. */
	#ofBase(type: TypeRef, name: "uuid" | "text"): boolean {
		const base = this.#base(type)
		return base.kind === "builtin" && base.name === name && !base.array
	}

	/** A column's type as a foreign key compares it: a domain of the schema read through to its base type. */
	#base(type: TypeRef): TypeRef {
		if (type.kind !== "named" || type.schema !== this.#schema) {
			return type
		}
		const d = this.#domains.get(type.name)
		if (d === undefined) {
			return type
		}
		if (!type.array || d.base.array) {
			return this.#base(d.base)
		}
		if (d.base.kind === "builtin" && d.base.name === "bit") {
			throw new Error(`an array of the bits domain ${type.name}, which no column has`)
		}
		return this.#base({ ...d.base, array: true })
	}

	/** Every foreign key's columns compare (see comparable): PostgreSQL requires it when it adds the key, and adds every
	 * key over a column again at the end of a statement that changes the column's type, on either side. No other
	 * statement changes what a key compares, so the model checks every key after each action. */
	#foreignKeysComparable(): void {
		for (const [source, of] of this.#constraints) {
			for (const [name, c] of of) {
				if (c.kind !== "foreignKey") {
					continue
				}
				const table: ObjectName = { schema: this.#schema, name: source }
				const target: ObjectName = { schema: this.#schema, name: c.references }
				const t = this.#table(table)
				const u = this.#table(target)
				for (const [i, column] of c.columns.entries()) {
					const referenced = c.referenced[i]
					if (referenced === undefined) {
						throw new Error(
							`the foreign key ${name} of ${source} references fewer columns than it has`
						)
					}
					const from = this.#column(t, table, column).type
					const to = this.#column(u, target, referenced).type
					if (!comparable(this.#base(from), this.#base(to))) {
						refuse(
							"42804",
							`the foreign key ${name} of ${source} cannot be implemented: ${source}.${column} of type ${printType(from)} and ${c.references}.${referenced} of type ${printType(to)} do not compare`
						)
					}
				}
			}
		}
	}

	/** The index a foreign key referencing `columns` of `table` binds: the first in creation order that may be bound
	 * whose keys are those columns, as a set. */
	#bindable(table: string, columns: ReadonlyArray<string>): string {
		const [first] = Arr.sort(
			Arr.filter(
				Arr.fromIterable(this.#indexes),
				([, x]) => x.on === table && x.bindable && sameSet(x.keys, columns)
			),
			byCreation
		)
		if (first === undefined) {
			return refuse(
				"42830",
				`there is no unique constraint matching the keys (${Arr.join(columns, ", ")}) of the referenced table ${table}`
			)
		}
		return first[0]
	}

	#addIndex(name: string, index: Omit<Index, "order">): void {
		if (this.#relationTaken(name)) {
			refuse("42P07", `the relation ${name} already exists, so an index cannot take it`)
		}
		this.#indexes.set(name, { ...index, order: this.#created++ })
	}

	#constraint(table: ObjectName, c: TableConstraint, valid: boolean): void {
		const t = this.#table(table)
		const of = this.#constraintsOf(table.name)
		if (of.has(c.name)) {
			refuse("42710", `the constraint ${c.name} of ${printObjectName(table)} already exists`)
		}
		switch (c.kind) {
			case "primaryKey":
			case "unique": {
				if (c.kind === "primaryKey") {
					this.#secondPrimaryKey(table, of)
				}
				const columns = Arr.map(c.columns, (k) => k.column)
				for (const k of columns) {
					this.#column(t, table, k)
				}
				this.#addIndex(c.name, {
					on: table.name,
					method: Arr.some(c.columns, (k) => k.withoutOverlaps) ? "gist" : "btree",
					unique: true,
					keys: columns,
					reads: columns,
					bindable: true,
					owner: { kind: "constraint", name: c.name }
				})
				of.set(c.name, { kind: c.kind, columns, index: c.name, valid })
				return
			}
			case "exclude": {
				const columns = Arr.map(c.elements, (e) => e.column)
				for (const k of columns) {
					this.#column(t, table, k)
				}
				this.#addIndex(c.name, {
					on: table.name,
					method: c.method,
					unique: false,
					keys: columns,
					reads: columns,
					bindable: false,
					owner: { kind: "constraint", name: c.name }
				})
				of.set(c.name, { kind: "exclude", columns, index: c.name, valid })
				return
			}
			case "foreignKey": {
				const columns = Arr.map(c.columns, (k) => k.column)
				for (const k of columns) {
					this.#column(t, table, k)
				}
				if (!this.#ours(c.references)) {
					return
				}
				const target = this.#table(c.references)
				const referenced = Arr.map(c.referencedColumns, (k) => k.column)
				for (const k of referenced) {
					this.#column(target, c.references, k)
				}
				of.set(c.name, {
					kind: "foreignKey",
					columns,
					references: c.references.name,
					referenced,
					index: this.#bindable(c.references.name, referenced),
					valid
				})
				return
			}
			case "check": {
				const columns = columnsOf(c.predicate)
				for (const k of columns) {
					this.#column(t, table, k)
				}
				const calls = callsOf([c.predicate], this.#schema)
				this.#callable(calls, `the constraint ${c.name} of ${printObjectName(table)}`)
				if (valid) {
					this.#validateCheck(table.name, c.name, c.predicate)
				}
				of.set(c.name, { kind: "check", columns, predicate: c.predicate, calls, valid })
				return
			}
		}
	}

	/** Renames a column in everything that names it. */
	#renameColumnIn(table: string, from: string, to: string): void {
		const swap = (columns: ReadonlyArray<string>) => Arr.map(columns, (c) => (c === from ? to : c))
		for (const [source, of] of this.#constraints) {
			for (const [name, c] of of) {
				const columns = source === table ? swap(c.columns) : c.columns
				if (c.kind === "foreignKey") {
					of.set(name, {
						...c,
						columns,
						referenced: c.references === table ? swap(c.referenced) : c.referenced
					})
				} else {
					of.set(name, { ...c, columns })
				}
			}
		}
		for (const [name, x] of this.#indexes) {
			if (x.on === table) {
				this.#indexes.set(name, { ...x, keys: swap(x.keys), reads: swap(x.reads) })
			}
		}
		for (const [name, s] of this.#statistics) {
			if (s.table === table) {
				this.#statistics.set(name, { ...s, columns: swap(s.columns) })
			}
		}
		for (const [name, t] of this.#triggers.get(table) ?? new Map<string, Trigger>()) {
			this.#triggersOf(table).set(name, { ...t, columns: swap(t.columns) })
		}
		for (const [name, v] of this.#views) {
			const read = v.reads.get(table)
			if (read === undefined) {
				continue
			}
			const reads = new Map(v.reads)
			reads.set(table, new Set(swap([...read])))
			this.#views.set(name, { ...v, reads })
		}
		for (const [key, v] of this.#dependents) {
			const read = v.reads.get(table)
			if (read === undefined) {
				continue
			}
			const reads = new Map(v.reads)
			reads.set(table, new Set(swap([...read])))
			this.#dependents.set(key, { ...v, reads })
		}
		for (const [name, s] of this.#sequences) {
			if (s.kind === "identity" && s.table === table && s.column === from) {
				this.#sequences.set(name, { ...s, column: to })
			}
		}
		if (this.#converted.delete(`${table}.${from}`)) {
			this.#converted.add(`${table}.${to}`)
		}
	}

	/** Renames a relation in everything that names it. */
	#renameRelationIn(from: string, to: string): void {
		for (const key of Arr.fromIterable(this.#converted)) {
			if (Str.startsWith(`${from}.`)(key)) {
				this.#converted.delete(key)
				this.#converted.add(`${to}.${Str.slice(from.length + 1)(key)}`)
			}
		}
		for (const of of this.#constraints.values()) {
			for (const [name, c] of of) {
				if (c.kind === "foreignKey" && c.references === from) {
					of.set(name, { ...c, references: to })
				}
			}
		}
		for (const [name, x] of this.#indexes) {
			if (x.on === from) {
				this.#indexes.set(name, { ...x, on: to })
			}
		}
		for (const [name, s] of this.#statistics) {
			if (s.table === from) {
				this.#statistics.set(name, { ...s, table: to })
			}
		}
		for (const [name, s] of this.#sequences) {
			if (s.kind === "identity" && s.table === from) {
				this.#sequences.set(name, { ...s, table: to })
			}
		}
		for (const [name, v] of this.#views) {
			const read = v.reads.get(from)
			if (read === undefined) {
				continue
			}
			const reads = new Map(v.reads)
			reads.delete(from)
			reads.set(to, read)
			this.#views.set(name, { ...v, reads })
		}
		for (const [key, v] of Arr.fromIterable(this.#dependents)) {
			const read = v.reads.get(from)
			if (read === undefined) {
				continue
			}
			const reads = new Map(v.reads)
			reads.delete(from)
			reads.set(to, read)
			this.#dependents.delete(key)
			this.#dependents.set(
				Str.startsWith(`policy ${from}.`)(key)
					? `policy ${to}.${Str.slice(`policy ${from}.`.length)(key)}`
					: key,
				{
					...v,
					reads
				}
			)
		}
	}

	/** Renames an index, and the constraint it implements with it, which PostgreSQL renames together. */
	#renameIndex(from: string, to: string): void {
		const x = this.#indexes.get(from)
		if (x === undefined) {
			refuse("42P01", `the index ${from} does not exist`)
		}
		if (this.#relationTaken(to)) {
			refuse("42P07", `the relation ${to} already exists, so the index ${from} cannot take it`)
		}
		this.#indexes.delete(from)
		const owner: IndexOwner =
			x.owner.kind === "constraint" ? { kind: "constraint", name: to } : x.owner
		this.#indexes.set(to, { ...x, owner })
		for (const of of this.#constraints.values()) {
			for (const [name, c] of Arr.fromIterable(of)) {
				if (c.kind === "foreignKey" && c.index === from) {
					of.set(name, { ...c, index: to })
				}
				if (c.kind !== "foreignKey" && c.kind !== "check" && c.index === from) {
					of.delete(name)
					of.set(to, { ...c, index: to })
				}
			}
		}
	}

	/**
	 * Whether `using` converts the set column `column` to the bits domain `type` by its cast to bit(n′), n′ the domain's
	 * width: a roster's growth, whose new codes are absent from every stored set.
	 */
	#bitsWidening(column: string, using: Expr, type: TypeRef): number | undefined {
		const base = this.#base(type)
		return using.kind === "cast" &&
			using.expr.kind === "column" &&
			using.expr.column === column &&
			using.type.kind === "builtin" &&
			using.type.name === "bit" &&
			base.kind === "builtin" &&
			base.name === "bit" &&
			base.length === using.type.length
			? base.length
			: undefined
	}

	/** A set column widened to the bits domain `type` of `length` bits: each stored set padded with zeros on the right,
	 * then every row checked against the new domain's valid CHECKs (23514). */
	#widenBits(table: ObjectName, column: string, type: TypeRef, length: number): void {
		const t = this.#table(table)
		const at = this.#columnAt(t, table, column, "converted")
		this.#convertOnce(table.name, column)
		const [pinned] = this.#pinning(table.name, column)
		if (pinned !== undefined) {
			refuse(
				"0A000",
				`the type of ${printObjectName(table)}.${column} is changed while ${pinned} depends on it`
			)
		}
		for (const row of t.rows) {
			const cell = row.get(column)
			if (cell?.kind === "value" && cell.value.kind === "text") {
				row.set(column, {
					kind: "value",
					value: { kind: "text", value: toLength(cell.value.value, length) }
				})
			}
		}
		const c = t.columns[at]
		if (c !== undefined) {
			t.columns[at] = { ...c, type }
		}
		for (const [name, check] of this.#checksOfType(type)) {
			if (check.valid) {
				this.#validateColumn(table.name, column, name, check)
			}
		}
	}

	/** A named type of the schema a column or a domain is declared with, which must be there. */
	#typeExists(type: TypeRef): void {
		if (type.kind === "named" && type.schema === this.#schema && !this.#domains.has(type.name)) {
			refuse("42704", `the type ${printType(type)} does not exist`)
		}
	}

	#renameType(name: ObjectName, to: string): void {
		const d = this.#domains.get(name.name)
		if (d === undefined) {
			refuse("42704", `the domain ${printObjectName(name)} does not exist`)
		}
		if (this.#typeTaken(to)) {
			refuse("42710", `the type ${to} already exists`)
		}
		this.#domains.delete(name.name)
		this.#domains.set(to, d)
		const renamed = (type: TypeRef): TypeRef =>
			type.kind === "named" && type.schema === name.schema && type.name === name.name
				? { ...type, name: to }
				: type
		for (const t of this.#tables.values()) {
			t.columns = Arr.map(t.columns, (c) => ({ ...c, type: renamed(c.type) }))
		}
		for (const [n, x] of this.#domains) {
			this.#domains.set(n, { ...x, base: renamed(x.base) })
		}
		for (const of of this.#triggers.values()) {
			for (const [n, t] of of) {
				of.set(n, { ...t, types: Arr.map(t.types, renamed) })
			}
		}
	}

	#dropType(name: ObjectName, ifExists: boolean): void {
		if (!this.#domains.has(name.name)) {
			if (!ifExists) {
				refuse("42704", `the domain ${printObjectName(name)} does not exist`)
			}
			return
		}
		const isOf = (type: TypeRef) =>
			type.kind === "named" && type.schema === name.schema && type.name === name.name
		for (const [table, t] of this.#tables) {
			for (const c of t.columns) {
				if (isOf(c.type)) {
					refuse(
						"2BP01",
						`the type ${printObjectName(name)} is dropped while ${table}.${c.name} still uses it`
					)
				}
			}
		}
		for (const [domain, d] of this.#domains) {
			if (isOf(d.base)) {
				refuse(
					"2BP01",
					`the type ${printObjectName(name)} is dropped while the domain ${domain} is of it`
				)
			}
		}
		for (const [table, of] of this.#triggers) {
			for (const [trigger, t] of of) {
				if (Arr.some(t.types, isOf)) {
					refuse(
						"2BP01",
						`the type ${printObjectName(name)} is dropped while the trigger ${trigger} of ${table} casts to it`
					)
				}
			}
		}
		this.#domains.delete(name.name)
	}

	/** The functions a new object calls, each of which must be there (42883). */
	#callable(calls: ReadonlyArray<string>, what: string): void {
		for (const name of calls) {
			if (!this.#functions.has(name)) {
				refuse(
					"42883",
					`${what} calls the function ${this.#schema}.${name}(), which does not exist`
				)
			}
		}
	}

	/** The value a constant of the schema returns, its body evaluated; Unevaluable for a function that is no constant. */
	#constant(name: string, seen: ReadonlySet<string>): SqlValue {
		const f = this.#functions.get(name)
		if (f === undefined) {
			return refuse("42883", `the function ${this.#schema}.${name}() does not exist`)
		}
		if (seen.has(name)) {
			return unevaluable(`the constant ${name}, which calls itself`)
		}
		switch (f.body.kind) {
			case "opaque":
				return unevaluable(`the function ${name}, which is no constant`)
			case "packed":
				return { kind: "bits", value: f.body.bits }
			case "constant": {
				const inner = new Set([...seen, name])
				return evaluate(f.body.expr, {
					value: undefined,
					columns: new Map(),
					constant: (n) => this.#constant(n, inner)
				})
			}
		}
	}

	/** A stored cell as the evaluator reads it in a column of `type`: a set's bit string, a code, a text; undefined for
	 * NULL; Unevaluable for a generated cell or a value of another kind. */
	#cellValue(cell: Cell | undefined, type: TypeRef): SqlValue {
		if (cell === undefined || cell.kind === "generated") {
			return unevaluable("a cell the model does not hold")
		}
		const v = cell.value
		switch (v.kind) {
			case "int":
				return { kind: "int", value: v.value }
			case "bool":
				return { kind: "bool", value: v.value }
			case "text": {
				const base = this.#base(type)
				return base.kind === "builtin" && (base.name === "bit" || base.name === "bit varying")
					? { kind: "bits", value: v.value }
					: { kind: "text", value: v.value }
			}
			case "uuid":
			case "date":
				return { kind: "text", value: v.value }
			case "float":
			case "floatSpecial":
			case "handle":
			case "handles":
			case "money":
			case "numeric":
			case "span":
			case "vector":
				return unevaluable(`a ${v.kind} cell`)
		}
	}

	/** Whether `predicate` admits `value` (with `columns` bound): true, false or NULL, or undefined when the model cannot
	 * evaluate it. A CHECK passes unless its predicate is false or NULL: IS TRUE. */
	#admits(
		predicate: Expr,
		value: SqlValue,
		columns: ReadonlyMap<string, SqlValue>
	): boolean | undefined {
		try {
			const v = evaluate(predicate, {
				value,
				columns,
				constant: (n) => this.#constant(n, new Set())
			})
			return v?.kind === "bool" && v.value
		} catch (error) {
			if (error instanceof Unevaluable) {
				return undefined
			}
			throw error
		}
	}

	/** The CHECKs a value of `type` must meet: every CHECK of each domain of the schema it is, read through to its base. */
	#checksOfType(type: TypeRef): ReadonlyArray<readonly [string, DomainCheck]> {
		if (type.kind !== "named" || type.schema !== this.#schema) {
			return []
		}
		const d = this.#domains.get(type.name)
		return d === undefined ? [] : [...d.constraints, ...this.#checksOfType(d.base)]
	}

	/** Every stored value of `column` of `table` meets the domain CHECK `name`, or the VALIDATE fails naming the table and
	 * the column, as PostgreSQL's validateDomainCheckConstraint does (23514). */
	#validateColumn(table: string, column: string, name: string, check: DomainCheck): void {
		const t = this.#tables.get(table)
		const c = Option.getOrUndefined(Arr.findFirst(t?.columns ?? [], (x) => x.name === column))
		if (t === undefined || c === undefined) {
			return
		}
		for (const row of t.rows) {
			let value: SqlValue
			try {
				value = this.#cellValue(row.get(column), c.type)
			} catch (error) {
				if (error instanceof Unevaluable) {
					continue
				}
				throw error
			}
			if (this.#admits(check.predicate, value, new Map()) === false) {
				refuse(
					"23514",
					`column ${column} of table ${table} contains values that violate the new constraint ${name}`
				)
			}
		}
	}

	/** The domain CHECK `name` of `domain` validated over every column of the domain, a domain over it included. */
	#validateDomain(domain: string, name: string, check: DomainCheck): void {
		const isOf = (type: TypeRef): boolean =>
			type.kind === "named" &&
			type.schema === this.#schema &&
			(type.name === domain || this.#domainOver(type.name, domain))
		for (const [table, t] of this.#tables) {
			for (const c of t.columns) {
				if (isOf(c.type)) {
					this.#validateColumn(table, c.name, name, check)
				}
			}
		}
	}

	/** Whether the domain `name` is, at any depth, a domain over `domain`. */
	#domainOver(name: string, domain: string): boolean {
		const d = this.#domains.get(name)
		return (
			d?.base.kind === "named" &&
			d.base.schema === this.#schema &&
			(d.base.name === domain || this.#domainOver(d.base.name, domain))
		)
	}

	/** The schema's domains as a data step's casts and literals read them (TypeReader): a value of a domain must meet
	 * every CHECK of each domain it is, one the model cannot evaluate taken to hold. */
	#types(): TypeReader {
		return {
			base: (type) => this.#base(type),
			admit: (type, value) => {
				for (const [name, check] of this.#checksOfType(type)) {
					if (this.#admits(check.predicate, value, new Map()) === false) {
						refuse(
							"23514",
							`value for domain ${printType(type)} violates check constraint "${name}"`
						)
					}
				}
			}
		}
	}

	/** The scope a data step evaluates a query row in: its columns, and the schema's constants and domains. */
	#scope(columns: ReadonlyMap<string, SqlValue>): Scope {
		return {
			value: undefined,
			columns,
			constant: (n: string) => this.#constant(n, new Set()),
			types: this.#types()
		}
	}

	/** The scope of a query row whose query has window functions: the row's, and its value of each. */
	#windowScope(
		columns: ReadonlyMap<string, SqlValue>,
		window: (call: FunctionCall) => SqlValue
	): Scope {
		return { ...this.#scope(columns), window }
	}

	/** A stored row as a query reads it: each cell the model evaluates, by column. */
	#tuple(columns: ReadonlyArray<Column>, row: ReadonlyMap<string, Cell>): Tuple {
		const out = new Map<string, SqlValue>()
		for (const c of columns) {
			try {
				out.set(c.name, this.#cellValue(row.get(c.name), c.type))
			} catch (error) {
				if (!(error instanceof Unevaluable)) {
					throw error
				}
			}
		}
		return out
	}

	/** The rows a FROM source binds, each under its alias: a table of the schema's, a derived table's query, or a CTE's. */
	#sourceRows(source: FromSource, ctes: Ctes): ReadonlyArray<Map<string, SqlValue>> {
		switch (source.kind) {
			case "table": {
				if (typeof source.table === "string" || !this.#ours(source.table)) {
					return unevaluable("a table outside the schema")
				}
				const t = this.#table(source.table)
				return Arr.map(t.rows, (row) => bound(source.alias, this.#tuple(t.columns, row)))
			}
			case "derived": {
				const r = this.#select(source.query, ctes)
				return Arr.map(r.rows, (row) => bound(source.alias, renamed(r, source.columns, row)))
			}
			case "cte": {
				const r = ctes.get(source.name)
				if (r === undefined) {
					return refuse("42P01", `relation "${source.name}" does not exist`)
				}
				return Arr.map(r.rows, (row) => bound(source.alias ?? source.name, row))
			}
			case "enclosing":
			case "function":
			case "arrays":
			case "values":
			case "context":
			case "probe":
			case "met":
			case "metRows":
				return unevaluable(`a FROM source of kind ${source.kind}`)
		}
	}

	/** The rows a FROM item binds: a source's, or a join chain's, each step's source joined to the rows before it. */
	#itemRows(item: FromItem, ctes: Ctes): ReadonlyArray<Map<string, SqlValue>> {
		if (item.kind !== "joins") {
			return this.#sourceRows(item, ctes)
		}
		let rows = this.#sourceRows(item.first, ctes)
		for (const step of item.steps) {
			const right = this.#sourceRows(step.source, ctes)
			rows = Arr.flatMap(rows, (left) =>
				Arr.flatMap(right, (r) => {
					const both = joined(left, r)
					return step.kind === "cross" || truthOf(evaluate(step.on, this.#scope(both))) === true
						? [both]
						: []
				})
			)
		}
		return rows
	}

	/** The rows a FROM list binds: every item's rows crossed, one row of no column for an empty list. */
	#fromRows(from: ReadonlyArray<FromItem>, ctes: Ctes): ReadonlyArray<Map<string, SqlValue>> {
		return Arr.reduce(from, [new Map<string, SqlValue>()], (rows, item) => {
			const right = this.#itemRows(item, ctes)
			return Arr.flatMap(rows, (left) => Arr.map(right, (r) => joined(left, r)))
		})
	}

	/** The relation a query yields: its WITH's CTEs bound, then its body. An ordered or limited query is Unevaluable: a
	 * data step reads relations, which are sets. */
	#select(q: OperandSelect, ctes: Ctes): Relation {
		if (q.orderBy.length > 0 || q.limit !== undefined || q.offset !== undefined) {
			return unevaluable("an ordered or limited query")
		}
		const inner = q.with === undefined ? ctes : this.#with(q.with, ctes)
		const body = q.body
		switch (body.kind) {
			case "core":
				return this.#core(body, inner)
			case "select":
				return this.#select(body, inner)
			case "setOp": {
				if (body.op !== "UNION" && body.op !== "UNION ALL") {
					return unevaluable(`the set operation ${body.op}`)
				}
				const [first, ...rest] = Arr.map(body.arms, (a) => this.#operand(a, inner))
				const names = first.names
				const rows = Arr.flatMap([first, ...rest], (r) => positional(r, names))
				return { names, rows: body.op === "UNION" ? distinctRows(names, rows) : rows }
			}
		}
	}

	/** A set operation's arm as a relation. */
	#operand(a: SetOperand, ctes: Ctes): Relation {
		return a.kind === "core" ? this.#core(a, ctes) : this.#select(a, ctes)
	}

	/** The CTEs of a WITH, each bound in turn over those before it; under WITH RECURSIVE, one that reads itself by its
	 * recursion (recursive). */
	#with(w: NonNullable<OperandSelect["with"]>, ctes: Ctes): Ctes {
		const out = new Map(ctes)
		for (const c of w.ctes) {
			if (c.query.kind !== "select") {
				return unevaluable("a data-modifying CTE")
			}
			const r =
				w.recursive && readsCte(c.query, c.name)
					? this.#recursive(c.name, c.columns, c.query, out)
					: this.#select(c.query, out)
			out.set(c.name, c.columns.length === 0 ? r : renamedRelation(r, c.columns))
		}
		return out
	}

	/**
	 * A recursive CTE as the SQL standard evaluates it: its first arm's rows, then its second arm over the rows the
	 * previous round added, the working table, until a round adds none; under UNION a row already held is no new row,
	 * so a recursion over a finite set of rows ends. A recursion that runs past a bound the model sets is its defect.
	 */
	#recursive(name: string, columns: ReadonlyArray<string>, q: OperandSelect, ctes: Ctes): Relation {
		const body = q.body
		if (
			body.kind !== "setOp" ||
			(body.op !== "UNION" && body.op !== "UNION ALL") ||
			body.arms.length !== 2 ||
			q.orderBy.length > 0 ||
			q.limit !== undefined ||
			q.offset !== undefined
		) {
			return unevaluable("a recursive CTE of another shape")
		}
		const [anchorArm, stepArm] = body.arms
		const anchor = this.#operand(anchorArm, ctes)
		const names = columns.length === 0 ? anchor.names : columns
		const seen = new Set<string>()
		const rows: Array<Tuple> = []
		const added = (r: Relation): ReadonlyArray<Tuple> =>
			Arr.filter(positional(r, names), (row) => {
				const key = groupText(Arr.map(names, (n) => row.get(n)))
				if (body.op === "UNION" && seen.has(key)) {
					return false
				}
				seen.add(key)
				rows.push(row)
				return true
			})
		let working = added(anchor)
		let round = 0
		while (working.length > 0) {
			round += 1
			if (round > recursionBound) {
				throw new Error(`the recursive CTE ${name} runs past ${recursionBound} rounds`)
			}
			const inner = new Map(ctes)
			inner.set(name, { names, rows: working })
			working = added(this.#operand(stepArm, inner))
		}
		return { names, rows }
	}

	/** The relation a SELECT core yields over its FROM's rows its WHERE keeps: each target evaluated per row, a window
	 * function over every row the WHERE keeps (windowColumn), computed once per call; DISTINCT keeps each row once. A
	 * grouped core is Unevaluable. */
	#core(c: SelectCore, ctes: Ctes): Relation {
		if (c.having !== undefined) {
			return unevaluable("a HAVING")
		}
		const where = c.where
		const rows = Arr.filter(
			this.#fromRows(c.from, ctes),
			(row) => where === undefined || truthOf(evaluate(where, this.#scope(row))) === true
		)
		if (c.groupBy.length > 0 || Arr.some(c.targets, (t) => callsAggregate(t.expr))) {
			return this.#grouped(c, rows)
		}
		const windows = new Map<FunctionCall, ReadonlyArray<SqlValue>>()
		const windowAt =
			(i: number) =>
			(call: FunctionCall): SqlValue => {
				const known = windows.get(call)
				const values =
					known ?? windowColumn(call, rows.length, (j) => this.#scope(Arr.getUnsafe(rows, j)))
				windows.set(call, values)
				return values[i]
			}
		const names = Arr.map(
			c.targets,
			(t) => t.alias ?? (t.expr.kind === "column" ? t.expr.column : "?column?")
		)
		const out = Arr.map(
			rows,
			(row, i): Tuple =>
				new Map(
					Arr.map(c.targets, (t, k) => [
						Arr.getUnsafe(names, k),
						evaluate(t.expr, this.#windowScope(row, windowAt(i)))
					])
				)
		)
		if (c.distinct === false) {
			return { names, rows: out }
		}
		if (c.distinct !== true) {
			return unevaluable("DISTINCT ON")
		}
		const seen = new Set<string>()
		return {
			names,
			rows: Arr.filter(out, (t) => {
				const key = groupText(Arr.map(names, (n) => t.get(n)))
				const fresh = !seen.has(key)
				seen.add(key)
				return fresh
			})
		}
	}

	/**
	 * A grouped core's relation: its rows grouped by its GROUP BY's values, every row one group when it has none (and
	 * then one row even over no row), each target evaluated over the group's first row, its aggregates over every row
	 * of the group (aggregateOver). A target that reads a column no group fixes reads the first row's, which PostgreSQL
	 * refuses (42803): the model trusts the statement there.
	 */
	#grouped(c: SelectCore, rows: ReadonlyArray<Map<string, SqlValue>>): Relation {
		if (c.distinct !== false) {
			return unevaluable("DISTINCT over a grouped query")
		}
		const groups = new Map<string, Array<number>>()
		if (c.groupBy.length === 0) {
			groups.set(
				"",
				upTo(rows.length, (i) => i)
			)
		}
		for (const [i, row] of c.groupBy.length === 0 ? [] : rows.entries()) {
			const key = groupText(Arr.map(c.groupBy, (e) => evaluate(e, this.#scope(row))))
			const members = groups.get(key) ?? []
			members.push(i)
			groups.set(key, members)
		}
		const scopeOf = (i: number): Scope => this.#scope(Arr.getUnsafe(rows, i))
		const names = Arr.map(
			c.targets,
			(t) => t.alias ?? (t.expr.kind === "column" ? t.expr.column : "?column?")
		)
		return {
			names,
			rows: Arr.map([...groups.values()], (members): Tuple => {
				const [first] = members
				const scope: Scope = {
					...this.#scope(first === undefined ? new Map() : Arr.getUnsafe(rows, first)),
					aggregate: (call) => aggregateOver(call, members, scopeOf)
				}
				return new Map(
					Arr.map(c.targets, (t, k) => [Arr.getUnsafe(names, k), evaluate(t.expr, scope)] as const)
				)
			})
		}
	}

	/** A value assigned to `column` of `table`, as PostgreSQL stores it: never NULL (23502), every column being NOT NULL;
	 * a bit string of the length its bit(n) base has (22026); cast to its type, a domain's CHECKs judging it (23514) and
	 * an integer type's range bounding it (22003); and held as the model holds a cell, a set as its bit string's text. */
	#stored(v: SqlValue, column: Column, table: ObjectName): Cell {
		if (v === undefined) {
			return refuse(
				"23502",
				`null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`
			)
		}
		const base = this.#base(column.type)
		if (
			base.kind === "builtin" &&
			base.name === "bit" &&
			v.kind === "bits" &&
			v.value.length !== base.length
		) {
			refuse("22026", `bit string length ${v.value.length} does not match type bit(${base.length})`)
		}
		const value = castTo(v, column.type, this.#scope(new Map()))
		switch (value?.kind) {
			case "int":
				return { kind: "value", value: { kind: "int", value: value.value } }
			case "bool":
				return { kind: "value", value: { kind: "bool", value: value.value } }
			case "bits":
			case "text":
				return { kind: "value", value: { kind: "text", value: value.value } }
			case "names":
			case undefined:
				return unevaluable(`a value of ${printType(column.type)}`)
		}
	}

	/** A row's columns as a CHECK reads them, or undefined when the model does not hold one of its cells. */
	#checkColumns(t: Live, row: ReadonlyMap<string, Cell>): Map<string, SqlValue> | undefined {
		try {
			return new Map(
				Arr.map(t.columns, (c) => [`.${c.name}`, this.#cellValue(row.get(c.name), c.type)] as const)
			)
		} catch (error) {
			if (error instanceof Unevaluable) {
				return undefined
			}
			throw error
		}
	}

	/**
	 * UPDATE … FROM … WHERE, as PostgreSQL runs it: each row of the table joined to the rows of its FROM the WHERE keeps;
	 * a row joined to none keeps its values, and one joined to one takes each SET's value, evaluated over its old values
	 * and the joined row, all rows at once; a row joined to several PostgreSQL updates from one it chooses, which no data
	 * step may leave to it, so the model throws. Each assigned value is stored as its column's type stores it (stored),
	 * a generated column refused (428C9), and every CHECK of the table, valid or NOT VALID, then judges each new row
	 * (23514). The model holds no row's key or foreign key: those VALIDATE and the key's build judge.
	 */
	#update(s: Update): void {
		if (s.returning.length > 0) {
			return unevaluable("an UPDATE that returns rows")
		}
		const ctes = s.with === undefined ? new Map<string, Relation>() : this.#with(s.with, new Map())
		const t = this.#table(s.table)
		const columns = new Map(Arr.map(t.columns, (c) => [c.name, c] as const))
		for (const a of s.set) {
			const c = columns.get(a.column)
			if (c === undefined) {
				refuse("42703", `column "${a.column}" of relation "${s.table.name}" does not exist`)
			}
			if (c.generation.kind !== "none" && c.generation.kind !== "uuidv7") {
				refuse("428C9", `column "${a.column}" can only be updated to DEFAULT`)
			}
		}
		const from = this.#fromRows(s.from, ctes)
		const where = s.where
		const updated: Array<readonly [Map<string, Cell>, ReadonlyArray<readonly [string, Cell]>]> = []
		for (const row of t.rows) {
			const target = bound(s.alias, this.#tuple(t.columns, row))
			const matches = Arr.filter(from, (r) => {
				const both = joined(target, r)
				return where === undefined || truthOf(evaluate(where, this.#scope(both))) === true
			})
			const [match, ...more] = matches
			if (match === undefined) {
				continue
			}
			if (more.length > 0) {
				throw new Error(
					`the UPDATE of ${printObjectName(s.table)} joins one row to ${matches.length} rows of its FROM, and PostgreSQL updates it from the one it chooses`
				)
			}
			const scope = this.#scope(joined(target, match))
			updated.push([
				row,
				Arr.map(s.set, (a) => {
					const c = columns.get(a.column)
					if (c === undefined) {
						throw new Error(`the column ${a.column} was checked`)
					}
					return [a.column, this.#stored(evaluate(a.value, scope), c, s.table)] as const
				})
			])
		}
		for (const [row, cells] of updated) {
			for (const [name, cell] of cells) {
				row.set(name, cell)
			}
		}
		for (const [name, c] of this.#constraintsOf(s.table.name)) {
			if (c.kind !== "check") {
				continue
			}
			for (const [row] of updated) {
				const bound = this.#checkColumns(t, row)
				if (bound !== undefined && this.#admits(c.predicate, undefined, bound) === false) {
					refuse(
						"23514",
						`new row for relation "${s.table.name}" violates check constraint "${name}"`
					)
				}
			}
		}
	}

	/** Every stored row of `table` meets its CHECK `name`, or it fails as PostgreSQL's validateCheckConstraint does (23514). */
	#validateCheck(table: string, name: string, predicate: Expr): void {
		const t = this.#tables.get(table)
		if (t === undefined) {
			return
		}
		for (const row of t.rows) {
			let columns: Map<string, SqlValue>
			try {
				columns = new Map(
					Arr.map(
						t.columns,
						(c) => [`.${c.name}`, this.#cellValue(row.get(c.name), c.type)] as const
					)
				)
			} catch (error) {
				if (error instanceof Unevaluable) {
					continue
				}
				throw error
			}
			if (this.#admits(predicate, undefined, columns) === false) {
				refuse("23514", `check constraint ${name} of relation ${table} is violated by some row`)
			}
		}
	}

	/** What calls the function `name`, as pg_depend records it: a domain's or a table's CHECK, a generated column, a
	 * view of the schema or a world's, a policy, another function's body, or a trigger. */
	#callersOf(name: string): ReadonlyArray<string> {
		const domains = Arr.flatMap([...this.#domains], ([domain, d]) =>
			Arr.flatMap([...d.constraints], ([c, check]) =>
				check.calls.includes(name) ? [`the constraint ${c} of the domain ${domain}`] : []
			)
		)
		const checks = Arr.flatMap([...this.#constraints], ([table, of]) =>
			Arr.flatMap([...of], ([c, x]) =>
				x.kind === "check" && x.calls.includes(name) ? [`the constraint ${c} of ${table}`] : []
			)
		)
		const generated = Arr.flatMap([...this.#tables], ([table, t]) =>
			Arr.flatMap(t.columns, (c) =>
				(c.generation.kind === "stored" || c.generation.kind === "partial") &&
				c.generation.calls.includes(name)
					? [`the generated column ${table}.${c.name}`]
					: []
			)
		)
		const views = Arr.flatMap([...this.#views], ([view, v]) =>
			v.calls.includes(name) ? [`the materialized view ${view}`] : []
		)
		const dependents = Arr.flatMap([...this.#dependents], ([key, v]) =>
			v.calls.includes(name) ? [`the ${key}`] : []
		)
		const functions = Arr.flatMap([...this.#functions], ([other, f]) =>
			other !== name && f.calls.includes(name) ? [`the function ${other}`] : []
		)
		const triggers = Arr.flatMap([...this.#triggers], ([table, of]) =>
			Arr.flatMap([...of], ([trigger, t]) =>
				t.function === name ? [`the trigger ${trigger} of ${table}`] : []
			)
		)
		return [...domains, ...checks, ...generated, ...views, ...dependents, ...functions, ...triggers]
	}

	/** A function of the schema created, by its name: a second of one name and no argument is refused (42723). */
	#addFunction(name: ObjectName, f: Function): void {
		if (!this.#ours(name)) {
			return
		}
		if (this.#functions.has(name.name)) {
			refuse(
				"42723",
				`the function ${printObjectName(name)}() already exists with the same argument types`
			)
		}
		this.#callable(f.calls, `the function ${printObjectName(name)}`)
		this.#functions.set(name.name, f)
	}

	#trigger(
		table: ObjectName,
		name: string,
		fn: ObjectName,
		columns: ReadonlyArray<string>,
		types: ReadonlyArray<TypeRef>
	): void {
		const t = this.#table(table)
		if (this.#ours(fn) && !this.#functions.has(fn.name)) {
			refuse("42883", `the function ${printObjectName(fn)} does not exist`)
		}
		for (const c of columns) {
			this.#column(t, table, c)
		}
		const of = this.#triggersOf(table.name)
		if (of.has(name)) {
			refuse("42710", `the trigger ${name} of ${printObjectName(table)} already exists`)
		}
		of.set(name, { function: fn.name, columns, types })
	}

	/** The index becomes the constraint's, under its name. */
	#alterTable(s: Extract<SqlStatement, { readonly kind: "alterTable" }>): void {
		for (const a of s.actions) {
			switch (a.kind) {
				case "addColumnPlaceholder":
					throw new Error(
						`the placeholder of ${a.column.name} is the reviewer's: the model reads it as its drafted action`
					)
				case "addColumnDefault": {
					this.#typeExists(a.column.type)
					if (a.column.generated !== undefined) {
						refuse(
							"42601",
							`both default and generation expression specified for column "${a.column.name}" of table "${s.table.name}"`
						)
					}
					const column = columnOf(a.column, this.#schema)
					this.#addColumn(s.table, column, () =>
						this.#stored(evaluate(a.default, this.#scope(new Map())), column, s.table)
					)
					break
				}
				case "addColumn": {
					const generated = a.column.generated
					this.#typeExists(a.column.type)
					const column = columnOf(a.column, this.#schema)
					if (column.generation.kind === "stored" || column.generation.kind === "partial") {
						this.#callable(column.generation.calls, `the generated column ${a.column.name}`)
					}
					this.#addColumn(s.table, column, () =>
						generated === undefined ? undefined : { kind: "generated" }
					)
					break
				}
				case "dropColumn":
					this.#dropColumn(s.table, a.column)
					break
				case "dropDefault": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "defaulted")
					const c = t.columns[at]
					if (c?.generation.kind === "uuidv7") {
						t.columns[at] = { ...c, generation: { kind: "none" } }
					}
					break
				}
				case "setUuidv7Default": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "defaulted")
					const c = t.columns[at]
					if (c?.generation.kind === "identity") {
						refuse(
							"42601",
							`column "${a.column}" of relation "${s.table.name}" is an identity column`
						)
					} else if (c?.generation.kind === "stored" || c?.generation.kind === "partial") {
						refuse(
							"42601",
							`column "${a.column}" of relation "${s.table.name}" is a generated column`
						)
					} else if (c !== undefined && !this.#ofBase(c.type, "uuid")) {
						refuse(
							"42804",
							`column "${a.column}" is of type ${printType(c.type)} but default expression is of type uuid`
						)
					} else if (c !== undefined) {
						t.columns[at] = { ...c, generation: { kind: "uuidv7" } }
					}
					break
				}
				case "addIdentity": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "identity")
					const c = t.columns[at]
					if (c?.generation.kind !== "none") {
						refuse(
							"42611",
							`the column ${a.column} of ${printObjectName(s.table)} is already generated`
						)
					} else {
						this.#claimSequence(a.sequence.name, s.table.name, a.column)
						t.columns[at] = { ...c, generation: { kind: "identity", sequence: a.sequence.name } }
					}
					break
				}
				case "dropIdentity": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "identity")
					const c = t.columns[at]
					if (c?.generation.kind !== "identity") {
						refuse(
							"55000",
							`the column ${a.column} of ${printObjectName(s.table)} is not an identity column`
						)
					} else {
						this.#sequences.delete(c.generation.sequence)
						t.columns[at] = { ...c, generation: { kind: "none" } }
					}
					break
				}
				case "alterColumnType": {
					const using = a.using
					if (using.kind === "placeholder") {
						throw new Error(
							`the placeholder converting ${a.column} is the reviewer's: the model reads it as its drafted action`
						)
					}
					this.#typeExists(a.type)
					const widened = this.#bitsWidening(a.column, using.expr, a.type)
					if (widened !== undefined) {
						this.#widenBits(s.table, a.column, a.type, widened)
					} else {
						this.#retype(
							s.table,
							a.column,
							a.type,
							this.#byCast(s.table, a.column, using.expr, a.type)
								? { kind: "kept" }
								: unknownExpression
						)
					}
					break
				}
				case "addConstraint":
					this.#constraint(s.table, a.constraint, !a.notValid)
					break
				case "addConstraintUsingIndex": {
					this.#table(s.table)
					const x = this.#indexes.get(a.index)
					if (x === undefined) {
						refuse("42704", `the index ${a.index} does not exist`)
					}
					if (x.on !== s.table.name || !x.bindable || x.owner.kind !== "free") {
						refuse(
							"55000",
							`the index ${a.index} cannot implement the key ${a.name} of ${printObjectName(s.table)}`
						)
					}
					const of = this.#constraintsOf(s.table.name)
					if (of.has(a.name)) {
						refuse(
							"42710",
							`the constraint ${a.name} of ${printObjectName(s.table)} already exists`
						)
					}
					if (a.constraint === "PRIMARY KEY") {
						this.#secondPrimaryKey(s.table, of)
					}
					if (a.index !== a.name) {
						this.#renameIndex(a.index, a.name)
					}
					const named = this.#indexes.get(a.name)
					if (named !== undefined) {
						this.#indexes.set(a.name, { ...named, owner: { kind: "constraint", name: a.name } })
					}
					of.set(a.name, {
						kind: a.constraint === "PRIMARY KEY" ? "primaryKey" : "unique",
						columns: x.keys,
						index: a.name,
						valid: true
					})
					break
				}
				case "validateConstraint": {
					this.#table(s.table)
					const of = this.#constraintsOf(s.table.name)
					const c = of.get(a.name)
					if (c === undefined) {
						refuse(
							"42704",
							`the constraint ${a.name} of ${printObjectName(s.table)} does not exist`
						)
					}
					if (c.kind === "check" && !c.valid) {
						this.#validateCheck(s.table.name, a.name, c.predicate)
					}
					of.set(a.name, { ...c, valid: true })
					break
				}
				case "setExpression": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "re-expressed")
					const c = t.columns[at]
					if (c?.generation.kind !== "stored") {
						refuse(
							"42611",
							`the column ${a.column} of ${printObjectName(s.table)} is not a stored generated column`
						)
					}
					const calls = callsOf([a.expr], this.#schema)
					this.#callable(calls, `the generated column ${a.column}`)
					t.columns[at] = { ...c, generation: { kind: "stored", calls } }
					break
				}
				case "dropConstraint":
					this.#table(s.table)
					this.#dropConstraint(s.table.name, a.name, `dropping the constraint ${a.name}`)
					break
				case "enableRowSecurity":
				case "disableRowSecurity":
					this.#table(s.table)
					break
			}
		}
	}

	#rename(s: Extract<SqlStatement, { readonly kind: "rename"; readonly name: ObjectName }>): void {
		switch (s.object) {
			case "TABLE": {
				const t = this.#table(s.name)
				this.#claimRelation(s.to, `the table ${printObjectName(s.name)}`)
				this.#tables.delete(s.name.name)
				this.#tables.set(s.to, t)
				const constraints = this.#constraints.get(s.name.name)
				this.#constraints.delete(s.name.name)
				if (constraints !== undefined) {
					this.#constraints.set(s.to, constraints)
				}
				const triggers = this.#triggers.get(s.name.name)
				this.#triggers.delete(s.name.name)
				if (triggers !== undefined) {
					this.#triggers.set(s.to, triggers)
				}
				this.#renameRelationIn(s.name.name, s.to)
				return
			}
			case "MATERIALIZED VIEW": {
				const v = this.#views.get(s.name.name)
				if (v === undefined) {
					refuse("42P01", `the view ${printObjectName(s.name)} does not exist`)
				}
				this.#claimRelation(s.to, `the view ${printObjectName(s.name)}`)
				this.#views.delete(s.name.name)
				this.#views.set(s.to, v)
				this.#renameRelationIn(s.name.name, s.to)
				return
			}
			case "DOMAIN":
				this.#renameType(s.name, s.to)
				return
			case "INDEX":
				this.#renameIndex(s.name.name, s.to)
				return
			case "SEQUENCE": {
				const q = this.#sequences.get(s.name.name)
				if (q === undefined) {
					refuse("42P01", `the sequence ${printObjectName(s.name)} does not exist`)
				}
				if (this.#relationTaken(s.to)) {
					refuse(
						"42P07",
						`the relation ${s.to} already exists, so the sequence ${printObjectName(s.name)} cannot take it`
					)
				}
				this.#sequences.delete(s.name.name)
				this.#sequences.set(s.to, q)
				if (q.kind === "identity") {
					const t = this.#tables.get(q.table)
					if (t !== undefined) {
						t.columns = Arr.map(t.columns, (c) =>
							c.name === q.column ? { ...c, generation: { kind: "identity", sequence: s.to } } : c
						)
					}
				}
				return
			}
			case "STATISTICS": {
				const x = this.#statistics.get(s.name.name)
				if (x === undefined) {
					refuse("42704", `the statistics object ${printObjectName(s.name)} does not exist`)
				}
				if (this.#statistics.has(s.to)) {
					refuse("42710", `the statistics object ${s.to} already exists`)
				}
				this.#statistics.delete(s.name.name)
				this.#statistics.set(s.to, x)
				return
			}
		}
	}

	#drop(s: Extract<SqlStatement, { readonly kind: "drop" }>): void {
		if (s.object === "ROLE") {
			const held = this.#databasePrivileges.get(s.name)
			if (held !== undefined) {
				refuse(
					"2BP01",
					`the role ${s.name} is dropped while it holds ${Arr.join([...held], ", ")} on the database`
				)
			}
			return
		}
		if (s.object === "SCHEMA") {
			for (const key of this.#dependents.keys()) {
				if (Str.startsWith(`view ${s.name}.`)(key)) {
					refuse("2BP01", `the schema ${s.name} is dropped while it holds the ${key}`)
				}
			}
			return
		}
		if (s.object === "VIEW") {
			const key = `view ${s.name.schema}.${s.name.name}`
			if (!this.#dependents.delete(key) && !s.ifExists) {
				refuse("42P01", `the dropped view ${printObjectName(s.name)} does not exist`)
			}
			return
		}
		if (!this.#ours(s.name)) {
			return
		}
		const name = s.name.name
		switch (s.object) {
			case "TABLE": {
				if (!this.#tables.has(name)) {
					if (!s.ifExists) {
						refuse("42P01", `the dropped table ${printObjectName(s.name)} does not exist`)
					}
					return
				}
				for (const [source, of] of this.#constraints) {
					for (const [constraint, c] of of) {
						if (source !== name && c.kind === "foreignKey" && c.references === name) {
							refuse(
								"2BP01",
								`the table ${name} is dropped while the foreign key ${source}.${constraint} references it`
							)
						}
					}
				}
				this.#readBy(name, `the table ${name}`)
				this.#tables.delete(name)
				this.#constraints.delete(name)
				this.#triggers.delete(name)
				for (const key of Arr.fromIterable(this.#dependents.keys())) {
					if (Str.startsWith(`policy ${name}.`)(key)) {
						this.#dependents.delete(key)
					}
				}
				this.#dropOwned(name)
				return
			}
			case "MATERIALIZED VIEW":
				if (!this.#views.has(name)) {
					if (!s.ifExists) {
						refuse("42P01", `the dropped view ${printObjectName(s.name)} does not exist`)
					}
					return
				}
				this.#readBy(name, `the view ${name}`)
				this.#views.delete(name)
				this.#dropOwned(name)
				return
			case "DOMAIN":
				this.#dropType(s.name, s.ifExists)
				return
			case "SEQUENCE": {
				const q = this.#sequences.get(name)
				if (q === undefined) {
					if (!s.ifExists) {
						refuse("42P01", `the dropped sequence ${printObjectName(s.name)} does not exist`)
					}
					return
				}
				if (q.kind === "identity") {
					refuse(
						"2BP01",
						`the sequence ${name} is dropped while the column ${q.table}.${q.column} owns it`
					)
				}
				this.#sequences.delete(name)
				return
			}
		}
	}

	/** A relation a view or a world's view reads stops its drop; a policy goes with its own table. */
	#readBy(relation: string, what: string): void {
		for (const [view, v] of this.#views) {
			if (view !== relation && v.reads.has(relation)) {
				refuse("2BP01", `${what} is dropped while the materialized view ${view} reads it`)
			}
		}
		for (const [key, v] of this.#dependents) {
			if (Str.startsWith("view ")(key) && v.reads.has(relation)) {
				refuse("2BP01", `${what} is dropped while the ${key} reads it`)
			}
		}
	}

	/** What goes with a dropped relation: its indexes, statistics and identity sequences. */
	#dropOwned(relation: string): void {
		for (const [name, x] of Arr.fromIterable(this.#indexes)) {
			if (x.on === relation) {
				this.#indexes.delete(name)
			}
		}
		for (const [name, s] of Arr.fromIterable(this.#statistics)) {
			if (s.table === relation) {
				this.#statistics.delete(name)
			}
		}
		for (const [name, q] of Arr.fromIterable(this.#sequences)) {
			if (q.kind === "identity" && q.table === relation) {
				this.#sequences.delete(name)
			}
		}
	}

	/**
	 * A GRANT or REVOKE on the current database, which always exists: each privilege it names, ALL every one a database
	 * has, added to or taken from each role it names. PUBLIC's is the database owner's, which the model does not keep.
	 */
	#onDatabase(s: Extract<SqlStatement, { readonly kind: "grant" | "revoke" }>): void {
		const privileges = Arr.flatMap(s.privileges, (p): ReadonlyArray<string> =>
			p === "ALL" ? databasePrivilegeTypes : [p]
		)
		const roles = Arr.flatMap(s.kind === "grant" ? s.to : s.from, (g) =>
			g.kind === "role" ? [g.name] : []
		)
		for (const role of roles) {
			const held = new Set(this.#databasePrivileges.get(role))
			for (const p of privileges) {
				if (s.kind === "grant") {
					held.add(p)
				} else {
					held.delete(p)
				}
			}
			if (held.size === 0) {
				this.#databasePrivileges.delete(role)
			} else {
				this.#databasePrivileges.set(role, held)
			}
		}
	}

	/** What a GRANT or REVOKE names must exist, as PostgreSQL requires of it; one on the current database changes its
	 * privileges (`#onDatabase`). */
	#privilegesOn(s: Extract<SqlStatement, { readonly kind: "grant" | "revoke" }>): void {
		const on = s.on
		switch (on.kind) {
			case "TABLE":
				for (const n of on.names) {
					this.#relation(n)
				}
				return
			case "SEQUENCE":
				for (const n of on.names) {
					if (this.#ours(n) && !this.#sequences.has(n.name)) {
						refuse("42P01", `the sequence ${printObjectName(n)} does not exist`)
					}
				}
				return
			case "DOMAIN":
				for (const n of on.names) {
					this.#typeExists(namedType(testTypeSchema(n.schema), n.name, []))
				}
				return
			case "FUNCTION":
				for (const n of on.names) {
					if (this.#ours(n) && !this.#functions.has(n.name)) {
						refuse("42883", `the function ${printObjectName(n)} does not exist`)
					}
				}
				return
			case "SCHEMA":
				return
			case "DATABASE":
				this.#onDatabase(s)
				return
		}
	}

	/** A key's or an exclusion's index is renamed with it.
	 *
	 * Every row holding the old label holds the new one.
	 *
	 * A world's view, in its own schema: it pins what it reads of this one.
	 *
	 * No effect on the catalog the model keeps, nor on the rows. */
	statement(s: SqlStatement): void {
		switch (s.kind) {
			case "createTable": {
				if (!this.#ours(s.table)) {
					return
				}
				this.#claimRelation(s.table.name, `the table ${printObjectName(s.table)}`)
				const columns = Arr.map(s.columns, (c) => columnOf(c, this.#schema))
				for (const [i, c] of columns.entries()) {
					if (
						!Option.contains(
							Arr.findFirstIndex(columns, (x) => x.name === c.name),
							i
						)
					) {
						refuse("42701", `the column ${c.name} of ${printObjectName(s.table)} is declared twice`)
					}
				}
				for (const c of s.columns) {
					this.#typeExists(c.type)
				}
				for (const c of columns) {
					if (c.generation.kind === "stored" || c.generation.kind === "partial") {
						this.#callable(c.generation.calls, `the generated column ${s.table.name}.${c.name}`)
					}
				}
				this.#tables.set(s.table.name, { columns, rows: [] })
				for (const c of columns) {
					if (c.generation.kind === "identity") {
						this.#claimSequence(c.generation.sequence, s.table.name, c.name)
					}
				}
				for (const c of tableConstraints(s)) {
					this.#constraint(s.table, c, true)
				}
				return
			}
			case "alterTable":
				if (this.#ours(s.table)) {
					this.#alterTable(s)
				}
				return
			case "rename":
				if (s.object === "ROLE") {
					const held = this.#databasePrivileges.get(s.name)
					if (held !== undefined) {
						this.#databasePrivileges.delete(s.name)
						this.#databasePrivileges.set(s.to, held)
					}
				} else if (s.object !== "SCHEMA" && this.#ours(s.name)) {
					this.#rename(s)
				}
				return
			case "renameColumn": {
				if (!this.#ours(s.table)) {
					return
				}
				const t = this.#table(s.table)
				const at = this.#columnAt(t, s.table, s.from, "renamed")
				if (Arr.some(t.columns, (c) => c.name === s.to)) {
					refuse("42701", `the column ${s.to} of ${printObjectName(s.table)} already exists`)
				}
				const c = t.columns[at]
				if (c !== undefined) {
					t.columns[at] = { ...c, name: s.to }
				}
				for (const row of t.rows) {
					const cell = row.get(s.from)
					row.delete(s.from)
					if (cell !== undefined) {
						row.set(s.to, cell)
					}
				}
				this.#renameColumnIn(s.table.name, s.from, s.to)
				return
			}
			case "renameConstraint": {
				if (!this.#ours(s.table)) {
					return
				}
				this.#table(s.table)
				const of = this.#constraintsOf(s.table.name)
				const c = of.get(s.from)
				if (c === undefined) {
					refuse("42704", `the constraint ${s.from} of ${printObjectName(s.table)} does not exist`)
				}
				if (of.has(s.to)) {
					refuse("42710", `the constraint ${s.to} of ${printObjectName(s.table)} already exists`)
				}
				if (c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude") {
					this.#renameIndex(c.index, s.to)
				} else {
					of.delete(s.from)
					of.set(s.to, c)
				}
				return
			}
			case "lockTable":
				for (const t of s.tables) {
					this.#relation(t)
				}
				return
			case "createGuardTrigger":
				if (this.#ours(s.table)) {
					this.#trigger(s.table, s.name, s.function, [], [])
				}
				return
			case "createConstraintTrigger":
				if (this.#ours(s.table)) {
					this.#trigger(
						s.table,
						s.name,
						s.function,
						Arr.flatMap(s.events, (e) => (e.kind === "update" ? e.columns : [])),
						[]
					)
				}
				return
			case "dropTrigger": {
				if (!this.#ours(s.table)) {
					return
				}
				this.#table(s.table)
				const of = this.#triggersOf(s.table.name)
				if (!of.delete(s.name) && !s.ifExists) {
					refuse("42704", `the trigger ${s.name} of ${printObjectName(s.table)} does not exist`)
				}
				return
			}
			case "createIndex": {
				if (!this.#ours(s.table)) {
					return
				}
				const columns = this.#columnsOfRelation(s.table.name)
				const keys = Arr.flatMap(s.keys, (k) => (k.key.kind === "column" ? [k.key.column] : []))
				const reads = [
					...keys,
					...s.include,
					...Arr.flatMap(s.keys, (k) => (k.key.kind === "expr" ? columnsOf(k.key.expr) : [])),
					...(s.where === undefined ? [] : columnsOf(s.where))
				]
				for (const c of reads) {
					if (!columns.includes(c)) {
						refuse("42703", `the column ${c} of ${printObjectName(s.table)} does not exist`)
					}
				}
				this.#addIndex(s.name, {
					on: s.table.name,
					method: s.method,
					unique: s.unique,
					keys,
					reads,
					bindable: s.unique && s.where === undefined && keys.length === s.keys.length,
					owner: { kind: "free" }
				})
				return
			}
			case "createMaterializedView":
				if (!this.#ours(s.name)) {
					return
				}
				this.#claimRelation(s.name.name, `the view ${printObjectName(s.name)}`)
				this.#callable(queryCalls(s.query, this.#schema), `the view ${printObjectName(s.name)}`)
				this.#views.set(s.name.name, {
					columns: s.columns,
					reads: readsOf(s.query, this.#schema, (r) => this.#columnsOfRelation(r)),
					calls: queryCalls(s.query, this.#schema)
				})
				return
			case "drop":
				this.#drop(s)
				return
			case "grant":
			case "revoke":
				this.#privilegesOn(s)
				return
			case "createStatistics": {
				if (!this.#ours(s.name)) {
					return
				}
				const t = this.#table(s.table)
				for (const c of s.columns) {
					this.#column(t, s.table, c)
				}
				if (this.#statistics.has(s.name.name)) {
					refuse("42710", `the statistics object ${s.name.name} already exists`)
				}
				this.#statistics.set(s.name.name, { table: s.table.name, columns: s.columns })
				return
			}
			case "dropIndex": {
				if (!this.#ours(s.name)) {
					return
				}
				const x = this.#indexes.get(s.name.name)
				if (x === undefined) {
					if (!s.ifExists) {
						refuse("42704", `the dropped index ${printObjectName(s.name)} does not exist`)
					}
					return
				}
				if (x.owner.kind === "constraint") {
					refuse(
						"2BP01",
						`the index ${s.name.name} is dropped while the constraint ${x.owner.name} requires it`
					)
				}
				this.#dropIndex(s.name.name, `dropping the index ${s.name.name}`)
				return
			}
			case "createDomain":
				if (!this.#ours(s.name)) {
					return
				}
				if (this.#typeTaken(s.name.name)) {
					refuse("42710", `the type ${printObjectName(s.name)} already exists`)
				}
				this.#typeExists(s.base)
				this.#domains.set(s.name.name, {
					base: s.base,
					constraints: new Map(
						Arr.map(s.constraints, (c) => {
							const calls = callsOf([c.predicate], this.#schema)
							this.#callable(calls, `the constraint ${c.name} of the domain ${s.name.name}`)
							return [c.name, { predicate: c.predicate, calls, valid: true }] as const
						})
					)
				})
				return
			case "alterDomain": {
				if (!this.#ours(s.name)) {
					return
				}
				const d = this.#domains.get(s.name.name)
				if (d === undefined) {
					refuse("42704", `the domain ${printObjectName(s.name)} does not exist`)
				}
				const constraints = new Map(d.constraints)
				const a = s.action
				switch (a.kind) {
					case "addConstraint": {
						if (constraints.has(a.constraint.name)) {
							refuse(
								"42710",
								`the constraint ${a.constraint.name} of the domain ${s.name.name} already exists`
							)
						}
						const calls = callsOf([a.constraint.predicate], this.#schema)
						this.#callable(
							calls,
							`the constraint ${a.constraint.name} of the domain ${s.name.name}`
						)
						const check = { predicate: a.constraint.predicate, calls, valid: !a.notValid }
						if (check.valid) {
							this.#validateDomain(s.name.name, a.constraint.name, check)
						}
						constraints.set(a.constraint.name, check)
						break
					}
					case "validateConstraint": {
						const check = constraints.get(a.name)
						if (check === undefined) {
							refuse(
								"42704",
								`the constraint ${a.name} of the domain ${s.name.name} does not exist`
							)
						}
						if (!check.valid) {
							this.#validateDomain(s.name.name, a.name, check)
						}
						constraints.set(a.name, { ...check, valid: true })
						break
					}
					case "dropConstraint":
						if (!constraints.delete(a.name)) {
							refuse(
								"42704",
								`the constraint ${a.name} of the domain ${s.name.name} does not exist`
							)
						}
						break
				}
				this.#domains.set(s.name.name, { ...d, constraints })
				return
			}
			case "createFunction":
				this.#addFunction(s.name, { body: { kind: "opaque" }, calls: [] })
				return
			case "createConstant":
				this.#addFunction(s.name, {
					body: { kind: "constant", expr: s.body },
					calls: callsOf([s.body], this.#schema)
				})
				return
			case "packConstant":
				this.#addFunction(s.function, { body: { kind: "packed", bits: packedBits(s) }, calls: [] })
				return
			case "dropFunction": {
				if (!this.#ours(s.name)) {
					return
				}
				if (!this.#functions.has(s.name.name)) {
					if (!s.ifExists) {
						refuse("42883", `the dropped function ${printObjectName(s.name)} does not exist`)
					}
					return
				}
				const [caller] = this.#callersOf(s.name.name)
				if (caller !== undefined) {
					refuse("2BP01", `cannot drop the function ${s.name.name} because ${caller} depends on it`)
				}
				this.#functions.delete(s.name.name)
				return
			}
			case "refresh":
				this.#relation(s.view)
				return
			case "createView": {
				const key = `view ${s.name.schema}.${s.name.name}`
				if (this.#dependents.has(key)) {
					refuse("42P07", `the ${key} already exists`)
				}
				const calls = queryCalls(s.query, this.#schema)
				this.#callable(calls, `the ${key}`)
				this.#dependents.set(key, {
					columns: s.columns,
					reads: readsOf(s.query, this.#schema, (r) => this.#columnsOfRelation(r)),
					calls
				})
				return
			}
			case "createPolicy": {
				if (!this.#ours(s.table)) {
					return
				}
				const t = this.#table(s.table)
				const key = `policy ${s.table.name}.${s.name}`
				if (this.#dependents.has(key)) {
					refuse("42710", `the ${key} already exists`)
				}
				const named = columnsOf(s.filter)
				this.#dependents.set(key, {
					columns: [],
					calls: callsOf([s.filter], this.#schema),
					reads: new Map([
						[
							s.table.name,
							new Set(
								Arr.filter(
									Arr.map(t.columns, (c) => c.name),
									(c) => named.includes(c)
								)
							)
						]
					])
				})
				return
			}
			case "dropPolicy":
				if (!this.#ours(s.table)) {
					return
				}
				if (!this.#dependents.delete(`policy ${s.table.name}.${s.name}`)) {
					refuse(
						"42704",
						`the dropped policy ${s.name} on ${printObjectName(s.table)} does not exist`
					)
				}
				return
			case "grantColumns": {
				if (!this.#ours(s.table)) {
					return
				}
				const t = this.#table(s.table)
				for (const c of s.columns) {
					this.#column(t, s.table, c)
				}
				return
			}
			case "createSchema":
			case "alterDatabaseDefault":
			case "createRole":
			case "alterRole":
			case "grantRole":
			case "revokeRole":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "select":
			case "analyze":
			case "comment":
				return
			case "update":
				if (this.#ours(s.table)) {
					this.#update(s)
				}
				return
			case "setConstraintsImmediate":
				return
			case "insert":
			case "delete":
			case "merge":
			case "createCarrier":
			case "begin":
			case "commit":
			case "rollback":
				throw new Error(`the model of a migration's DDL has no ${s.kind} statement`)
		}
	}

	/** Runs one action, then requires what PostgreSQL requires at the end of every statement. */
	action(a: Action, placeholder: PlaceholderValue): void {
		this.#perform(a, placeholder)
		this.#foreignKeysComparable()
	}

	/** A table's alteration runs its subcommands in its order, PostgreSQL's pass order: a placeholder column ADD COLUMN
	 * with the reviewer's value as its default, then DROP DEFAULT; a placeholder conversion by the reviewer's value. */
	#perform(a: Action, placeholder: PlaceholderValue): void {
		switch (a.kind) {
			case "statement":
				this.statement(a.statement)
				return
			case "alteration":
				for (const sub of a.actions) {
					if (sub.kind === "placeholderColumn") {
						this.#typeExists(sub.column.type)
						this.#addColumn(a.table, columnOf(sub.column, this.#schema), () => ({
							kind: "value",
							value: placeholder({ ...sub, table: a.table })
						}))
					} else if (sub.kind === "placeholderRetype") {
						this.#typeExists(sub.column.type)
						this.#retype(a.table, sub.column.name, sub.column.type, {
							kind: "given",
							value: () => ({ kind: "value", value: placeholder({ ...sub, table: a.table }) })
						})
					} else {
						this.statement({ kind: "alterTable", table: a.table, actions: [sub] })
					}
				}
				return
			case "analyze":
				this.#relation(a.table)
				return
			case "violation":
				for (const relation of readsOf(a.query, this.#schema, (r) =>
					this.#columnsOfRelation(r)
				).keys()) {
					this.#relation({ schema: this.#schema, name: relation })
				}
				return
			case "dropStatistics":
				if (!this.#ours(a.name)) {
					return
				}
				if (!this.#statistics.delete(a.name.name)) {
					refuse("42704", `the statistics object ${printObjectName(a.name)} does not exist`)
				}
				return
		}
	}

	state(): State {
		return {
			tables: new Map(
				Arr.map([...this.#tables], ([name, t]): readonly [string, Table] => [
					name,
					{ columns: [...t.columns], rows: Arr.map(t.rows, (r) => new Map(r)) }
				])
			),
			domains: new Map(this.#domains),
			constraints: new Map(Arr.map([...this.#constraints], ([table, of]) => [table, new Map(of)])),
			indexes: new Map(this.#indexes),
			sequences: new Map(this.#sequences),
			statistics: new Map(this.#statistics),
			triggers: new Map(Arr.map([...this.#triggers], ([table, of]) => [table, new Map(of)])),
			views: new Map(this.#views),
			dependents: new Map(this.#dependents),
			functions: new Map(this.#functions),
			databasePrivileges: new Map(this.#databasePrivileges),
			created: this.#created
		}
	}
}

/** A file the model runs: its name, which says where a failure is, and its actions in order. A reviewed file is one. */
export interface ModelFile {
	readonly draft: { readonly name: string }
	readonly actions: ReadonlyArray<Action>
}

/** The state after a reviewed migration of `schema` runs on `state`, or where it fails. */
export const interpret = (
	schema: string,
	state: State,
	files: ReadonlyArray<ModelFile>,
	placeholder: PlaceholderValue
): Result.Result<State, InterpretFailure> => {
	const s = new Model(schema, state)
	for (const f of files) {
		for (const [k, a] of f.actions.entries()) {
			try {
				s.action(a, placeholder)
			} catch (error) {
				if (error instanceof Refused) {
					return Result.fail({
						file: f.draft.name,
						action: k + 1,
						refusal: error.refusal,
						reason: error.reason
					})
				}
				throw error
			}
		}
	}
	return Result.succeed(s.state())
}

/** The placeholder value of a migration with no placeholder: an installation's statements hold none. */
const noPlaceholder: PlaceholderValue = (p) => {
	throw new Error(`an installation's statements hold no placeholder, but a ${p.kind} is there`)
}

/** The state of `schema` installed from nothing by `statements` in order, as a fresh installation runs them, or where
 * they fail. */
export const installState = (
	schema: string,
	statements: ReadonlyArray<SqlStatement>
): Result.Result<State, InterpretFailure> =>
	interpret(
		schema,
		emptyState,
		[
			{
				draft: { name: "the installation" },
				actions: Arr.map(statements, (statement): Action => ({ kind: "statement", statement }))
			}
		],
		noPlaceholder
	)

/** The state with `rows` loaded into `table`: each row a value per column, as a loader inserts a fact. */
export const load = (
	state: State,
	table: string,
	rows: ReadonlyArray<ReadonlyMap<string, TypedLiteral>>
): State => {
	const t = state.tables.get(table)
	if (t === undefined) {
		throw new Error(`no table ${table} to load facts into`)
	}
	for (const row of rows) {
		for (const c of t.columns) {
			if (!row.has(c.name)) {
				throw new Error(`a fact of ${table} without a value for ${c.name}`)
			}
		}
	}
	const tables = new Map(state.tables)
	tables.set(table, {
		columns: t.columns,
		rows: [
			...t.rows,
			...Arr.map(
				rows,
				(row) =>
					new Map(
						Arr.map([...row], ([name, value]): readonly [string, Cell] => [
							name,
							{ kind: "value", value }
						])
					)
			)
		]
	})
	return { ...state, tables }
}

/** A column's type as it prints, for comparing columns across installations. */
const typeText = (column: Column): string => printType(column.type)

const list = (names: ReadonlyArray<string>): string => Arr.join(names, ", ")
const sortedList = (names: Iterable<string>): string =>
	Arr.join(Arr.sort([...names], Order.String), ", ")

const generationText = (g: Generation): string => {
	switch (g.kind) {
		case "none":
			return ""
		case "identity":
			return ` identity ${g.sequence}`
		case "uuidv7":
			return " default uuidv7()"
		case "stored":
			return " stored"
		case "partial":
			return " partial"
	}
}

const constraintText = (c: Constraint): string => {
	const valid = c.valid ? "" : " not valid"
	switch (c.kind) {
		case "primaryKey":
		case "unique":
		case "exclude":
			return `${c.kind} (${list(c.columns)})${valid}`
		case "foreignKey":
			return `foreignKey (${list(c.columns)}) references ${c.references} (${list(c.referenced)})${valid}`
		case "check":
			return `check over (${sortedList(new Set(c.columns))})${valid}`
	}
}

/** The catalog a state holds, as the facts admission would compare, one line each, sorted: every table's columns by
 * name with their types and what generates them; every constraint with its columns and
 * validity; every index with what it is over; every sequence with its owner; every statistics object, trigger, view,
 * domain with its base and constraints, and function. Column order, the rows, and
 * which index a foreign key bound are no facts: a fresh installation and a migrated one may differ in them, and
 * PostgreSQL's own description does not show them. */
export const catalogOf = (state: State): ReadonlyArray<string> =>
	Arr.sort(
		[
			...Arr.flatMap([...state.tables], ([table, t]) => [
				`table ${table}`,
				...Arr.map(
					t.columns,
					(c) => `column ${table}.${c.name} ${typeText(c)}${generationText(c.generation)}`
				)
			]),
			...Arr.flatMap([...state.constraints], ([table, of]) =>
				Arr.map([...of], ([name, c]) => `constraint ${table}.${name} ${constraintText(c)}`)
			),
			...Arr.map(
				[...state.indexes],
				([name, x]) =>
					`index ${name} on ${x.on} ${x.method}${x.unique ? " unique" : ""} (${list(x.keys)}) reading (${sortedList(new Set(x.reads))})${x.owner.kind === "constraint" ? ` of ${x.owner.name}` : ""}`
			),
			...Arr.map(
				[...state.sequences],
				([name, q]) =>
					`sequence ${name}${q.kind === "identity" ? ` of ${q.table}.${q.column}` : ""}`
			),
			...Arr.map(
				[...state.statistics],
				([name, s]) => `statistics ${name} on ${s.table} (${sortedList(s.columns)})`
			),
			...Arr.flatMap([...state.triggers], ([table, of]) =>
				Arr.map(
					[...of],
					([name, t]) =>
						`trigger ${table}.${name} executes ${t.function} over (${sortedList(t.columns)})`
				)
			),
			...Arr.map(
				[...state.views],
				([name, v]) =>
					`view ${name} (${list(v.columns)}) reading ${Arr.join(
						Arr.sort(
							Arr.map([...v.reads], ([r, cs]) => `${r} (${sortedList(cs)})`),
							Order.String
						),
						"; "
					)}`
			),
			...Arr.map(
				[...state.dependents],
				([key, v]) =>
					`${key} reading ${Arr.join(
						Arr.sort(
							Arr.map([...v.reads], ([r, cs]) => `${r} (${sortedList(cs)})`),
							Order.String
						),
						"; "
					)}`
			),
			...Arr.map(
				[...state.domains],
				([name, d]) =>
					`domain ${name} ${printType(d.base)} (${Arr.join(
						Arr.sort(
							Arr.map([...d.constraints], ([c, check]) => `${c}${check.valid ? "" : " not valid"}`),
							Order.String
						),
						", "
					)})`
			),
			...Arr.map([...state.functions.keys()], (name) => `function ${name}`)
		],
		Order.String
	)

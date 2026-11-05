import { Array as Arr, Data, Option, Order, Result, String as Str } from "effect"
import type { Action } from "#compiler/deploy/diff/plan.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type ColumnDef,
	type Expr,
	type FromSource,
	type ObjectName,
	type PackConstant,
	type Select,
	type SqlStatement,
	type TableConstraint,
	type TypeRef,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { namedType } from "#compiler/sql/build.ts"
import { printObjectName, printType } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr, transformSelect } from "#compiler/sql/transform.ts"
import { bitText } from "#test/support/closed/bit-text.ts"
import type { Placeholder } from "#test/support/migrate/review.ts"
import { testTypeSchema } from "#test/support/sql.ts"

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
 * - Constants and domains. A constant (CREATE FUNCTION … IMMUTABLE RETURN, or the pack's DO block) holds a value the
 *   model computes: a names constant's name[], a live-codes constant derived from it, a pack's bit string (the test
 *   oracle bitText). A domain's CHECK added without NOT VALID, or VALIDATEd, is evaluated over every stored value of
 *   the domain, as PostgreSQL validates it, and a value it does not admit is refused (23514) naming the table and the
 *   column; so a removed handle's code, or a set holding its bit, fails the VALIDATE of the re-pointed CHECK. A CHECK
 *   outside the fragment the model evaluates (a contract's predicate) is taken to hold, a limit of the model.
 *   Each cell remembers where its value came from: a loaded fact, a value a reviewer wrote at a placeholder, or a
 *   value the column generates.
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
 * and a kind whose effect the model does not know (DML, transaction control) is a defect of the case, thrown, never
 * skipped. It is a second implementation of what the migration does, small enough to read, against which every drafted
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
 * What generates a column's values: nothing, its identity sequence, its stored expression, or a partial projection's
 * stored CASE, which is NULL outside its selection.
 */
export type Generation =
	| { readonly kind: "none" }
	| { readonly kind: "identity"; readonly sequence: string }
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
	created: 0
}

/** Where a reviewed migration fails, as PostgreSQL would. */
export interface InterpretFailure {
	readonly file: string
	readonly action: number
	readonly reason: string
}

/** The value a reviewer writes at a placeholder. */
export type PlaceholderValue = (placeholder: Placeholder) => TypedLiteral

/** A table while it changes. */
interface Live {
	columns: Array<Column>
	rows: Array<Map<string, Cell>>
}

/** A statement the model refuses, as PostgreSQL would refuse it, with the reason. */
class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}

/** A function declaration, so that control flow knows a call never returns. */
function refuse(reason: string): never {
	throw new Refused({ reason })
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
		case "uuid":
			return unevaluable(`a ${type.name} literal`)
	}
}

/**
 * The bit string a pack builds: `radices`' product cells of `width` bits, each 0 but a row's, which holds 1 + its
 * payload code at its key's row-major index (Horner's rule over the key's codes in order), written by the test oracle
 * bitText.
 */
const packedBits = (s: PackConstant): string => {
	const entries = Arr.map(s.rows, (row) => ({
		index: Arr.reduce(
			Arr.zip(row.key, s.radices),
			0n,
			(index, [code, radix]) => index * BigInt(radix) + BigInt(code)
		),
		payload: row.payload
	}))
	const text = bitText(
		{
			cells: Arr.reduce(s.radices, 1n, (cells, radix) => cells * BigInt(radix)),
			width: s.width,
			entries: Arr.sort(
				entries,
				Order.mapInput(Order.BigInt, (e: { readonly index: bigint }) => e.index)
			)
		},
		Number.MAX_SAFE_INTEGER
	)
	if (!text.ok) {
		throw new Error(`the pack of ${printObjectName(s.function)} is too long for the host to write`)
	}
	return text.value
}

/** A bit string cast to bit(n): padded with zeros on the right, or truncated, as PostgreSQL's bit(n) cast does. */
const toLength = (bits: string, length: number): string =>
	bits.length >= length ? Str.slice(0, length)(bits) : bits + Str.repeat(length - bits.length)("0")

/** What the evaluator reads besides an expression: VALUE, the columns a FROM item binds, and the schema's constants. */
interface Scope {
	readonly value: SqlValue
	readonly columns: ReadonlyMap<string, SqlValue>
	readonly constant: (name: string) => SqlValue
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
		refuse(`cannot ${op === "&" ? "AND" : "OR"} bit strings of different sizes (22026)`)
	}
	return Arr.join(
		Arr.map(
			Arr.makeBy(a.length, (i) => i),
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
 * CHECK are written in: literals, casts, VALUE, + and -, = and <>, & and |, a subscript, a CASE, substring, a call of
 * the schema's constant, and the one subquery a live-codes constant derives from its names constant, string_agg over
 * generate_subscripts. Any other expression is Unevaluable.
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
				case "text":
					return valueOf(e.value.value, e.type)
				case "decimal":
				case "float":
				case "floatSpecial":
					return unevaluable(`a ${e.value.kind} literal`)
			}
		case "cast": {
			const v = evaluate(e.expr, scope)
			if (v === undefined) {
				return undefined
			}
			const t = e.type
			if (t.kind === "builtin" && !t.array) {
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
					return v
				}
			}
			return unevaluable(`a cast of ${v.kind} to ${printType(t)}`)
		}
		case "binary": {
			const left = evaluate(e.left, scope)
			const right = evaluate(e.right, scope)
			switch (e.op) {
				case "+":
				case "-": {
					const a = intOf(left, e.op)
					const b = intOf(right, e.op)
					return a === undefined || b === undefined
						? undefined
						: { kind: "int", value: e.op === "+" ? a + b : a - b }
				}
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
				case "*":
				case "-|-":
				case "/":
				case "<":
				case "<<":
				case "<=":
				case "<=>":
				case "<@":
				case ">":
				case ">=":
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
		case "subquery":
			return derivedFromNames(e.query, scope)
		case "and":
		case "array":
		case "between":
		case "collate":
		case "complement":
		case "excluded":
		case "exists":
		case "field":
		case "greatest":
		case "inList":
		case "inQuery":
		case "isTrue":
		case "least":
		case "mergeAction":
		case "negate":
		case "not":
		case "nullif":
		case "or":
		case "param":
		case "plSpecial":
		case "plVar":
		case "regclass":
		case "returning":
		case "row":
		case "user":
			return unevaluable(`an expression of kind ${e.kind}`)
	}
}

/**
 * A live-codes constant's subquery: one target, string_agg(flag, '' ORDER BY t.i) cast to bit varying, over the rows of
 * generate_subscripts(N(), 1) AS t(i), each flag evaluated with t.i bound to its row's subscript, in subscript order.
 */
const derivedFromNames = (query: Select, scope: Scope): SqlValue => {
	const core = query.body
	if (
		core.kind !== "core" ||
		core.from.length !== 1 ||
		core.where !== undefined ||
		core.targets.length !== 1
	) {
		return unevaluable("a subquery of another shape")
	}
	const [from] = core.from
	const [only] = core.targets
	const target = only.expr
	if (
		from?.kind !== "function" ||
		from.call.fn.kind !== "builtin" ||
		from.call.fn.name !== "generate_subscripts" ||
		from.columns.length !== 1 ||
		target.kind !== "cast"
	) {
		return unevaluable("a subquery of another shape")
	}
	const aggregate = target.expr
	const [arrayExpr] = from.call.args
	const [column] = from.columns
	if (
		aggregate.kind !== "call" ||
		aggregate.star ||
		aggregate.fn.kind !== "builtin" ||
		aggregate.fn.name !== "string_agg" ||
		arrayExpr === undefined ||
		column === undefined
	) {
		return unevaluable("an aggregate other than string_agg")
	}
	const array = evaluate(arrayExpr, scope)
	const [flag, separator] = aggregate.args
	if (array?.kind !== "names" || flag === undefined || separator === undefined) {
		return unevaluable("string_agg over no names")
	}
	const sep = evaluate(separator, scope)
	const parts = Arr.map(array.value, (_, i) => {
		const columns = new Map(scope.columns)
		columns.set(`${from.alias}.${column}`, { kind: "int", value: BigInt(i + 1) })
		const v = evaluate(flag, { ...scope, columns })
		return v?.kind === "text" ? v.value : unevaluable("a flag of no text")
	})
	const text = Arr.join(parts, sep?.kind === "text" ? sep.value : "")
	return evaluate(
		{
			...target,
			expr: { kind: "literal", value: { kind: "text", value: text }, type: target.type }
		},
		scope
	)
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
			refuse(`the relation ${name} already exists (42P07), so ${what} cannot take it`)
		}
		if (this.#typeTaken(name)) {
			refuse(`the type ${name} already exists (42710), so ${what} cannot take it`)
		}
	}

	#table(name: ObjectName): Live {
		const t = this.#tables.get(name.name)
		if (t === undefined) {
			return refuse(`the table ${printObjectName(name)} does not exist (42P01)`)
		}
		return t
	}

	#column(t: Live, table: ObjectName, column: string): Column {
		const c = Option.getOrUndefined(Arr.findFirst(t.columns, (x) => x.name === column))
		if (c === undefined) {
			return refuse(`the column ${column} of ${printObjectName(table)} does not exist (42703)`)
		}
		return c
	}

	/** The position of a column a statement names, which must be there. */
	#columnAt(t: Live, table: ObjectName, column: string, what: string): number {
		const at = Arr.findFirstIndex(t.columns, (c) => c.name === column)
		return Option.isSome(at)
			? at.value
			: refuse(`the ${what} column ${column} of ${printObjectName(table)} does not exist (42703)`)
	}

	/** The columns of a table or a view. */
	#columnsOfRelation(name: string): ReadonlyArray<string> {
		const t = this.#tables.get(name)
		if (t !== undefined) {
			return Arr.map(t.columns, (c) => c.name)
		}
		const v = this.#views.get(name)
		return v === undefined ? refuse(`the relation ${name} does not exist (42P01)`) : v.columns
	}

	/** A table or a view the statement names, which must be there. */
	#relation(name: ObjectName): void {
		if (this.#ours(name) && !this.#tables.has(name.name) && !this.#views.has(name.name)) {
			refuse(`the relation ${printObjectName(name)} does not exist (42P01)`)
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
			refuse(`multiple primary keys for table ${printObjectName(table)} are not allowed (42P16)`)
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
			refuse(`${by} drops the index ${name}, which the foreign key ${bound} depends on (2BP01)`)
		}
		this.#indexes.delete(name)
	}

	/** Drops a constraint of a table, with its index; a foreign key bound to that index stops the drop. */
	#dropConstraint(table: string, name: string, by: string): void {
		const of = this.#constraints.get(table)
		const c = of?.get(name)
		if (of === undefined || c === undefined) {
			refuse(`the constraint ${name} of ${table} does not exist (42704)`)
		}
		if (c.kind === "primaryKey" || c.kind === "unique" || c.kind === "exclude") {
			this.#dropIndex(c.index, by)
		}
		of.delete(name)
	}

	#addColumn(table: ObjectName, column: Column, value: () => Cell | undefined): void {
		const t = this.#table(table)
		if (Arr.some(t.columns, (c) => c.name === column.name)) {
			refuse(`the column ${column.name} of ${printObjectName(table)} already exists (42701)`)
		}
		const cell = t.rows.length === 0 ? undefined : value()
		if (t.rows.length > 0 && cell === undefined) {
			refuse(
				`the NOT NULL column ${column.name} is added to ${printObjectName(table)}, which holds rows, without a value (23502)`
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
				`the relation ${name} already exists (42P07), so the identity sequence of ${table}.${column} cannot take it`
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
				`the dropped column ${column} of ${printObjectName(table)} does not exist (42703)`
			)
		}
		const [pinned] = this.#pinning(table.name, column)
		if (pinned !== undefined) {
			refuse(
				`the column ${column} of ${printObjectName(table)} is dropped while ${pinned} depends on it (2BP01)`
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
			refuse(
				`the column ${column} of ${table} is converted twice in one migration, where a draft converts it once`
			)
		}
		this.#converted.add(key)
	}

	/** A column converted to `type`, each row's cell as `conversion` makes it. */
	#retype(table: ObjectName, column: string, type: TypeRef, conversion: Conversion): void {
		const t = this.#table(table)
		const at = this.#columnAt(t, table, column, "retyped")
		this.#convertOnce(table.name, column)
		const [pinned] = this.#pinning(table.name, column)
		if (pinned !== undefined) {
			refuse(
				`the type of ${printObjectName(table)}.${column} is changed while ${pinned} depends on it (0A000)`
			)
		}
		const cell = conversion.kind === "kept" || t.rows.length === 0 ? undefined : conversion.value()
		if (conversion.kind === "given" && t.rows.length > 0 && cell === undefined) {
			refuse(
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
							`the foreign key ${name} of ${source} cannot be implemented (42804): ${source}.${column} of type ${printType(from)} and ${c.references}.${referenced} of type ${printType(to)} do not compare`
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
				`there is no unique constraint matching the keys (${Arr.join(columns, ", ")}) of the referenced table ${table} (42830)`
			)
		}
		return first[0]
	}

	#addIndex(name: string, index: Omit<Index, "order">): void {
		if (this.#relationTaken(name)) {
			refuse(`the relation ${name} already exists (42P07), so an index cannot take it`)
		}
		this.#indexes.set(name, { ...index, order: this.#created++ })
	}

	#constraint(table: ObjectName, c: TableConstraint, valid: boolean): void {
		const t = this.#table(table)
		const of = this.#constraintsOf(table.name)
		if (of.has(c.name)) {
			refuse(`the constraint ${c.name} of ${printObjectName(table)} already exists (42710)`)
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
			refuse(`the index ${from} does not exist (42P01)`)
		}
		if (this.#relationTaken(to)) {
			refuse(`the relation ${to} already exists (42P07), so the index ${from} cannot take it`)
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
				`the type of ${printObjectName(table)}.${column} is changed while ${pinned} depends on it (0A000)`
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
			refuse(`the type ${printType(type)} does not exist (42704)`)
		}
	}

	#renameType(name: ObjectName, to: string): void {
		const d = this.#domains.get(name.name)
		if (d === undefined) {
			refuse(`the domain ${printObjectName(name)} does not exist (42704)`)
		}
		if (this.#typeTaken(to)) {
			refuse(`the type ${to} already exists (42710)`)
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
				refuse(`the domain ${printObjectName(name)} does not exist (42704)`)
			}
			return
		}
		const isOf = (type: TypeRef) =>
			type.kind === "named" && type.schema === name.schema && type.name === name.name
		for (const [table, t] of this.#tables) {
			for (const c of t.columns) {
				if (isOf(c.type)) {
					refuse(
						`the type ${printObjectName(name)} is dropped while ${table}.${c.name} still uses it (2BP01)`
					)
				}
			}
		}
		for (const [domain, d] of this.#domains) {
			if (isOf(d.base)) {
				refuse(
					`the type ${printObjectName(name)} is dropped while the domain ${domain} is of it (2BP01)`
				)
			}
		}
		for (const [table, of] of this.#triggers) {
			for (const [trigger, t] of of) {
				if (Arr.some(t.types, isOf)) {
					refuse(
						`the type ${printObjectName(name)} is dropped while the trigger ${trigger} of ${table} casts to it (2BP01)`
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
				refuse(`${what} calls the function ${this.#schema}.${name}(), which does not exist (42883)`)
			}
		}
	}

	/** The value a constant of the schema returns, its body evaluated; Unevaluable for a function that is no constant. */
	#constant(name: string, seen: ReadonlySet<string>): SqlValue {
		const f = this.#functions.get(name)
		if (f === undefined) {
			return refuse(`the function ${this.#schema}.${name}() does not exist (42883)`)
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
			case "float":
			case "floatSpecial":
			case "handle":
			case "handles":
			case "money":
			case "numeric":
			case "span":
			case "uuid":
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
					`column ${column} of table ${table} contains values that violate the new constraint ${name} (23514)`
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
				refuse(`check constraint ${name} of relation ${table} is violated by some row (23514)`)
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
				`the function ${printObjectName(name)}() already exists with the same argument types (42723)`
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
			refuse(`the function ${printObjectName(fn)} does not exist (42883)`)
		}
		for (const c of columns) {
			this.#column(t, table, c)
		}
		const of = this.#triggersOf(table.name)
		if (of.has(name)) {
			refuse(`the trigger ${name} of ${printObjectName(table)} already exists (42710)`)
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
				case "dropDefault":
					this.#column(this.#table(s.table), s.table, a.column)
					break
				case "addIdentity": {
					const t = this.#table(s.table)
					const at = this.#columnAt(t, s.table, a.column, "identity")
					const c = t.columns[at]
					if (c?.generation.kind !== "none") {
						refuse(
							`the column ${a.column} of ${printObjectName(s.table)} is already generated (42611)`
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
							`the column ${a.column} of ${printObjectName(s.table)} is not an identity column (55000)`
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
						refuse(`the index ${a.index} does not exist (42704)`)
					}
					if (x.on !== s.table.name || !x.bindable || x.owner.kind !== "free") {
						refuse(
							`the index ${a.index} cannot implement the key ${a.name} of ${printObjectName(s.table)} (55000)`
						)
					}
					const of = this.#constraintsOf(s.table.name)
					if (of.has(a.name)) {
						refuse(`the constraint ${a.name} of ${printObjectName(s.table)} already exists (42710)`)
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
						refuse(`the constraint ${a.name} of ${printObjectName(s.table)} does not exist (42704)`)
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
							`the column ${a.column} of ${printObjectName(s.table)} is not a stored generated column (42611)`
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
					refuse(`the view ${printObjectName(s.name)} does not exist (42P01)`)
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
					refuse(`the sequence ${printObjectName(s.name)} does not exist (42P01)`)
				}
				if (this.#relationTaken(s.to)) {
					refuse(
						`the relation ${s.to} already exists (42P07), so the sequence ${printObjectName(s.name)} cannot take it`
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
					refuse(`the statistics object ${printObjectName(s.name)} does not exist (42704)`)
				}
				if (this.#statistics.has(s.to)) {
					refuse(`the statistics object ${s.to} already exists (42710)`)
				}
				this.#statistics.delete(s.name.name)
				this.#statistics.set(s.to, x)
				return
			}
		}
	}

	#drop(s: Extract<SqlStatement, { readonly kind: "drop" }>): void {
		if (s.object === "ROLE") {
			return
		}
		if (s.object === "SCHEMA") {
			for (const key of this.#dependents.keys()) {
				if (Str.startsWith(`view ${s.name}.`)(key)) {
					refuse(`the schema ${s.name} is dropped while it holds the ${key} (2BP01)`)
				}
			}
			return
		}
		if (s.object === "VIEW") {
			const key = `view ${s.name.schema}.${s.name.name}`
			if (!this.#dependents.delete(key) && !s.ifExists) {
				refuse(`the dropped view ${printObjectName(s.name)} does not exist (42P01)`)
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
						refuse(`the dropped table ${printObjectName(s.name)} does not exist (42P01)`)
					}
					return
				}
				for (const [source, of] of this.#constraints) {
					for (const [constraint, c] of of) {
						if (source !== name && c.kind === "foreignKey" && c.references === name) {
							refuse(
								`the table ${name} is dropped while the foreign key ${source}.${constraint} references it (2BP01)`
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
						refuse(`the dropped view ${printObjectName(s.name)} does not exist (42P01)`)
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
						refuse(`the dropped sequence ${printObjectName(s.name)} does not exist (42P01)`)
					}
					return
				}
				if (q.kind === "identity") {
					refuse(
						`the sequence ${name} is dropped while the column ${q.table}.${q.column} owns it (2BP01)`
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
				refuse(`${what} is dropped while the materialized view ${view} reads it (2BP01)`)
			}
		}
		for (const [key, v] of this.#dependents) {
			if (Str.startsWith("view ")(key) && v.reads.has(relation)) {
				refuse(`${what} is dropped while the ${key} reads it (2BP01)`)
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

	/** What a GRANT or REVOKE names must exist, as PostgreSQL requires of it. */
	#privilegesOn(on: Extract<SqlStatement, { readonly kind: "grant" }>["on"]): void {
		switch (on.kind) {
			case "TABLE":
				for (const n of on.names) {
					this.#relation(n)
				}
				return
			case "SEQUENCE":
				for (const n of on.names) {
					if (this.#ours(n) && !this.#sequences.has(n.name)) {
						refuse(`the sequence ${printObjectName(n)} does not exist (42P01)`)
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
						refuse(`the function ${printObjectName(n)} does not exist (42883)`)
					}
				}
				return
			case "SCHEMA":
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
						refuse(`the column ${c.name} of ${printObjectName(s.table)} is declared twice (42701)`)
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
				if (s.object !== "ROLE" && s.object !== "SCHEMA" && this.#ours(s.name)) {
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
					refuse(`the column ${s.to} of ${printObjectName(s.table)} already exists (42701)`)
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
					refuse(`the constraint ${s.from} of ${printObjectName(s.table)} does not exist (42704)`)
				}
				if (of.has(s.to)) {
					refuse(`the constraint ${s.to} of ${printObjectName(s.table)} already exists (42710)`)
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
			case "dropTrigger": {
				if (!this.#ours(s.table)) {
					return
				}
				this.#table(s.table)
				const of = this.#triggersOf(s.table.name)
				if (!of.delete(s.name) && !s.ifExists) {
					refuse(`the trigger ${s.name} of ${printObjectName(s.table)} does not exist (42704)`)
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
						refuse(`the column ${c} of ${printObjectName(s.table)} does not exist (42703)`)
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
				this.#privilegesOn(s.on)
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
					refuse(`the statistics object ${s.name.name} already exists (42710)`)
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
						refuse(`the dropped index ${printObjectName(s.name)} does not exist (42704)`)
					}
					return
				}
				if (x.owner.kind === "constraint") {
					refuse(
						`the index ${s.name.name} is dropped while the constraint ${x.owner.name} requires it (2BP01)`
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
					refuse(`the type ${printObjectName(s.name)} already exists (42710)`)
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
					refuse(`the domain ${printObjectName(s.name)} does not exist (42704)`)
				}
				const constraints = new Map(d.constraints)
				const a = s.action
				switch (a.kind) {
					case "addConstraint": {
						if (constraints.has(a.constraint.name)) {
							refuse(
								`the constraint ${a.constraint.name} of the domain ${s.name.name} already exists (42710)`
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
							refuse(`the constraint ${a.name} of the domain ${s.name.name} does not exist (42704)`)
						}
						if (!check.valid) {
							this.#validateDomain(s.name.name, a.name, check)
						}
						constraints.set(a.name, { ...check, valid: true })
						break
					}
					case "dropConstraint":
						if (!constraints.delete(a.name)) {
							refuse(`the constraint ${a.name} of the domain ${s.name.name} does not exist (42704)`)
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
						refuse(`the dropped function ${printObjectName(s.name)} does not exist (42883)`)
					}
					return
				}
				const [caller] = this.#callersOf(s.name.name)
				if (caller !== undefined) {
					refuse(`cannot drop the function ${s.name.name} because ${caller} depends on it (2BP01)`)
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
					refuse(`the ${key} already exists (42P07)`)
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
					refuse(`the ${key} already exists (42710)`)
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
						`the dropped policy ${s.name} on ${printObjectName(s.table)} does not exist (42704)`
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
			case "insert":
			case "update":
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

	/** ADD COLUMN with the reviewer's value as its default, then DROP DEFAULT. */
	#perform(a: Action, placeholder: PlaceholderValue): void {
		switch (a.kind) {
			case "statement":
				this.statement(a.statement)
				return
			case "placeholderColumn":
				this.#typeExists(a.column.type)
				this.#addColumn(a.table, columnOf(a.column, this.#schema), () => ({
					kind: "value",
					value: placeholder(a)
				}))
				return
			case "placeholderRetype":
				this.#typeExists(a.column.type)
				this.#retype(a.table, a.column.name, a.column.type, {
					kind: "given",
					value: () => ({ kind: "value", value: placeholder(a) })
				})
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
					refuse(`the statistics object ${printObjectName(a.name)} does not exist (42704)`)
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
					return Result.fail({ file: f.draft.name, action: k + 1, reason: error.reason })
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
export const typeText = (column: Column): string => printType(column.type)

const list = (names: ReadonlyArray<string>): string => Arr.join(names, ", ")
const sortedList = (names: Iterable<string>): string =>
	Arr.join(Arr.sort([...names], Order.String), ", ")

const generationText = (g: Generation): string => {
	switch (g.kind) {
		case "none":
			return ""
		case "identity":
			return ` identity ${g.sequence}`
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

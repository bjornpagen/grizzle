import type {
	BinaryOperator,
	BuiltinFunctionName,
	BuiltinTypeName,
	Call,
	Collation,
	ColumnDefinition,
	CountStar,
	CreateFunction,
	Cte,
	CteBody,
	Expr,
	FiniteFloat,
	FromItem,
	FunctionName,
	FunctionRef,
	IndexKey,
	LiteralValue,
	ObjectName,
	OrderItem,
	RecordsetPlaceholder,
	Select,
	SelectBody,
	SelectCore,
	Target,
	TypeRef,
	ValuePlaceholder,
	WindowSpec
} from "#compiler/sql/ast.ts"

/**
 * Constructors for the SQL AST (ast.ts). Plain functions returning plain data, so a lowering reads as the SQL it
 * emits. Each constructor states every clause it does not take as none: an empty list, false, or undefined. A caller
 * that needs one of those clauses spreads the constructed node and states it, as in `{ ...select(body), limit }`.
 */
export const builtinType = (name: BuiltinTypeName): TypeRef => ({
	kind: "builtin",
	name,
	precision: undefined,
	scale: undefined,
	array: false
})

/** numeric(p) when the scale is undefined, or numeric(p, s). Plain numeric is types.numeric. */
export const numericType = (precision: number, scale: number | undefined): TypeRef => ({
	kind: "builtin",
	name: "numeric",
	precision,
	scale,
	array: false
})

/** A schema-qualified type, with its typmod: empty for none, [n] for vector(n). */
export const namedType = (
	schema: string,
	name: string,
	typmod: ReadonlyArray<number>
): TypeRef => ({
	kind: "named",
	schema,
	name,
	typmod,
	array: false
})

/** Whether two type references name the same PostgreSQL type, typmod and array dimension included. */
export const sameTypeRef = (a: TypeRef, b: TypeRef): boolean => {
	if (a.kind === "builtin" && b.kind === "builtin") {
		return (
			a.name === b.name && a.precision === b.precision && a.scale === b.scale && a.array === b.array
		)
	}
	if (a.kind === "named" && b.kind === "named") {
		return (
			a.schema === b.schema &&
			a.name === b.name &&
			a.array === b.array &&
			a.typmod.length === b.typmod.length &&
			a.typmod.every((m, i) => m === b.typmod[i])
		)
	}
	return false
}

export const types = {
	smallint: builtinType("smallint"),
	integer: builtinType("integer"),
	bigint: builtinType("bigint"),
	numeric: builtinType("numeric"),
	real: builtinType("real"),
	double: builtinType("double precision"),
	boolean: builtinType("boolean"),
	text: builtinType("text"),
	uuid: builtinType("uuid"),
	jsonb: builtinType("jsonb"),
	money: builtinType("money"),
	int4range: builtinType("int4range"),
	int8range: builtinType("int8range"),
	regclass: builtinType("regclass"),
	record: builtinType("record")
} as const

export const objectName = (schema: string, name: string): ObjectName => ({ schema, name })

/** The function a CREATE FUNCTION creates, as GRANT, REVOKE and DROP name it. */
export const functionNameOf = (fn: CreateFunction): FunctionName => ({
	...fn.name,
	args: fn.params.map((p) => p.type)
})

/** The fixed collation of every collatable column and expression. */
export const cUtf8Collation: Collation = { schema: "pg_catalog", name: "pg_c_utf8" }

/**
 * A column of a function's column definition list (jsonb_to_recordset(...) AS r(c1 uuid, c2 text COLLATE
 * pg_catalog.pg_c_utf8)): builtin text names the fixed collation like a stored column, and no other type takes one.
 */
export const columnDefinition = (name: string, type: TypeRef): ColumnDefinition => ({
	name,
	type,
	collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
})

export const col = (table: string, column: string): Expr => ({ kind: "column", table, column })

/** An unqualified column, inside DDL. */
export const tableCol = (column: string): Expr => ({ kind: "column", table: undefined, column })

/** The value placeholder `$<number>::<type>` of a slot no lowering allocates: a function's argument, the ledger's. */
export const param = (number: number, type: TypeRef): Expr => ({
	kind: "param",
	slot: positionalValue(number),
	type
})

/** The value placeholder `$<n>::<type>` of a lowering's slot `slot`, $n its number (sql/ast.ts ValuePlaceholder). */
export const slotParam = (slot: ValuePlaceholder, type: TypeRef): Expr => param(slot.number, type)

/** The positional value placeholder $<number>. */
export const positionalValue = (number: number): ValuePlaceholder => ({
	placeholder: "value",
	number
})

/** The positional recordset placeholder $<number>, of a recordset no lowering allocated. */
export const positionalRecordset = (number: number): RecordsetPlaceholder => ({
	placeholder: "recordset",
	number
})

/** Whether u is a finite double other than -0: the finite float arm's whole domain, and lit.float's one way to make one. */
export const isFiniteFloat = (u: unknown): u is FiniteFloat =>
	typeof u === "number" && Number.isFinite(u) && !Object.is(u, -0)

/** A finite double other than -0 is a float literal; NaN, either infinity and -0 are spelled as specials. */
const floatValue = (value: number): LiteralValue => {
	if (isFiniteFloat(value)) {
		return { kind: "float", value }
	}
	return Number.isNaN(value)
		? { kind: "floatSpecial", value: "NaN" }
		: value === Number.POSITIVE_INFINITY
			? { kind: "floatSpecial", value: "Infinity" }
			: value === Number.NEGATIVE_INFINITY
				? { kind: "floatSpecial", value: "-Infinity" }
				: { kind: "floatSpecial", value: "-0" }
}

/** Each literal states its type: a boolean is typed boolean, and every other literal the type its caller names. */
export const lit = {
	bool: (value: boolean): Expr => ({
		kind: "literal",
		value: { kind: "bool", value },
		type: types.boolean
	}),
	int: (value: bigint | number, type: TypeRef): Expr => ({
		kind: "literal",
		value: { kind: "int", value: BigInt(value) },
		type
	}),
	decimal: (value: string, type: TypeRef): Expr => ({
		kind: "literal",
		value: { kind: "decimal", value },
		type
	}),
	float: (value: number, type: TypeRef): Expr => ({
		kind: "literal",
		value: floatValue(value),
		type
	}),
	text: (value: string, type: TypeRef): Expr => ({
		kind: "literal",
		value: { kind: "text", value },
		type
	})
} as const

export const cast = (expr: Expr, type: TypeRef): Expr => ({ kind: "cast", expr, type })

export const binary = (op: BinaryOperator, left: Expr, right: Expr): Expr => ({
	kind: "binary",
	op,
	left,
	right,
	schema: undefined
})
export const eq = (left: Expr, right: Expr): Expr => binary("=", left, right)
export const ne = (left: Expr, right: Expr): Expr => binary("<>", left, right)
export const lt = (left: Expr, right: Expr): Expr => binary("<", left, right)
export const le = (left: Expr, right: Expr): Expr => binary("<=", left, right)
export const gt = (left: Expr, right: Expr): Expr => binary(">", left, right)
export const ge = (left: Expr, right: Expr): Expr => binary(">=", left, right)

/** AND of one operand is that operand; of several, one n-ary node. */
const single = (args: ReadonlyArray<Expr>): Expr | undefined =>
	args.length === 1 ? args[0] : undefined
export const and = (...args: ReadonlyArray<Expr>): Expr => single(args) ?? { kind: "and", args }
export const or = (...args: ReadonlyArray<Expr>): Expr => single(args) ?? { kind: "or", args }
export const not = (expr: Expr): Expr => ({ kind: "not", expr })

/** The conjunction of the predicates as a WHERE or HAVING clause: none (undefined) when there is no predicate. */
export const conjunction = (predicates: ReadonlyArray<Expr>): Expr | undefined =>
	predicates.length === 0 ? undefined : and(...predicates)

export const row = (...items: ReadonlyArray<Expr>): Expr => ({ kind: "row", items })

export const exists = (query: Select): Expr => ({ kind: "exists", query, not: false })
export const notExists = (query: Select): Expr => ({ kind: "exists", query, not: true })

/** A plain call of a function of its arguments: no DISTINCT, ORDER BY, WITHIN GROUP or OVER. */
const plainCall = (fn: FunctionRef, args: ReadonlyArray<Expr>): Call => ({
	kind: "call",
	fn,
	args,
	star: false,
	distinct: false,
	orderBy: [],
	withinGroup: [],
	over: undefined
})

export const call = (name: BuiltinFunctionName, args: ReadonlyArray<Expr>): Call =>
	plainCall({ kind: "builtin", name }, args)

export const qualifiedCall = (schema: string, name: string, args: ReadonlyArray<Expr>): Call =>
	plainCall({ kind: "qualified", schema, name }, args)

/** count(*) without FILTER or OVER. */
export const countStar = (): CountStar => ({
	kind: "call",
	fn: { kind: "builtin", name: "count" },
	args: [],
	star: true,
	filter: undefined,
	over: undefined
})

/** A window of its partition and its order, with no explicit frame. */
export const windowOf = (
	partitionBy: ReadonlyArray<Expr>,
	orderBy: ReadonlyArray<OrderItem>
): WindowSpec => ({
	partitionBy,
	orderBy,
	frame: undefined
})

export const asc = (expr: Expr): OrderItem => ({ expr, direction: "ASC" })
export const desc = (expr: Expr): OrderItem => ({ expr, direction: "DESC" })

/** An index key of a column, ascending, under its column's collation and its type's default operator class. */
export const columnKey = (column: string): IndexKey => ({
	key: { kind: "column", column },
	collation: undefined,
	opclass: undefined,
	direction: "ASC"
})

/** An unaliased target. */
export const target = (expr: Expr): Target => ({ expr, alias: undefined })

/** `expr AS alias`. */
export const targetAs = (expr: Expr, alias: string): Target => ({ expr, alias })

export const table = (schema: string, name: string, alias: string): FromItem => ({
	kind: "table",
	table: objectName(schema, name),
	alias
})

export const cteRef = (name: string): FromItem => ({ kind: "cte", name, alias: undefined })

/** A CTE under a fresh alias. */
export const cteRefAs = (name: string, alias: string): FromItem => ({ kind: "cte", name, alias })

/** A derived table, (SELECT ...) AS "alias"(columns), LATERAL or not. */
export const derived = (
	query: Select,
	alias: string,
	columns: ReadonlyArray<string>,
	lateral: boolean
): FromItem => ({
	kind: "derived",
	query,
	alias,
	columns,
	lateral
})

export const join = (left: FromItem, right: FromItem, on: Expr): FromItem => ({
	kind: "join",
	left,
	right,
	on
})

/**
 * jsonb_to_recordset($<n>::jsonb) AS "<alias>"(<columns>), $n the number of `source`, a lowering's slot or a positional
 * placeholder, which the recordset holds as its placeholder (sql/ast.ts RecordsetPlaceholder).
 */
export const recordset = (
	source: RecordsetPlaceholder,
	alias: string,
	columns: ReadonlyArray<ColumnDefinition>
): FromItem => ({
	kind: "recordset",
	source: positionalRecordset(source.number),
	alias,
	columns
})

/**
 * SELECT <targets> [FROM <from>] [WHERE <where>]: no DISTINCT, GROUP BY or HAVING; an empty FROM and an undefined WHERE
 * are none.
 */
export const core = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SelectCore => ({
	kind: "core",
	distinct: false,
	targets,
	from,
	where,
	groupBy: [],
	having: undefined
})

/**
 * A CTE of its name, its column list (empty for a data-modifying CTE named by its RETURNING aliases) and its body,
 * materialized as PostgreSQL chooses.
 */
export const cte = (name: string, columns: ReadonlyArray<string>, query: CteBody): Cte => ({
	name,
	columns,
	materialized: undefined,
	query
})

/** A full query of its body: no WITH, ORDER BY, LIMIT or OFFSET. */
export const select = (body: SelectBody): Select => ({
	kind: "select",
	with: undefined,
	body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/** SELECT <targets> [FROM <from>] [WHERE <where>] as a full query. */
export const simpleSelect = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): Select => select(core(targets, from, where))

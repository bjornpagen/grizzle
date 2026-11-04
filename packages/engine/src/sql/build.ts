import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ExactCarrier } from "#compiler/scalar/aggregate.ts"
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
	FromSource,
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
	SetOperand,
	SetOperation,
	SetOperator,
	Target,
	TypeRef,
	TypeSchema,
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

/**
 * A type of the installation's or the vector extension's schema, with its typmod: empty for none, [n] for vector(n).
 * Its schema is a TypeSchema, which only the doors naming those schemas mint, so no named type sits in pg_catalog.
 */
export const namedType = (
	schema: TypeSchema,
	name: string,
	typmod: ReadonlyArray<number>
): TypeRef => ({
	kind: "named",
	schema,
	name,
	typmod,
	array: false
})

/**
 * Whether two type references name one type: the same variant with the same fields, typmod and array dimension
 * included. A type's identity is its structure, never its printed spelling.
 */
export const sameTypeRef = (a: TypeRef, b: TypeRef): boolean => {
	switch (a.kind) {
		case "builtin":
			return (
				b.kind === "builtin" &&
				a.name === b.name &&
				a.precision === b.precision &&
				a.scale === b.scale &&
				a.array === b.array
			)
		case "named":
			return (
				b.kind === "named" &&
				a.schema === b.schema &&
				a.name === b.name &&
				a.array === b.array &&
				a.typmod.length === b.typmod.length &&
				a.typmod.every((m, i) => m === b.typmod[i])
			)
	}
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
export const and = (args: NonEmptyReadonlyArray<Expr>): Expr =>
	args.length === 1 ? args[0] : { kind: "and", args }
export const or = (args: NonEmptyReadonlyArray<Expr>): Expr =>
	args.length === 1 ? args[0] : { kind: "or", args }
export const not = (expr: Expr): Expr => ({ kind: "not", expr })

/** The conjunction of the predicates as a WHERE or HAVING clause: none (undefined) when there is no predicate. */
export const conjunction = (predicates: ReadonlyArray<Expr>): Expr | undefined =>
	isNonEmpty(predicates) ? and(predicates) : undefined

export const row = (items: NonEmptyReadonlyArray<Expr>): Expr => ({ kind: "row", items })

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

const integer = (value: number): Expr => lit.int(value, types.integer)

/** get_byte(float8send(x), i): byte i of a double's IEEE 754 bits, most significant first, an integer 0..255. */
const bitsByte = (x: Expr, i: number): Expr =>
	call("get_byte", [call("float8send", [x]), integer(i)])

/** The biased exponent field e of a double's bits, 0..2047: byte 0's low 7 bits, then byte 1's high 4. */
const exponentField = (x: Expr): Expr =>
	binary(
		"+",
		binary("*", binary("%", bitsByte(x, 0), integer(128)), integer(16)),
		binary("/", bitsByte(x, 1), integer(16))
	)

/** The 52-bit fraction field of a double's bits, a bigint: byte 1's low 4 bits, then bytes 2 to 7. */
const fractionField = (x: Expr): Expr => {
	let field = cast(binary("%", bitsByte(x, 1), integer(16)), types.bigint)
	for (let i = 2; i < 8; i++) {
		field = binary("+", binary("*", field, integer(256)), bitsByte(x, i))
	}
	return field
}

/** The value of a finite double's sign: -1 below zero, else 1 (-0 is zero, whose exact value has no sign). */
const signOf = (x: Expr): Expr => ({
	kind: "case",
	operand: undefined,
	whens: [{ when: lt(x, lit.float(0, types.double)), result: integer(-1) }],
	else: integer(1)
})

/**
 * The exact numeric value of a double precision expression. Its bits, read through float8send, are a sign, an
 * exponent e and a significand M (with the implicit bit when e > 0). The value M · 2^P, P = max(e, 1) - 1075, is
 * written as the text of M · 2^P when P ≥ 0, and of M · 5^-P with exponent P below, so numeric_in reads it with
 * no rounding at any scale (power(10, P) rounds past NUMERIC_MAX_DISPLAY_SCALE = 1000). NaN and the infinities are
 * numeric's own. A real widens to double precision exactly first; money is money::numeric (cash_numeric, exact).
 *
 * It is written inline, every use of the argument repeated, because an installed function is an object to name,
 * grant, migrate and check for drift, and a non-inlined SQL function costs forty times as much per row.
 */
export const exactNumeric = (e: Expr, carrier: ExactCarrier): Expr => {
	switch (carrier) {
		case "money":
			return cast(e, types.numeric)
		case "float4":
			return exactDouble(cast(e, types.double))
		case "float8":
			return exactDouble(e)
	}
}

/** power(base::numeric, exponent::numeric) over an integer exponent, which PostgreSQL computes exactly. */
const exactPower = (base: number, exponent: Expr): Expr =>
	call("power", [lit.int(base, types.numeric), cast(exponent, types.numeric)])

/**
 * A finite double's exact value as numeric_in reads it: the text of M · 2^max(P, 0) · 5^max(-P, 0), signed, with the
 * exponent min(P, 0), so every digit is written and none rounds.
 */
const exactDouble = (x: Expr): Expr => {
	const exponent = exponentField(x)
	const implicit: Expr = {
		kind: "case",
		operand: undefined,
		whens: [{ when: eq(exponent, integer(0)), result: lit.int(0, types.bigint) }],
		else: lit.int(2n ** 52n, types.bigint)
	}
	const significand = binary("+", fractionField(x), implicit)
	const power: Expr = binary("-", { kind: "greatest", args: [exponent, integer(1)] }, integer(1075))
	const digits = binary(
		"*",
		binary(
			"*",
			cast(binary("*", signOf(x), significand), types.numeric),
			exactPower(2, { kind: "greatest", args: [power, integer(0)] })
		),
		exactPower(5, { kind: "greatest", args: [binary("-", integer(0), power), integer(0)] })
	)
	const written = binary(
		"||",
		binary("||", cast(digits, types.text), lit.text("e", types.text)),
		cast({ kind: "least", args: [power, integer(0)] }, types.text)
	)
	const special = or([
		ge(x, lit.float(Number.POSITIVE_INFINITY, types.double)),
		le(x, lit.float(Number.NEGATIVE_INFINITY, types.double))
	])
	return {
		kind: "case",
		operand: undefined,
		whens: [{ when: special, result: cast(x, types.numeric) }],
		else: cast(written, types.numeric)
	}
}

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

export const table = (schema: string, name: string, alias: string): FromSource => ({
	kind: "table",
	table: objectName(schema, name),
	alias
})

export const cteRef = (name: string): FromSource => ({ kind: "cte", name, alias: undefined })

/** A CTE under a fresh alias. */
export const cteRefAs = (name: string, alias: string): FromSource => ({ kind: "cte", name, alias })

/** A derived table, (SELECT ...) AS "alias"(columns), LATERAL or not. */
export const derived = (
	query: Select,
	alias: string,
	columns: ReadonlyArray<string>,
	lateral: boolean
): FromSource => ({
	kind: "derived",
	query,
	alias,
	columns,
	lateral
})

/** The unit relation's one row under `alias`: `(SELECT) AS alias`, one row of no column, which VALUES cannot spell. */
export const unitRow = (alias: string): FromSource =>
	derived(select(core([], [], undefined)), alias, [], false)

/** `first JOIN source ON on`: a join chain of one step. */
export const join = (first: FromSource, source: FromSource, on: Expr): FromItem => ({
	kind: "joins",
	first,
	steps: [{ kind: "on", source, on }]
})

/**
 * jsonb_to_recordset($<n>::jsonb) AS "<alias>"(<columns>), $n the number of `source`, a lowering's slot or a positional
 * placeholder, which the recordset holds as its placeholder (sql/ast.ts RecordsetPlaceholder).
 */
export const recordset = (
	source: RecordsetPlaceholder,
	alias: string,
	columns: ReadonlyArray<ColumnDefinition>
): FromSource => ({
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
 * The core with each target mapped by `f`, position by position, its projection kept: under DISTINCT still at least one
 * target.
 */
export const mapTargets = (c: SelectCore, f: (t: Target, i: number) => Target): SelectCore =>
	c.distinct === false
		? { ...c, targets: c.targets.map(f) }
		: { ...c, targets: mapNonEmpty(c.targets, f) }

/**
 * SELECT DISTINCT <targets> [FROM <from>] [WHERE <where>]: at least one target, as DISTINCT requires; no GROUP BY or
 * HAVING.
 */
export const distinctCore = (
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SelectCore => ({
	kind: "core",
	distinct: true,
	targets,
	from,
	where,
	groupBy: [],
	having: undefined
})

/**
 * SELECT [DISTINCT] <targets> [FROM <from>] [WHERE <where>]: DISTINCT exactly when `distinct`, over at least one
 * target.
 */
export const distinctCoreWhen = (
	distinct: boolean,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SelectCore => (distinct ? distinctCore(targets, from, where) : core(targets, from, where))

/** SELECT DISTINCT ON (<on>) <targets> [FROM <from>] [WHERE <where>]: at least one key and one target. */
export const distinctOnCore = (
	on: NonEmptyReadonlyArray<Expr>,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SelectCore => ({
	kind: "core",
	distinct: { on },
	targets,
	from,
	where,
	groupBy: [],
	having: undefined
})

/**
 * The unit marker: the one target that reads a relation of no column where a target is required, under DISTINCT or as
 * a set operation's arm. Each row it reads is the one row of no column.
 */
export const unitTargets: NonEmptyReadonlyArray<Target> = [target(lit.bool(true))]

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

/** A body as a set operation's arm: a set operation nests parenthesized, as the body of a query of its own. */
export const asOperand = (body: SelectBody): SetOperand =>
	body.kind === "setOp" ? select(body) : body

/**
 * `body` then `arm`, combined by `op` left to right: a set operation of `op` continues with one more arm, and any other
 * body becomes the first arm.
 */
export const continued = (op: SetOperator, body: SelectBody, arm: SetOperand): SetOperation => {
	if (body.kind === "setOp" && body.op === op) {
		const [first, second, ...rest] = body.arms
		return { ...body, arms: [first, second, ...rest.concat([arm])] }
	}
	return { kind: "setOp", op, arms: [asOperand(body), arm] }
}

/** The arms combined by `op`, left to right: the one arm itself, or one set operation of them all. */
export const setOp = (op: SetOperator, arms: NonEmptyReadonlyArray<SetOperand>): SelectBody => {
	const [first, second, ...rest] = arms
	return second === undefined ? first : { kind: "setOp", op, arms: [first, second, ...rest] }
}

/** SELECT <targets> [FROM <from>] [WHERE <where>] as a full query. */
export const simpleSelect = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): Select => select(core(targets, from, where))

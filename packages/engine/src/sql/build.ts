import { type DecimalParts, partsText } from "#compiler/core/decimal.ts"
import { defect } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	ArraysSource,
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
	OperandBody,
	OperandCore,
	OperandSelect,
	OrderItem,
	RowsProof,
	Select,
	SelectBody,
	SelectCore,
	SetArm,
	SetCore,
	SetOperand,
	SetOperation,
	Target,
	TypeRef,
	TypeSchema,
	ValuePlaceholder,
	WindowSpec
} from "#compiler/sql/ast.ts"
import { isSetBody, isSetQuery } from "#compiler/sql/ast.ts"

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

/** The n of a bit(n) reference, undefined for every other type. */
const bitLength = (t: TypeRef): number | undefined =>
	t.kind === "builtin" && t.name === "bit" ? t.length : undefined

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
				a.array === b.array &&
				bitLength(a) === bitLength(b)
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
	date: builtinType("date"),
	bytea: builtinType("bytea"),
	jsonb: builtinType("jsonb"),
	money: builtinType("money"),
	int4range: builtinType("int4range"),
	int8range: builtinType("int8range"),
	daterange: builtinType("daterange"),
	record: builtinType("record"),
	/** bit(n): a set over a roster, one bit per code it has minted, padded to whole hex digits. */
	bit: (length: number): TypeRef => ({
		kind: "builtin",
		name: "bit",
		precision: undefined,
		scale: undefined,
		length,
		array: false
	}),
	/** bit varying: a constant's string of cells. */
	varbit: builtinType("bit varying"),
	/** name, or name[]: a roster's names constant's element, or the constant. */
	name: (array: boolean): TypeRef => ({
		kind: "builtin",
		name: "name",
		precision: undefined,
		scale: undefined,
		array
	})
} as const

export const objectName = (schema: string, name: string): ObjectName => ({ schema, name })

/**
 * The array type over `type`, the element type of an array literal or a dictionary: every type but bit(n), whose
 * arrays grizzle never names (a set is typed by its roster's bits domain, a named type), is undefined for it.
 */
export const arrayOf = (type: TypeRef): TypeRef | undefined => {
	switch (type.kind) {
		case "named":
			return { ...type, array: true }
		case "builtin":
			return type.name === "bit" ? undefined : { ...type, array: true }
	}
}

/** The function a CREATE FUNCTION creates, as GRANT, REVOKE and DROP name it. */
export const functionNameOf = (fn: CreateFunction): FunctionName => ({
	...fn.name,
	args: fn.params.map((p) => p.type)
})

/** The fixed collation of every collatable column and expression. */
export const cUtf8Collation: Collation = { schema: "pg_catalog", name: "pg_c_utf8" }

/**
 * A column of a relation input or a context source: builtin text names the fixed collation like a stored column, and
 * no other type takes one.
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

/** Whether u is a finite double other than -0: the finite float arm's whole domain, and lit.float's one way to make one. */
const isFiniteFloat = (u: unknown): u is FiniteFloat =>
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
	decimal: (value: DecimalParts, type: TypeRef): Expr => ({
		kind: "literal",
		value: { kind: "decimal", value: partsText(value) },
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
	}),
	/** A bit string's literal, its hex digits (core/hex.ts) cast to `type`: X'<hex>'::type. */
	bits: (hex: string, type: TypeRef): Expr => ({
		kind: "literal",
		value: { kind: "bits", hex },
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

export const exists = (query: OperandSelect): Expr => ({ kind: "exists", query, not: false })
export const notExists = (query: OperandSelect): Expr => ({ kind: "exists", query, not: true })

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

/**
 * The bytes float8send writes of a double: its IEEE 754 binary64 bits, most significant first.
 *
 * @formatConstant IEEE 754 binary64: 8 bytes
 */
const binary64Bytes = 8

/** The 52-bit fraction field of a double's bits, a bigint: byte 1's low 4 bits, then bytes 2 to 7. */
const fractionField = (x: Expr): Expr => {
	let field = cast(binary("%", bitsByte(x, 1), integer(16)), types.bigint)
	for (let i = 2; i < binary64Bytes; i++) {
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

/** power(base::numeric, exponent::numeric) over an integer exponent, which PostgreSQL computes exactly. */
const exactPower = (base: number, exponent: Expr): Expr =>
	call("power", [lit.int(base, types.numeric), cast(exponent, types.numeric)])

/**
 * The exact numeric value of a double precision expression. Its bits, read through float8send, are a sign, an
 * exponent e and a significand M (with the implicit bit when e > 0). The value M · 2^P, P = max(e, 1) - 1075, is
 * written as the text of M · 2^max(P, 0) · 5^max(-P, 0), signed, with the exponent min(P, 0), so numeric_in reads it
 * with no rounding at any scale (power(10, P) rounds past NUMERIC_MAX_DISPLAY_SCALE = 1000). NaN and the infinities
 * are numeric's own.
 *
 * It is written inline, every use of the argument repeated, because an installed function is an object to name,
 * grant, migrate and check for drift, and a non-inlined SQL function costs forty times as much per row.
 */
export const exactNumericOfDouble = (x: Expr): Expr => {
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
	query: OperandSelect,
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
	derived(select(provedCore("oneRow", [], [], undefined)), alias, [], false)

/** `first JOIN source ON on`: a join chain of one step. */
export const join = (first: FromSource, source: FromSource, on: Expr): FromItem => ({
	kind: "joins",
	first,
	steps: [{ kind: "on", source, on }]
})

/**
 * A relation input's arrays under `alias` (sql/ast.ts ArraysSource): its columns' arrays, read in lockstep, or its count
 * of rows of no column (sql/print.ts).
 */
export const arrays = (source: ArraysSource, alias: string): FromSource => ({
	kind: "arrays",
	source,
	alias
})

/**
 * SELECT <targets> [FROM <from>] [WHERE <where>] whose rows may repeat: an operand (sql/ast.ts OperandCore), with no
 * DISTINCT, GROUP BY or HAVING; an empty FROM and an undefined WHERE are none.
 */
export const core = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): OperandCore => ({
	kind: "core",
	distinct: false,
	rows: "operand",
	targets,
	from,
	where,
	groupBy: [],
	having: undefined
})

/**
 * SELECT <targets> [FROM <from>] [WHERE <where>] under the proof that no row repeats (sql/ast.ts RowsProof): a set
 * core without DISTINCT.
 */
export const provedCore = (
	rows: RowsProof,
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SetCore => ({
	kind: "core",
	distinct: false,
	rows,
	targets,
	from,
	where,
	groupBy: [],
	having: undefined
})

/** An operand core read as a set under its proof (sql/ast.ts RowsProof), every clause kept. */
export const proved = (rows: RowsProof, c: OperandCore): SetCore => ({ ...c, rows })

/** An operand core grouped by `groupBy`, each group one row: every GROUP BY expression is among its targets. */
export const grouped = (c: OperandCore, groupBy: ReadonlyArray<Expr>): SetCore => ({
	...c,
	rows: "grouped",
	groupBy
})

/**
 * The core with each target mapped by `f`, position by position, its projection kept: under DISTINCT still at least one
 * target.
 */
export const mapTargets = <C extends SelectCore>(c: C, f: (t: Target, i: number) => Target): C =>
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
): SetCore => ({
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
 * target, and otherwise a plain core the physical analysis proved unique (`certified`), its caller's decision.
 */
export const distinctCoreWhen = (
	distinct: boolean,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SetCore =>
	distinct ? distinctCore(targets, from, where) : provedCore("certified", targets, from, where)

/** SELECT DISTINCT ON (<on>) <targets> [FROM <from>] [WHERE <where>]: at least one key and one target. */
export const distinctOnCore = (
	on: NonEmptyReadonlyArray<Expr>,
	targets: NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SetCore => ({
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

/** A full query of its set body: no WITH, ORDER BY, LIMIT or OFFSET. */
export const select = (body: SelectBody): Select => ({
	kind: "select",
	with: undefined,
	body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/**
 * A full query of a body whose rows may repeat, an operand (sql/ast.ts OperandSelect): no WITH, ORDER BY, LIMIT or
 * OFFSET.
 */
export const operandSelect = (body: OperandBody): OperandSelect => ({
	kind: "select",
	with: undefined,
	body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/**
 * The set operation `like` over rebuilt `arms`, one per arm in order: a UNION ALL under its proof keeps it only over
 * set arms, so a rebuilt arm that is no set is a defect of the rebuild.
 */
export const withArms = (
	like: SetOperation,
	arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
): SetOperation => {
	if (like.op !== "UNION ALL" || like.rows === "oneRow" || like.rows === "operand") {
		return { ...like, arms }
	}
	const set = (arm: SetOperand): SetArm => {
		if (arm.kind === "core") {
			if (isSetBody(arm)) {
				return arm
			}
		} else if (isSetQuery(arm)) {
			return arm
		}
		throw defect("a rebuilt UNION ALL arm that is a set, as the UNION ALL's proof requires")
	}
	const [first, second, ...rest] = arms
	return { ...like, arms: [set(first), set(second), ...rest.map(set)] }
}

/**
 * A query rebuilt from a set query, a set still, as every rebuild that keeps its rows keeps it (a rename, a cast of
 * targets); `what` names the rebuild, whose returning an operand is a defect of it.
 */
export const setQueryOf = (query: OperandSelect, what: string): Select => {
	if (isSetQuery(query)) {
		return query
	}
	throw defect(`${what}, which keeps a set query a set`)
}

/** A body rebuilt from a set body, a set still (setQueryOf). */
export const setBodyOf = (body: OperandBody, what: string): SelectBody => {
	if (isSetBody(body)) {
		return body
	}
	throw defect(`${what}, which keeps a set body a set`)
}

/** A body as a set operation's arm: a set operation nests parenthesized, as the body of a query of its own. */
export const asOperand = (body: OperandBody): SetOperand =>
	body.kind === "setOp" ? operandSelect(body) : body

/** A set body as a set arm: a set operation nests parenthesized, as the body of a query of its own. */
export const asSetArm = (body: SelectBody): SetArm => (body.kind === "setOp" ? select(body) : body)

/**
 * `body` then `arm`, combined by the set-making `op` left to right: a set operation of `op` continues with one more
 * arm, and any other body becomes the first arm. A set-making operator absorbs its arms' repeats, so its arms are
 * operands.
 */
export const continued = (
	op: "UNION" | "INTERSECT" | "EXCEPT",
	body: OperandBody,
	arm: SetOperand
): SetOperation => {
	if (body.kind === "setOp" && body.op === op) {
		const [first, second, ...rest] = body.arms
		return { kind: "setOp", op, arms: [first, second, ...rest.concat([arm])] }
	}
	return { kind: "setOp", op, arms: [asOperand(body), arm] }
}

/** Whether a FROM source's rows are a set: a derived table's whose query is one, and every other source's. */
const readsSet = (source: FromSource): boolean =>
	source.kind !== "derived" || isSetQuery(source.query)

/** Whether every source of FROM items reads a set, a join chain's each. */
const fromReadsSets = (from: ReadonlyArray<FromItem>): boolean =>
	from.every((item) =>
		item.kind === "joins"
			? readsSet(item.first) && item.steps.every((step) => readsSet(step.source))
			: readsSet(item)
	)

/**
 * A core reading every row of `from` through `targets`, which hold a key of them: a set, keyed, when every source it
 * reads is a set, and otherwise an operand, whose rows repeat as its sources' do.
 */
export const keyedRead = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SelectCore =>
	fromReadsSets(from) ? provedCore("keyed", targets, from, where) : core(targets, from, where)

/**
 * A keyed read (keyedRead) that stands where a set is required, `what`: a source of it that may repeat rows is a defect
 * of the lowering that put it there.
 */
export const keyedSet = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined,
	what: string
): SetCore => {
	if (!fromReadsSets(from)) {
		throw defect(`${what}, which reads sets`)
	}
	return provedCore("keyed", targets, from, where)
}

/** A CTE a statement defines once and reads by name: its columns, and whether its rows are a set. */
export interface DefinedCte {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly set: boolean
}

/**
 * Every column of the CTE `defined`, read under `alias`: a set, keyed by its whole heading, when the CTE's rows are one,
 * and an operand when they may repeat.
 */
export const cteRead = (alias: string, defined: DefinedCte): OperandSelect => {
	const targets = defined.columns.map((c) => target(col(alias, c)))
	const from = [cteRefAs(defined.name, alias)]
	return defined.set
		? select(provedCore("keyed", targets, from, undefined))
		: operandSelect(core(targets, from, undefined))
}

/** Two or more arms combined by the set-making `op`, left to right: a set whatever its arms repeat. */
export const setOperation = (
	op: "UNION" | "INTERSECT" | "EXCEPT",
	arms: readonly [SetOperand, SetOperand, ...Array<SetOperand>]
): SelectBody => ({ kind: "setOp", op, arms })

/** The arms combined by the set-making `op`, left to right: the one arm itself, or one set operation of them all. */
export const setOp = (
	op: "UNION" | "INTERSECT" | "EXCEPT",
	arms: NonEmptyReadonlyArray<SetOperand>
): OperandBody => {
	const [first, second, ...rest] = arms
	return second === undefined ? first : { kind: "setOp", op, arms: [first, second, ...rest] }
}

/**
 * `body` then the set `arm`, combined by UNION ALL under the proof `rows` left to right: a UNION ALL under the same proof
 * continues with one more arm, and any other set body becomes the first arm.
 */
export const continuedAll = (
	rows: "disjoint" | "certified",
	body: SelectBody,
	arm: SetArm
): SelectBody => {
	if (body.kind === "setOp" && body.op === "UNION ALL") {
		if (body.rows === "disjoint" || body.rows === "certified") {
			if (body.rows === rows) {
				const [first, second, ...rest] = body.arms
				return {
					kind: "setOp",
					op: "UNION ALL",
					rows,
					arms: [first, second, ...rest.concat([arm])]
				}
			}
		}
	}
	return { kind: "setOp", op: "UNION ALL", rows, arms: [asSetArm(body), arm] }
}

/** The set arms combined by UNION ALL under the proof that no two share a row, left to right, or the one arm itself. */
export const unionAll = (
	rows: "disjoint" | "certified",
	arms: NonEmptyReadonlyArray<SetArm>
): SelectBody => {
	const [first, second, ...rest] = arms
	return second === undefined
		? first
		: { kind: "setOp", op: "UNION ALL", rows, arms: [first, second, ...rest] }
}

/** Arms combined by UNION ALL whose rows may repeat, an operand, left to right, or the one arm itself. */
export const operandUnionAll = (arms: NonEmptyReadonlyArray<SetOperand>): OperandBody => {
	const [first, second, ...rest] = arms
	return second === undefined
		? first
		: { kind: "setOp", op: "UNION ALL", rows: "operand", arms: [first, second, ...rest] }
}

/** SELECT <targets> [FROM <from>] [WHERE <where>] as a full query whose rows may repeat: an operand. */
export const simpleSelect = (
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): OperandSelect => operandSelect(core(targets, from, where))

/** SELECT <targets> [FROM <from>] [WHERE <where>] as a full query, under the proof that no row repeats. */
export const provedSelect = (
	rows: RowsProof,
	targets: ReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): Select => select(provedCore(rows, targets, from, where))

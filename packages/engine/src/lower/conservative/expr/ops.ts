import { defect } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { OpId, PatternTable, ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { exactForm, ieeeForm } from "#compiler/lower/conservative/expr/total.ts"
import {
	admitsArity,
	type NativeOp,
	nativeOp,
	type OperandReading
} from "#compiler/scalar/compute/registry.ts"
import {
	type BinaryOperator,
	type BuiltinFunctionName,
	builtinFunctionNames,
	type Expr
} from "#compiler/sql/ast.ts"
import { and, binary, call, lit, not, or, types } from "#compiler/sql/build.ts"

type OpForm = { readonly kind: "binary"; readonly op: BinaryOperator } | { readonly kind: "negate" }

/**
 * The operator forms by oprcode:
 *
 * - comparisons: int2eq .. int84ge, float4eq .. float84ge, booleq; numeric_eq, cash_eq, uuid_eq; texteq and textne,
 *   then text_lt .. text_ge;
 * - arithmetic: + - * / over the integer and float pairs, % over the integers; numeric's named forms; money;
 * - text: concatenation and regex membership (equality, ordering and regex membership are all a query does with text).
 */
const opTable = (): ReadonlyMap<string, OpForm> => {
	const table = new Map<string, OpForm>()
	const put = (form: OpForm, names: ReadonlyArray<string>) => {
		for (const name of names) {
			table.set(name, form)
		}
	}

	const integerPairs = [
		"int2",
		"int4",
		"int8",
		"int24",
		"int42",
		"int28",
		"int82",
		"int48",
		"int84"
	] as const
	const floatPairs = ["float4", "float8", "float48", "float84"]
	const comparisons: ReadonlyArray<readonly [string, BinaryOperator]> = [
		["eq", "="],
		["ne", "<>"],
		["lt", "<"],
		["le", "<="],
		["gt", ">"],
		["ge", ">="]
	]

	for (const [suffix, op] of comparisons) {
		put(
			{ kind: "binary", op },
			[...integerPairs, ...floatPairs, "bool"].map((p) => `${p}${suffix}`)
		)
		put(
			{ kind: "binary", op },
			["numeric", "cash", "uuid"].map((p) => `${p}_${suffix}`)
		)
		put({ kind: "binary", op }, [
			suffix === "eq" || suffix === "ne" ? `text${suffix}` : `text_${suffix}`
		])
	}

	for (const p of [...integerPairs, ...floatPairs]) {
		put({ kind: "binary", op: "+" }, [`${p}pl`])
		put({ kind: "binary", op: "-" }, [`${p}mi`])
		put({ kind: "binary", op: "*" }, [`${p}mul`])
		put({ kind: "binary", op: "/" }, [`${p}div`])
	}
	put({ kind: "binary", op: "%" }, ["int2mod", "int4mod", "int8mod", "numeric_mod"])
	put({ kind: "binary", op: "+" }, ["numeric_add", "cash_pl"])
	put({ kind: "binary", op: "-" }, ["numeric_sub", "cash_mi"])
	put({ kind: "binary", op: "*" }, [
		"numeric_mul",
		"cash_mul_flt4",
		"cash_mul_flt8",
		"cash_mul_int2",
		"cash_mul_int4",
		"cash_mul_int8",
		"flt4_mul_cash",
		"flt8_mul_cash",
		"int2_mul_cash",
		"int4_mul_cash",
		"int8_mul_cash"
	])

	put({ kind: "binary", op: "/" }, [
		"numeric_div",
		"cash_div_flt4",
		"cash_div_flt8",
		"cash_div_int2",
		"cash_div_int4",
		"cash_div_int8",
		"cash_div_cash"
	])
	put({ kind: "negate" }, ["int2um", "int4um", "int8um", "float4um", "float8um", "numeric_uminus"])

	put({ kind: "binary", op: "||" }, ["textcat"])
	put({ kind: "binary", op: "~" }, ["textregexeq"])
	return table
}

/** The catalogue's operator forms, by oprcode: what the pg test checks against the catalog. */
export const opForms: ReadonlyMap<string, OpForm> = opTable()

/** The connective identities: SQL syntax, not catalog entries. */
const keywordOps = ["and", "or", "not"] as const

/** The constructs spelled by a keyword: the connectives and the registry's constructs. */
type Construct = "and" | "or" | "not" | "least" | "greatest" | "between" | "in"

/** A set's constructs, each of bit's own operators (scalar/compute/registry.ts SqlForm). */
type SetConstruct = "difference" | "subset" | "disjoint"

/**
 * A set construct's SQL over its two operands: the difference `a & ~b`, and the tests `bit_count(a & ~b) = 0` (a is a
 * subset of b) and `bit_count(a & b) = 0` (they are disjoint). The complement sets a's hole and padding bits too, but
 * only beside an AND with a, whose own are clear, so no hole is ever a member of what these deliver.
 */
const setConstruct = (name: SetConstruct, args: ReadonlyArray<Expr>): Expr | undefined => {
	const [a, b] = args
	if (args.length !== 2 || a === undefined || b === undefined) {
		return undefined
	}
	const without = binary("&", a, { kind: "complement", expr: b })
	switch (name) {
		case "difference":
			return without
		case "subset":
			return binary("=", call("bit_count", [without]), lit.int(0n, types.bigint))
		case "disjoint":
			return binary("=", call("bit_count", [binary("&", a, b)]), lit.int(0n, types.bigint))
	}
}

/**
 * A text's suffix test, `right(a, char_length(b)) = b` (scalar/compute/registry.ts textSuffix): PostgreSQL 19 has no
 * ends_with.
 */
const textSuffix = (args: ReadonlyArray<Expr>): Expr | undefined => {
	const [a, b] = args
	return args.length === 2 && a !== undefined && b !== undefined
		? binary("=", call("right", [a, call("char_length", [b])]), b)
		: undefined
}

/**
 * The pattern operand `~` reads in a Compute.matches node's place (ir/expr.ts PatternTable): the ARE of each value
 * the node's pattern can take, never its source, which only grizzle's own automaton reads. A literal pattern is its
 * ARE's literal; any other is `CASE p WHEN '<source>' THEN '<ARE>' ... ELSE p END`, which reads the pattern once,
 * whatever SQL computes it, and whose ELSE keeps an absent C.at's NULL, which the match's reader refuses: every value
 * the pattern takes has its arm.
 */
const patternOperand = (pattern: ScalarExpr | undefined, sql: Expr, table: PatternTable): Expr => {
	if (pattern?.kind === "literal" && pattern.value.kind === "text") {
		const source = pattern.value.value
		const entry = table.find((e) => e.source === source)
		if (entry === undefined) {
			throw defect(`a literal pattern's entry in its node's pattern table: /${source}/`)
		}
		return lit.text(entry.are, types.text)
	}
	return {
		kind: "case",
		operand: sql,
		whens: mapNonEmpty(table, (e) => ({
			when: lit.text(e.source, types.text),
			result: lit.text(e.are, types.text)
		})),
		else: sql
	}
}

/** A construct's SQL form: a connective by its bare identity, or a registry construct by its keyword. */
const keyword = (name: Construct, args: ReadonlyArray<Expr>): Expr | undefined => {
	const [first, second, third] = args
	const [, ...listed] = args
	switch (name) {
		case "and":
			return isNonEmpty(args) ? and(args) : undefined
		case "or":
			return isNonEmpty(args) ? or(args) : undefined
		case "not":
			return args.length === 1 && first !== undefined ? not(first) : undefined
		case "least":
		case "greatest":
			return isNonEmpty(args) ? { kind: name, args } : undefined
		case "between":
			return args.length === 3 && first !== undefined && second !== undefined && third !== undefined
				? { kind: "between", expr: first, low: second, high: third, not: false }
				: undefined
		case "in":
			return first === undefined
				? undefined
				: isNonEmpty(listed)
					? { kind: "inList", expr: first, list: listed, not: false }
					: lit.bool(false)
	}
}

const builtins: ReadonlySet<string> = new Set(builtinFunctionNames)
/** A real check: the set holds exactly the builtin function names. */
const isBuiltin = (name: string): name is BuiltinFunctionName => builtins.has(name)

/**
 * An entry of the Compute catalogue's overload registry (scalar/compute/registry.ts), whose OpIds
 * are the IR's convention: an operator by its oprcode, a function by its regprocedure signature
 * ("round(numeric,integer)"), a construct by its keyword and type ("between:integer"). Extension operators and
 * functions are the vector/ plug-in's, so they are not lowered here.
 *
 * A cast is the IR's own cast node, never an op node.
 */
const registryForm = (id: OpId, args: ReadonlyArray<Expr>): Expr | undefined => {
	const native = nativeOp(id)
	if (native === undefined) {
		return undefined
	}
	const sql = native.sql
	const [first, second] = args
	switch (sql.kind) {
		case "infix":
			return sql.owner === "catalog" &&
				args.length === 2 &&
				first !== undefined &&
				second !== undefined
				? binary(sql.op, first, second)
				: undefined
		case "prefix":
			return args.length === 1 && first !== undefined
				? sql.op === "-"
					? { kind: "negate", expr: first }
					: { kind: "complement", expr: first }
				: undefined
		case "function":
			return sql.owner === "catalog" &&
				isBuiltin(sql.name) &&
				admitsArity(native.operands, args.length)
				? call(sql.name, args)
				: undefined
		case "cast":
			return undefined
		case "between":
		case "in":
		case "least":
		case "greatest":
		case "and":
		case "or":
		case "not":
			return keyword(sql.kind, args)
		case "difference":
		case "subset":
		case "disjoint":
			return setConstruct(sql.kind, args)
		case "endsWith":
			return textSuffix(args)
	}
}

/**
 * A native call's operands as PostgreSQL must read them (registry.ts OperandReading): as they are for an overload that
 * reads values, and each through trim_scale for one that reads the display scale, so the scale it reads is the value's
 * least and its result a function of the operands' values (I2).
 */
const operandsAsRead = (reads: OperandReading, args: ReadonlyArray<Expr>): ReadonlyArray<Expr> => {
	switch (reads) {
		case "value":
			return args
		case "displayScale":
			return args.map((a) => call("trim_scale", [a]))
	}
}

/**
 * The operands of an operator identity as PostgreSQL must read them: through its registry entry's reading, or as they
 * are for a form the registry does not list (a cross-width integer or float operator, a money product), whose operands
 * are no numeric.
 */
const readOperands = (op: OpId, args: ReadonlyArray<Expr>): ReadonlyArray<Expr> => {
	const native = nativeOp(op)
	return native === undefined ? args : operandsAsRead(native.reads, args)
}

/** The connective an operator identity names, if it names one. */
const connectiveOf = (op: OpId): (typeof keywordOps)[number] | undefined =>
	op === "and" ? "and" : op === "or" ? "or" : op === "not" ? "not" : undefined

/**
 * The rendering a Totality states beyond the native form (scalar/compute/registry.ts): an exact overload, or any over
 * an exact operand, in its exact space (total.ts exactForm); an IEEE 754 overload natively where it carries the proof
 * that PostgreSQL's own overload computes it there, and otherwise by its guarded form, its operands bound once where
 * any is compound (total.ts ieeeForm); every other overload natively.
 */
const totalForm = (
	expr: ScalarExpr & { readonly kind: "op" },
	native: NativeOp,
	args: ReadonlyArray<Expr>
): { readonly kind: "rendered"; readonly sql: Expr | undefined } | { readonly kind: "native" } => {
	const exactOperand = [expr.type, ...expr.args.map((a) => a.type)].some((t) => {
		const c = baseOf(t).carrier
		return c === "exactInteger" || c === "exactMoney"
	})
	if (native.totality.kind === "exact" || exactOperand) {
		return { kind: "rendered", sql: exactForm(expr, native, args) }
	}
	if (native.totality.kind !== "ieee") {
		return { kind: "native" }
	}
	const ieee = ieeeForm(expr, args)
	return ieee === undefined
		? { kind: "rendered", sql: undefined }
		: ieee.kind === "native"
			? { kind: "native" }
			: { kind: "rendered", sql: ieee.sql }
}

/**
 * The default operator lowering: an operator form with its exact arity, a connective, or an entry of the overload registry.
 *
 * The default scalar vocabulary of the conservative lowering: the Compute catalogue under the IR's
 * OpId convention, one identity per overload:
 *
 * - an operator: its implementing function, pg_operator.oprcode ("int8pl", "numeric_mul", "texteq");
 * - a function: its regprocedure signature ("abs(bigint)", "round(numeric,integer)");
 * - a construct: its keyword and type ("between:integer", "in:text", "least:numeric", "greatest:bigint"), and the
 *   connectives and, or and not.
 *
 * The operators, including the cross-width integer and float forms the registry does not admit (int48pl, float84lt),
 * are the table below, which a pg test checks against pg_operator on PostgreSQL 19, so a wrong symbol cannot hide
 * here; the connectives are the keyword forms. Functions and constructs resolve only through the overload registry
 * (scalar/compute/registry.ts), whose entries test/pg/compute verifies against pg_proc, so no overload has a
 * second spelling: an IR carrying a non-canonical OpId (a prosrc name, a bare "between") is UnsupportedOperation.
 *
 * Span and vector operations are not here: their lowerings are the span/ and vector/ plug-ins.
 *
 * Every form takes its operands as its overload reads them (operandsAsRead): queries, the DDL of CHECKs and
 * expression indexes, and span fallbacks all lower their scalar expressions here, so no display-scale reading reaches
 * PostgreSQL with an operand it could see a display scale of, and a Compute.matches node's pattern reaches `~` as its
 * ARE (patternOperand).
 */
export const defaultOps = (
	expr: ScalarExpr & { readonly kind: "op" },
	operands: ReadonlyArray<Expr>
): Expr | undefined => {
	const [subject, pattern] = operands
	const args = readOperands(
		expr.op,
		"patterns" in expr && subject !== undefined && pattern !== undefined
			? [subject, patternOperand(expr.args[1], pattern, expr.patterns)]
			: operands
	)
	const native = nativeOp(expr.op)
	if (native !== undefined) {
		const total = totalForm(expr, native, args)
		if (total.kind === "rendered") {
			return total.sql
		}
	}
	/** The operator forms are of overloads their catalog identity alone names. */
	const form = typeof expr.op === "string" ? opForms.get(expr.op) : undefined
	if (form === undefined) {
		const connective = connectiveOf(expr.op)
		return connective === undefined ? registryForm(expr.op, args) : keyword(connective, args)
	}
	const [left, right] = args
	switch (form.kind) {
		case "binary":
			return args.length === 2 && left !== undefined && right !== undefined
				? binary(form.op, left, right)
				: undefined
		case "negate":
			return args.length === 1 && left !== undefined ? { kind: "negate", expr: left } : undefined
	}
}

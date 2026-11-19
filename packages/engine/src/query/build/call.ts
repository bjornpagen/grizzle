import { isPlainRecord } from "#compiler/core/record.ts"
import type { FunctionDesc, FunctionTypeDesc } from "#compiler/ir/desc.ts"
import type { OpenCallArg, OpenExpr, OpenSource } from "#compiler/ir/open.ts"
import { fieldTyping, heading } from "#compiler/query/build/heading.ts"
import { callSourceValue, type SourceInfo, sourceInfo } from "#compiler/query/build/state.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import { predicateExpr, type ScalarTerm, termExpr } from "#compiler/scalar/compute/term.ts"
import { bareEnv, type SqlTag } from "#compiler/scalar/registry.ts"
import { functionDescOf } from "#compiler/schema/function.ts"
import { untypedLiteral } from "#compiler/schema/literal.ts"
import { describedField, malformed } from "#compiler/schema/protocol.ts"
import type {
	CallArgs,
	CalledTerm,
	CallParams,
	CallReads,
	CallSource,
	ExactCallArgs,
	RowsFunction,
	ValueFunction
} from "#compiler/types/compute/call.ts"
import type { Carriers, Facts } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { FunctionType } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"

/**
 * The calls of a declared function (schema/function.ts fn) a query states: Compute.call(f, args), the value of a
 * function that returns a value, a term (ir/desc.ts ExprDesc call), and Compute.rowsOf(f, args), the rows of one that
 * returns rows, a source a rule matches (ir/desc.ts SourceDesc call). Each argument is named as the function declares
 * it, every one of them and none other: a value argument a term, a parameter or a JavaScript value, as a bind map binds
 * a parameter; a rows argument a query or a bound query, whose heading the checker holds to the argument's.
 */

/** A declared function's Description, refused where the value is none fn(...) built. */
const declaredOf = (f: unknown, label: string): FunctionDesc => {
	const desc = functionDescOf(f)
	if (desc === undefined) {
		throw malformed(label, "a declared function built by fn(...)")
	}
	return desc
}

/** The arguments a call passes, each of a name the function declares, every one of them. */
const namedArgs = (
	desc: FunctionDesc,
	args: unknown,
	label: string
): ReadonlyArray<readonly [string, FunctionTypeDesc, unknown]> => {
	if (!isPlainRecord(args)) {
		throw malformed(label, `args: a record of ${desc.name}'s arguments by name`)
	}
	const declared = desc.args.map((a) => a.name)
	const stray = Object.keys(args).filter((a) => !declared.includes(a))
	const missing = declared.filter((a) => !(a in args))
	if (stray.length > 0 || missing.length > 0) {
		throw malformed(
			label,
			`the arguments of function ${desc.name}, ${declared.length === 0 ? "none" : declared.join(", ")}; ${[...missing.map((a) => `${a} is missing`), ...stray.map((a) => `${a} is none of them`)].join(", ")}`
		)
	}
	return desc.args.map((a) => [a.name, a.type, args[a.name]] as const)
}

/** A value argument: a term or a parameter's expression, or a JavaScript value, typed where the checker reads it. */
const valueArgument = (value: unknown, label: string): OpenExpr => {
	const expr = termExpr(value)
	if (expr !== undefined) {
		return expr
	}
	if (predicateExpr(value) !== undefined) {
		throw malformed(label, "a term, a parameter or a literal, not a predicate")
	}
	return { kind: "literal", value: untypedLiteral(value, label) }
}

/** A rows argument: a query or a bound query, its query and its bind map, and where it may be matched. */
const rowsArgument = (
	value: unknown,
	label: string
): {
	readonly info: SourceInfo
	readonly imported: Extract<OpenSource, { readonly kind: "query" }>
} => {
	const info = sourceInfo(value, label, bareEnv)
	if (info.desc.kind !== "query") {
		throw malformed(label, "rows: a query or a bound query, Q.bind({ ... })")
	}
	return { info, imported: info.desc }
}

/**
 * Compute.call(f, args): the value of a declared function that returns a value of a field, immutable or stable, at its
 * arguments, a term of the field's type and carrier.
 */
export const callTerm = <
	const Args extends Readonly<Record<string, FunctionType>>,
	H,
	S extends SqlTag,
	D,
	F extends Facts,
	const A extends CallArgs<Args>
>(
	f: ValueFunction<Args, H, S, D, F>,
	args: A & ExactCallArgs<A, Args>
): CalledTerm<A, H, S, D, F> & ScalarTerm<H, S> => {
	const label = "Compute.call"
	const desc = declaredOf(f, label)
	if (desc.returns.kind !== "value") {
		throw malformed(
			label,
			`a function that returns a value; ${desc.name} returns rows, which Compute.rowsOf calls`
		)
	}
	if (desc.volatility === "volatile") {
		throw malformed(
			label,
			`an immutable or stable function, a term being a function of its operands; ${desc.name} is volatile, which Compute.rowsOf calls`
		)
	}
	const exprs: Record<string, OpenExpr> = {}
	for (const [name, type, value] of namedArgs(desc, args, label)) {
		if (type.kind !== "value") {
			throw malformed(
				label,
				`a function of value arguments; ${desc.name} takes rows at ${name}, which Compute.rowsOf calls`
			)
		}
		exprs[name] = valueArgument(value, `${label} ${name}`)
	}
	const result = describedField(f.returns, `${label} result`)
	return scalarTerm({ kind: "call", function: desc.name, args: exprs }, result.scalar, {
		column: f.returns.column,
		sql: f.returns.sql
	})
}

/**
 * Compute.rowsOf(f, args): the rows a declared function that returns rows of a heading returns at its arguments, a
 * source a rule matches, of the heading's fields, types and carriers.
 */
export const callRows = <
	const Args extends Readonly<Record<string, FunctionType>>,
	Fields extends Readonly<Record<string, FieldBase>> & Carriers,
	const A extends CallArgs<Args>
>(
	f: RowsFunction<Args, Fields>,
	args: A & ExactCallArgs<A, Args>
): CallSource<FactOfFields<Fields>, CallParams<A>, Fields, CallReads<A>> => {
	const label = "Compute.rowsOf"
	const desc = declaredOf(f, label)
	const returned = desc.returns
	if (returned.kind !== "rows") {
		throw malformed(
			label,
			`a function that returns rows; ${desc.name} returns a value, which Compute.call calls`
		)
	}
	const rows: Array<SourceInfo> = []
	const described: Record<string, OpenCallArg> = {}
	for (const [name, type, value] of namedArgs(desc, args, label)) {
		if (type.kind === "value") {
			described[name] = valueArgument(value, `${label} ${name}`)
		} else {
			const rowsArg = rowsArgument(value, `${label} ${name}`)
			rows.push(rowsArg.info)
			described[name] = { kind: "rows", query: rowsArg.imported.query, bind: rowsArg.imported.bind }
		}
	}
	const fields = f.returns.fields
	return callSourceValue(
		{ kind: "call", function: desc.name, args: described },
		heading(
			returned.heading.map((field) => [
				field.name,
				fieldTyping(fields[field.name], field.type, bareEnv)
			]),
			[]
		),
		fields,
		rows,
		`function ${desc.name}`
	)
}

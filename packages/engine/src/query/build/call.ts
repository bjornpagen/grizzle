import { domain, single } from "@bjornpagen/grizzle-text/regex/charset"
import type { Built } from "#compiler/core/phantom.ts"
import { isPlainRecord } from "#compiler/core/record.ts"
import {
	type FieldDesc,
	type FunctionDesc,
	type FunctionTypeDesc,
	functionTypeLabel,
	type NamedDesc,
	valueHeading
} from "#compiler/ir/desc.ts"
import type { OpenCallArg, OpenExpr } from "#compiler/ir/open.ts"
import {
	decodedPathHeading,
	piecesHeading,
	restHeading,
	separatorPoint,
	seriesHeading,
	tokensHeading
} from "#compiler/ir/rel.ts"
import { tokenPattern, wildcardPattern } from "#compiler/ir/scalar.ts"
import { fieldTyping, heading } from "#compiler/query/build/heading.ts"
import {
	callSourceValue,
	descriptorCarriers,
	rowsSource,
	type SourceInfo
} from "#compiler/query/build/state.ts"
import { scalarTerm } from "#compiler/scalar/compute/builders.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import {
	predicateExpr,
	type ScalarTerm,
	termExpr,
	termOf,
	typed
} from "#compiler/scalar/compute/term.ts"
import { exactIntegerDescriptor } from "#compiler/scalar/exact.ts"
import { naturalDescriptor } from "#compiler/scalar/natural.ts"
import { stretchOver } from "#compiler/scalar/regex/stretch.ts"
import { bareEnv, type SqlTag } from "#compiler/scalar/registry.ts"
import { functionDescOf } from "#compiler/schema/function.ts"
import { untypedLiteral } from "#compiler/schema/literal.ts"
import { describedField, malformed, ownedEntry } from "#compiler/schema/protocol.ts"
import { calledFields } from "#compiler/schema/record.ts"
import { type RegexText, regexField } from "#compiler/text/field.ts"
import type {
	CallArgs,
	CalledTerm,
	CallFields,
	CallReads,
	CallSource,
	ExactCallArgs,
	RowFunction,
	RowsFunction,
	ValueFunction
} from "#compiler/types/compute/call.ts"
import type { BindMapParams, Carriers, Facts, Headed } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { FunctionType } from "#compiler/types/schema/function.ts"
import type { FactOfFields } from "#compiler/types/schema/relation.ts"

/**
 * The calls of a declared function (schema/function.ts fn) a query states: Fn.call(f, args), the value of a
 * function that returns a value, a term (ir/desc.ts ExprDesc call); Fn.rows(f, args), the rows of one that
 * returns rows, a source a rule matches (ir/desc.ts SourceDesc call); and Fn.row(f, args), the fields of the one
 * row one returns, each that holds rows of values a source a rule matches (ir/desc.ts SourceDesc callField). Each argument is named as the function declares
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

/**
 * Fn.call(f, args): the value of a declared function that returns a value of a field, immutable or stable, at its
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
	const label = spelling.call
	const desc = declaredOf(f, label)
	if (desc.returns.kind !== "value") {
		throw malformed(
			label,
			`a function that returns a value; ${desc.name} returns ${functionTypeLabel(desc.returns)}`
		)
	}
	if (desc.volatility === "volatile") {
		throw malformed(
			label,
			`an immutable or stable function, a term being a function of its operands; ${desc.name} is volatile, which Fn.rows calls`
		)
	}
	const exprs: Record<string, OpenExpr> = {}
	for (const [name, type, value] of namedArgs(desc, args, label)) {
		if (type.kind !== "value") {
			throw malformed(
				label,
				`a function of value arguments; ${desc.name} takes ${functionTypeLabel(type)} at ${name}`
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
 * The arguments of a call of rows (Fn.rows, Fn.row), each by its declared name: a value argument a term
 * (valueArgument), a rows argument a query or a bound query of values (rowsArgument), whose source infos say where the
 * call may be matched. A rows argument of a heading of rows or of a row, and one of one row, are refused: only another
 * function's body passes one.
 */
const sourceArgs = (
	desc: FunctionDesc,
	args: unknown,
	label: string
): {
	readonly rows: ReadonlyArray<SourceInfo>
	readonly described: Readonly<Record<string, OpenCallArg>>
} => {
	const rows: Array<SourceInfo> = []
	const described: Record<string, OpenCallArg> = {}
	for (const [name, type, value] of namedArgs(desc, args, label)) {
		if (type.kind === "value") {
			described[name] = valueArgument(value, `${label} ${name}`)
		} else if (type.kind === "rows" && valueHeading(type.heading) !== undefined) {
			const rowsArg = rowsSource(value, `${label} ${name}`, bareEnv)
			rows.push(rowsArg.info)
			described[name] = rowsArg.rows
		} else {
			throw malformed(
				`${label} ${name}`,
				`an argument a query passes, a value or rows of values alone; ${desc.name} takes ${functionTypeLabel(type)} at ${name}, which only another function's body passes`
			)
		}
	}
	return { rows, described }
}

/** The heading a call's rows are typed by: each field of a heading of values at its descriptor's typing. */
const rowsHeading = (
	fields: Readonly<Record<string, unknown>>,
	read: ReadonlyArray<NamedDesc<FieldDesc>>
) =>
	heading(
		read.map((field) => [field.name, fieldTyping(fields[field.name], field.type, bareEnv)]),
		[]
	)

/**
 * Fn.rows(f, args): the rows a declared function that returns rows of a heading returns at its arguments, a
 * source a rule matches, of the heading's fields, types and carriers.
 */
export const callRows = <
	const Args extends Readonly<Record<string, FunctionType>>,
	Fields extends Readonly<Record<string, FieldBase>> & Carriers,
	const A extends CallArgs<Args>
>(
	f: RowsFunction<Args, Fields>,
	args: A & ExactCallArgs<A, Args>
): CallSource<FactOfFields<Fields>, BindMapParams<A>, Fields, CallReads<A>> => {
	const label = spelling.rowsOf
	const desc = declaredOf(f, label)
	const returns = desc.returns
	if (returns.kind !== "rows") {
		throw malformed(
			label,
			`a function that returns rows; ${desc.name} returns ${functionTypeLabel(returns)}`
		)
	}
	const returned = valueHeading(returns.heading)
	if (returned === undefined) {
		throw malformed(
			label,
			`a function whose rows hold values alone; a field of ${desc.name}'s rows holds rows or a row, which only another function's body reads`
		)
	}
	const { rows, described } = sourceArgs(desc, args, label)
	const fields = f.returns.fields
	return callSourceValue(
		{ kind: "call", function: desc.name, args: described },
		rowsHeading(fields, returned),
		fields,
		rows,
		`function ${desc.name}`
	)
}

/**
 * Fn.row(f, args): the fields of the one row a declared function of one row returns at its arguments, an
 * immutable or stable one, so every read of them reads one evaluation of the call: each field of the row that holds
 * rows of a heading of values, by its name, a source a rule matches of the heading's fields, types and carriers
 * (ir/desc.ts SourceDesc callField). A field of a value, of one row, or of rows whose heading holds rows or a row is no
 * source, which only another function's body reads.
 */
export const callFields = <
	const Args extends Readonly<Record<string, FunctionType>>,
	Fields extends Readonly<Record<string, FunctionType>>,
	const A extends CallArgs<Args>
>(
	f: RowFunction<Args, Fields>,
	args: A & ExactCallArgs<A, Args>
): CallFields<A, Fields> => {
	const label = spelling.rowOf
	const desc = declaredOf(f, label)
	const returns = desc.returns
	if (returns.kind !== "row") {
		throw malformed(
			label,
			`a function that returns one row; ${desc.name} returns ${functionTypeLabel(returns)}`
		)
	}
	if (desc.volatility === "volatile") {
		throw malformed(
			label,
			`an immutable or stable function, whose one evaluation at its arguments every read of its row's fields shares; ${desc.name} is volatile`
		)
	}
	const { rows, described } = sourceArgs(desc, args, label)
	const fields: Readonly<Record<string, unknown>> = f.returns.heading.fields
	return calledFields<A, Fields>(
		returns.heading.flatMap((field) => {
			const read = field.type.kind === "rows" ? valueHeading(field.type.heading) : undefined
			const held = ownedEntry(fields[field.name], "rows")
			if (read === undefined || held === undefined) {
				return []
			}
			const descriptors: Readonly<Record<string, unknown>> = held.value.fields
			const carriers = descriptorCarriers(descriptors, `${label} ${field.name}`)
			return [
				[
					field.name,
					callSourceValue(
						{ kind: "callField", function: desc.name, args: described, field: field.name },
						rowsHeading(descriptors, read),
						carriers,
						rows,
						`field ${field.name} of function ${desc.name}`
					)
				] as const
			]
		})
	)
}

/**
 * A token's descriptor as the builder types a token split's `token` (tokensRows): a run of no XML whitespace, the
 * token pattern's text. The checker types it as a run of its text's characters but XML whitespace, within its text's
 * byte bound where its text has one (check/checker.ts #tokenType).
 */
const tokenField = regexField<string>(tokenPattern.source, [])

/** A token split's heading's descriptors: each token's place, a natural, and the token (tokenField). */
const tokenCarriers = Object.freeze({ at: naturalDescriptor, token: tokenField })

/**
 * r.tokens(text): the tokens of a whitespace-separated list, a source a rule matches as it matches a call's rows, of
 * `tokensHeading`: `at`, each token's place from 0, and `token`, its run of no XML whitespace, the text collapsed and
 * split at its spaces (ir/rel.ts CallFunction `tokens`). `text` is a term, a parameter or a JavaScript value, as a
 * call's value argument is (`valueArgument`), which the checker holds to a text.
 */
export const tokensRows = (text: unknown): Built & Headed<typeof tokenCarriers> => {
	const label = "r.tokens"
	return callSourceValue(
		{
			kind: "split",
			split: { kind: "tokens" },
			args: { text: valueArgument(text, `${label} text`) }
		},
		heading(
			[
				[tokensHeading.at, typed(describedField(naturalDescriptor, `${label} at`).scalar)],
				[tokensHeading.token, typed(describedField(tokenField, `${label} token`).scalar)]
			],
			[]
		),
		tokenCarriers,
		[],
		"a text's tokens"
	)
}

/**
 * A piece's descriptor as the builder types a separator split's `piece` over a separator of code point `point`
 * (piecesRows): a stretch of any characters but the separator, the pattern the checker types it by over any text
 * (scalar/regex/stretch.ts stretchSource), which types it within its text's byte bound and alphabet too.
 */
const pieceField = (point: number): RegexText<string> =>
	regexField<string>(stretchOver(domain, single(point)).source, [])

/**
 * r.split(text, separator): the pieces of a text between the occurrences of its separator, a source a rule matches as
 * it matches a call's rows, of `piecesHeading`: `at`, each piece's place from 0, and `piece`, a text that holds no
 * separator, n occurrences giving n + 1 pieces, the empty ones kept, so the empty text is one empty piece (ir/rel.ts
 * TextSplit `pieces`). `text` is a term, a parameter or a JavaScript value, as a call's value argument is
 * (`valueArgument`), which the checker holds to a text; `separator` is a JavaScript string of one Unicode scalar value
 * but U+0000 (separatorPoint), the split's own constant, never an argument.
 */
export const piecesRows = (
	text: unknown,
	separator: unknown
): Built & Headed<{ readonly at: typeof naturalDescriptor; readonly piece: RegexText<string> }> => {
	const label = "r.split"
	const point = typeof separator === "string" ? separatorPoint(separator) : undefined
	if (typeof separator !== "string" || point === undefined) {
		throw malformed(
			`${label} separator`,
			"a string of one Unicode scalar value but U+0000, the character the text is split at"
		)
	}
	const piece = pieceField(point)
	return callSourceValue(
		{
			kind: "split",
			split: { kind: "pieces", separator },
			args: { text: valueArgument(text, `${label} text`) }
		},
		heading(
			[
				[piecesHeading.at, typed(describedField(naturalDescriptor, `${label} at`).scalar)],
				[piecesHeading.piece, typed(describedField(piece, `${label} piece`).scalar)]
			],
			[]
		),
		Object.freeze({ at: naturalDescriptor, piece }),
		[],
		"a text's pieces"
	)
}

/** A rest's descriptor as the builder types it (restRows): any text, the checker typing it within its text's bound. */
const restField = regexField<string>(wildcardPattern.source, ["su"])

/** A rest's heading's descriptors: the text after the prefix (restField). */
const restCarriers = Object.freeze({ rest: restField })

/**
 * r.rest(text, prefix): the text after a prefix, a source a rule matches as it matches a call's rows, of `restHeading`:
 * one fact, `rest`, the text's code points past the prefix's, where the text starts with the prefix, and none where it
 * does not (ir/rel.ts TextSplit `rest`), so a rule that matches it keeps only the bindings whose text has the prefix.
 * `text` and `prefix` are each a term, a parameter or a JavaScript value, as a call's value argument is
 * (`valueArgument`), which the checker holds to a text.
 */
export const restRows = (text: unknown, prefix: unknown): Built & Headed<typeof restCarriers> => {
	const label = "r.rest"
	return callSourceValue(
		{
			kind: "split",
			split: { kind: "rest" },
			args: {
				text: valueArgument(text, `${label} text`),
				prefix: valueArgument(prefix, `${label} prefix`)
			}
		},
		heading([[restHeading.rest, typed(describedField(restField, `${label} rest`).scalar)]], []),
		restCarriers,
		[],
		"the rest of a text"
	)
}

/** A decoded path's heading's descriptors: the path its text spells, any text (restField), typed as its text's bound. */
const decodedPathCarriers = Object.freeze({ path: restField })

/**
 * r.decodedPath(text): the path a percent-encoded URI path spells (RFC 3986 §2.1, §2.5), a source a rule matches as it
 * matches a call's rows, of `decodedPathHeading`: one fact, `path`, each `%HH` its octet and every other character its
 * own, the octets read as UTF-8, where the text spells a path, and none where a `%` begins no `%HH`, the escaped octets
 * are no UTF-8, an escape decodes to U+0000 or `/`, or a segment made of dots alone holds one written `%2E` (ir/rel.ts
 * TextSplit `decodedPath`). `text` is a term, a parameter or a JavaScript value, as a call's value argument is
 * (`valueArgument`), which the checker holds to a text.
 */
export const decodedPathRows = (text: unknown): Built & Headed<typeof decodedPathCarriers> => {
	const label = "r.decodedPath"
	return callSourceValue(
		{
			kind: "split",
			split: { kind: "decodedPath" },
			args: { text: valueArgument(text, `${label} text`) }
		},
		heading(
			[[decodedPathHeading.path, typed(describedField(restField, `${label} path`).scalar)]],
			[]
		),
		decodedPathCarriers,
		[],
		"the path a text spells"
	)
}

/**
 * An end of r.series: a term, a parameter or a typed constant of an integer type, which the checker lowers in the rule's
 * scope (check/checker.ts Checker.series); a JavaScript value, which has no type of its own and meets no term here, is
 * refused.
 */
const seriesEnd = (value: unknown, label: string) => {
	const term = termOf(value)
	if (term === undefined) {
		throw malformed(
			label,
			"a term, a parameter or a typed constant of an integer type, not a JavaScript value"
		)
	}
	return term
}

/** A series' heading's descriptors: each element, an exact integer, as integer arithmetic counts. */
const seriesCarriers = Object.freeze({ at: exactIntegerDescriptor })

/**
 * r.series(low, high): each integer from `low` to `high`, both included, a source a rule matches as it matches a call's
 * rows, of `seriesHeading`, `at` each integer, an exact integer, none where `low` lies above `high` (ir/rel.ts
 * CallFunction `series`). Each end is a term of the rule's scope (seriesEnd), and every element lies between the least
 * value `low` takes and the greatest `high` takes, which a term of the rule reads of it (check/checker.ts
 * Checker.series).
 */
export const seriesRows = (low: unknown, high: unknown): Built & Headed<typeof seriesCarriers> => {
	const label = "r.series"
	return callSourceValue(
		{
			kind: "series",
			low: seriesEnd(low, `${label} low`).expr,
			high: seriesEnd(high, `${label} high`).expr
		},
		heading(
			[[seriesHeading.at, typed(describedField(exactIntegerDescriptor, `${label} at`).scalar)]],
			[]
		),
		seriesCarriers,
		[],
		"a series"
	)
}

import { Array as Arr, Option, pipe, Predicate, Record as Rec, Result, String as Str } from "effect"
import { taggedValueOf } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { MoneyText, moneyTag, VectorText, vectorTag } from "#compiler/ir/carriers.ts"
import { decimalPayload, isDecimalLike } from "#compiler/ir/decimal.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import type { Expr, LiteralValue } from "#compiler/sql/ast.ts"
import { cast, lit, types } from "#compiler/sql/build.ts"
import type { ColumnType } from "#test/support/oracle/install/model.ts"

import { regex } from "arkregex"
const integerRanges = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-9223372036854775808n, 9223372036854775807n]
} as const

const refuse = (
	location: string,
	expected: string,
	value: unknown
): Result.Result<never, CompileError> =>
	Result.fail(
		malformedDescription(
			SourceLoc(location, []),
			`a fact value of type ${expected}, not ${describe(value)}`
		)
	)

/** A short, value-free description of what was supplied: diagnostics never carry fact values. */
const describe = (value: unknown): string => {
	if (typeof value === "number") {
		return Number.isInteger(value) ? "an integer number" : "a number"
	}
	if (Arr.isArray(value)) {
		return "an array"
	}
	if (value === null) {
		return "null"
	}
	return `a ${typeof value}`
}

const exactDecimal = regex("^-?[0-9]+(\\.[0-9]+)?$")
const uuidText = regex(
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

const literal = (value: LiteralValue, type: ColumnType): Expr => ({
	kind: "literal",
	value,
	type: type.sql
})

const integerOf = (value: unknown): bigint | undefined => {
	if (typeof value === "bigint") {
		return value
	}
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return BigInt(value)
	}
	return undefined
}

/**
 * Every property of an object reads as some value, which `unknown` describes, so this claims no more than it checks.
 */
const isReadable = (value: unknown): value is Readonly<Record<string, unknown>> =>
	Predicate.isObject(value)

const spanEndpoints = (
	value: unknown
): { readonly start: unknown; readonly end: unknown } | undefined => {
	if (!isReadable(value) || Arr.isArray(value)) {
		return undefined
	}
	const inner = Rec.has(value, "span") ? value["span"] : value
	if (!isReadable(inner) || !Rec.has(inner, "start") || !Rec.has(inner, "end")) {
		return undefined
	}
	return { start: inner["start"], end: inner["end"] }
}

const floatSpecials = {
	NaN: Number.NaN,
	Infinity: Number.POSITIVE_INFINITY,
	"-Infinity": Number.NEGATIVE_INFINITY
} as const

const floatOf = (value: unknown): number | undefined => {
	if (typeof value === "number") {
		return value
	}
	if (isReadable(value) && Rec.has(value, "float")) {
		const special = value["float"]
		if (special === "NaN" || special === "Infinity" || special === "-Infinity") {
			return floatSpecials[special]
		}
	}
	return undefined
}

/**
 * Money minor units as the exact numeric text of the major amount, two fraction digits: money travels
 * as numeric and is cast, so its input never depends on lc_monetary's grouping or symbol.
 */
export const moneyText = (minorUnits: bigint): string => {
	const negative = minorUnits < 0n
	const magnitude = negative ? -minorUnits : minorUnits
	const fraction = pipe((magnitude % 100n).toString(), Str.padStart(2, "0"))
	return `${negative ? "-" : ""}${magnitude / 100n}.${fraction}`
}

/**
 * A stored value's twin input spelling (gen/domain.ts Spelled): a text its column type's input function reads as the
 * value and stores differently from the canonical one, a padded numeric's display scale, a float's or a vector
 * component's -0. The loader writes it as that text, so the database holds the spelling the case drew.
 */
export class InputSpelling {
	readonly text: string

	constructor(text: string) {
		this.text = text
	}
}

/** The SQL literal of a twin spelling for a column of `type`: a decimal, a float or a vector text, as drawn. */
const spelledLiteral = (
	type: ColumnType,
	spelling: InputSpelling,
	location: string
): Result.Result<Expr, CompileError> => {
	switch (type.value.kind) {
		case "numeric":
			return exactDecimal.test(spelling.text)
				? Result.succeed(literal({ kind: "decimal", value: spelling.text }, type))
				: refuse(location, "numeric (an exact decimal spelling)", spelling.text)
		case "float":
			return Result.succeed(lit.float(Number(spelling.text), type.sql))
		case "vector":
			return Result.succeed(literal({ kind: "text", value: spelling.text }, type))
		case "integer":
		case "money":
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "span":
			return refuse(location, `${type.value.kind}, which has no twin spelling`, spelling.text)
	}
}

/**
 * Typed SQL literals for oracle facts, for the loader's typed literal INSERTs.
 *
 * A fact value is the host value a Description carries (LiteralDesc): a JavaScript number for smallint,
 * integer, real and double precision; a bigint for bigint; a Decimal, a bigint or an exact decimal string for numeric,
 * never a JavaScript number; a Money for money; a boolean; a string for text, uuid and enum handles; a span
 * { start, end } (or the Description's { span: { start, end } }); a Vector; and { float: "NaN" | ... } beside the
 * plain float specials. Each becomes one SQL AST literal typed by its column's type, so the printer casts it
 * and the statement audit checks it. Nothing is coerced on the host: a value outside its type is
 * refused with the column's location, and PostgreSQL's own input function decides everything else (numeric typmod
 * rounding, float4 rounding of an exact binary32 value, enum membership). A value is written in its canonical form,
 * or, as an InputSpelling, in the twin spelling its case drew: "1.000" stays a padded numeric text, -0 stays -0, so the
 * database holds the spellings no answer may depend on; supplementary-plane text passes through unchanged.
 *
 * The SQL literal of one fact value for a column of `type`.
 *
 * A real value is an exact binary32 value; its shortest double spelling reads back as itself.
 */
export const literalFor = (
	type: ColumnType,
	value: unknown,
	location: string
): Result.Result<Expr, CompileError> => {
	if (value instanceof InputSpelling) {
		return spelledLiteral(type, value, location)
	}
	const v = type.value
	switch (v.kind) {
		case "integer": {
			const n = integerOf(value)
			const [min, max] = integerRanges[v.carrier]
			if (n === undefined || n < min || n > max) {
				return refuse(location, v.carrier, value)
			}
			return Result.succeed(literal({ kind: "int", value: n }, type))
		}
		case "numeric": {
			const text: Option.Option<string> =
				typeof value === "bigint"
					? Option.some(value.toString())
					: isDecimalLike(value)
						? Option.some(decimalPayload(value))
						: typeof value === "string" &&
							  (exactDecimal.test(value) ||
									value === "NaN" ||
									value === "Infinity" ||
									value === "-Infinity")
							? Option.some(value)
							: Option.none()
			return Option.match(text, {
				onNone: () =>
					refuse(location, "numeric (a Decimal, bigint or exact decimal string)", value),
				onSome: (payload) => Result.succeed(literal({ kind: "decimal", value: payload }, type))
			})
		}
		case "float": {
			const x = floatOf(value)
			if (x === undefined) {
				return refuse(location, v.carrier, value)
			}
			if (v.carrier === "float4" && !Number.isNaN(x) && Math.fround(x) !== x) {
				return refuse(location, "float4 (an exact binary32 value)", value)
			}
			return Result.succeed(lit.float(x, type.sql))
		}
		case "money": {
			const tagged = taggedValueOf(value)
			const money = tagged?.tag === moneyTag ? MoneyText.parse(tagged.payload) : undefined
			if (money === undefined) {
				return refuse(location, "money (a Money value)", value)
			}
			const amount: Expr = {
				kind: "literal",
				value: { kind: "decimal", value: moneyText(money.minorUnits) },
				type: types.numeric
			}
			return Result.succeed(cast(amount, type.sql))
		}
		case "bool":
			if (typeof value !== "boolean") {
				return refuse(location, "boolean", value)
			}
			return Result.succeed(literal({ kind: "bool", value }, type))
		case "uuid":
			if (typeof value !== "string" || !uuidText.test(value)) {
				return refuse(location, "uuid (hyphenated hex text)", value)
			}
			return Result.succeed(literal({ kind: "text", value }, type))
		case "text":
			if (typeof value !== "string" || Str.includes("\u0000")(value) || !value.isWellFormed()) {
				return refuse(location, "text (well-formed, without NUL)", value)
			}
			return Result.succeed(literal({ kind: "text", value }, type))
		case "enum":
			if (typeof value !== "string" || !v.labels.includes(value)) {
				return refuse(location, `a handle of ${v.closed}`, value)
			}
			return Result.succeed(literal({ kind: "text", value }, type))
		case "span": {
			const endpoints = spanEndpoints(value)
			const start = integerOf(endpoints?.start)
			const end = integerOf(endpoints?.end)
			const [min, max] = integerRanges[v.carrier === "range4" ? "int4" : "int8"]
			if (start === undefined || end === undefined || start < min || end > max || !(start < end)) {
				return refuse(
					location,
					`a nonempty bounded ${v.carrier === "range4" ? "int4range" : "int8range"} span`,
					value
				)
			}
			return Result.succeed(literal({ kind: "text", value: `[${start},${end})` }, type))
		}
		case "vector": {
			/** A host Vector is its Float32Array; a Description's literal is its canonical payload. */
			const canonical = isVector(value) ? Vector.canonical(value) : undefined
			const described = taggedValueOf(value)
			const vector =
				canonical === undefined
					? described?.tag === vectorTag
						? VectorText.parse(described.payload)
						: undefined
					: canonical.ok
						? canonical.value
						: undefined
			if (vector === undefined) {
				return refuse(location, `vector(${v.dimensions}) (a Vector value)`, value)
			}
			if (vector.components.length !== v.dimensions) {
				return refuse(location, `vector(${v.dimensions})`, value)
			}
			return Result.succeed(literal({ kind: "text", value: vector.toString() }, type))
		}
	}
}

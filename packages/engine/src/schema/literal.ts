import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { validateText } from "#compiler/core/text.ts"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { toDouble, toReal } from "#compiler/scalar/values/float.ts"
import { toInt2, toInt4, toInt8 } from "#compiler/scalar/values/integer.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { isPlainRecord, malformed } from "#compiler/schema/protocol.ts"

/**
 * A float literal: the special values wrapped, every finite value through its type's normalization, toReal for a
 * real (binary32 rounding, overflow and underflow refused) and toDouble for double precision (-0 as +0).
 */
const float = (
	value: unknown,
	normalize: (x: unknown) => Result.Result<number, ValueFault>
): Result.Result<LiteralDesc, ValueFault> => {
	if (typeof value !== "number") {
		return Result.err("floatType")
	}
	if (Number.isNaN(value)) {
		return Result.ok({ float: "NaN" })
	}
	if (value === Number.POSITIVE_INFINITY) {
		return Result.ok({ float: "Infinity" })
	}
	if (value === Number.NEGATIVE_INFINITY) {
		return Result.ok({ float: "-Infinity" })
	}
	return normalize(value)
}

/**
 * The integer carrier a descriptor's values travel as: "int4" for smallint and integer (a JavaScript number in
 * range), "int8" for bigint (a JavaScript bigint), through contracts and serial generation.
 */
const integerKind = (desc: FieldDesc): "int2" | "int4" | "int8" | undefined => {
	switch (desc.kind) {
		case "contract":
			return integerKind(desc.base)
		case "pg":
			return desc.type === "smallint"
				? "int2"
				: desc.type === "integer"
					? "int4"
					: desc.type === "bigint"
						? "int8"
						: undefined
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
		case "bits":
		case "span":
		case "vector":
			return undefined
	}
}

/**
 * A set over a roster as its literal: its handles in the roster's declared order, each once. `roster` is the roster's
 * handles when the host descriptor carries them; undefined keeps the set's own order, which the checker holds to the
 * roster's.
 */
const bitsLiteral = (
	value: unknown,
	roster: ReadonlyArray<string> | undefined
): Result.Result<LiteralDesc, ValueFault> => {
	if (!(value instanceof Set)) {
		return Result.err("bitsType")
	}
	const members: ReadonlyArray<unknown> = [...value]
	const handles: Array<string> = []
	for (const m of members) {
		if (typeof m !== "string" || (roster !== undefined && !roster.includes(m))) {
			return Result.err("bitsMember")
		}
		handles.push(m)
	}
	return Result.ok({
		handles: roster === undefined ? handles : roster.filter((h) => handles.includes(h))
	})
}

const span = (endpoint: FieldDesc, value: unknown): Result.Result<LiteralDesc, ValueFault> => {
	if (!isPlainRecord(value)) {
		return Result.err("spanType")
	}
	const keys = Object.keys(value)
	if (keys.length !== 2 || !Object.hasOwn(value, "start") || !Object.hasOwn(value, "end")) {
		return Result.err("spanType")
	}
	if (integerKind(endpoint) === "int8") {
		const start = toInt8(value["start"])
		const end = toInt8(value["end"])
		if (!start.ok || !end.ok) {
			return Result.err("spanEndpoint")
		}
		if (!(start.value < end.value)) {
			return Result.err("spanOrder")
		}
		return Result.ok({ span: { start: start.value, end: end.value } })
	}
	const start = toInt4(value["start"])
	const end = toInt4(value["end"])
	if (!start.ok || !end.ok) {
		return Result.err("spanEndpoint")
	}
	if (!(start.value < end.value)) {
		return Result.err("spanOrder")
	}
	return Result.ok({ span: { start: start.value, end: end.value } })
}

/** A vector literal: the Description holds the frozen canonical payload of the buffer's components (Vector.canonical). */
const vector = (
	desc: FieldDesc & { readonly kind: "vector" },
	value: unknown
): Result.Result<LiteralDesc, ValueFault> =>
	Result.flatMap(Vector.admit(value, desc.dimensions), Vector.canonical)

/** A literal of a PostgreSQL scalar type: the host value its carrier admits. */
const pgLiteral = (
	type: Extract<FieldDesc, { readonly kind: "pg" }>["type"],
	value: unknown
): Result.Result<LiteralDesc, ValueFault> => {
	switch (type) {
		case "smallint":
			return toInt2(value)
		case "integer":
			return toInt4(value)
		case "bigint":
			return toInt8(value)
		case "real":
			return float(value, toReal)
		case "double precision":
			return float(value, toDouble)
		case "money":
			return value instanceof Money ? Result.ok(value) : Result.err("moneyType")
		case "boolean":
			return typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")
	}
}

/**
 * `roster` is the handles of the closed relation a closedId descriptor references, when the host descriptor carries
 * them; undefined admits any handle, which the checker resolves against the schema. A handle outside the roster is
 * refused at the builder that knows the roster; ownership checks every description's handles, a decoded one's
 * included (schema/own.ts).
 */
export const literalResult = (
	desc: FieldDesc,
	value: unknown,
	roster: ReadonlyArray<string> | undefined
): Result.Result<LiteralDesc, ValueFault> => {
	switch (desc.kind) {
		case "contract":
			return literalResult(desc.base, value, roster)
		case "pg":
			return pgLiteral(desc.type, value)
		case "numeric": {
			const parsed = Decimal.parse(value)
			if (!parsed.ok) {
				return parsed
			}
			return normalizeNumeric(parsed.value, { precision: desc.precision, scale: desc.scale })
		}
		case "uuid":
			return toUuid(value)
		case "text":
			return validateText(value)
		case "closedId":
			if (typeof value !== "string") {
				return Result.err("codeHandle")
			}
			if (roster !== undefined && !roster.includes(value)) {
				return Result.err("codeHandle")
			}
			return Result.ok(value)
		case "bits":
			return bitsLiteral(value, roster)
		case "span":
			return span(desc.endpoint, value)
		case "vector":
			return vector(desc, value)
	}
}

/**
 * Host values to literals, by field descriptor.
 *
 * A closed relation's payload facts, a selection's bindings, and a row check's literal operands are host values
 * written against a field. Each becomes a LiteralDesc (ir/desc.ts) here, checked at construction for its host
 * representation: a JavaScript number is never a numeric literal (an exact decimal string is parsed into its
 * Decimal), integers are integers in their type's signed range, a real is the binary32 value PostgreSQL's float4 input
 * stores (overflow and underflow refused), a numeric(p, s) is rounded to its scale and refused above its precision, as
 * the column's typmod would, a uuid takes its canonical lowercase spelling, text is
 * storable, a handle belongs to the roster when the roster is known, a span is nonempty over its endpoint type, a
 * vector matches its dimensions, and the float special values travel wrapped. A literal compared with or
 * written into a contract term is a literal of its base and adopts the contract, so a contract
 * contributes its base here; whether the value satisfies the contract's predicate or regex is the checker's
 * ContractLiteral judgment at compilation, never the host's.
 *
 * The throwing form, for builders: a literal of the wrong host kind is MalformedDescription naming what is needed.
 */
export const literalFor = (
	desc: FieldDesc,
	value: unknown,
	label: string,
	roster: ReadonlyArray<string> | undefined
): LiteralDesc => {
	const literal = literalResult(desc, value, roster)
	if (!literal.ok) {
		throw malformed(label, describeFault(literal.error))
	}
	return literal.value
}

/**
 * A literal with no descriptor to adopt: an operand of a term whose type this package does not know (a Compute
 * expression of another package). The host kind alone decides; the checker types it against the term it meets.
 */
export const untypedLiteral = (value: unknown, label: string): LiteralDesc => {
	switch (typeof value) {
		case "bigint":
		case "boolean":
			return value
		case "number": {
			const result = float(value, toDouble)
			if (result.ok) {
				return result.value
			}
			break
		}
		case "string": {
			const text = validateText(value)
			if (text.ok) {
				return text.value
			}
			throw malformed(label, describeFault(text.error))
		}
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			break
	}
	if (value instanceof Decimal || value instanceof Money) {
		return value
	}
	if (isVector(value)) {
		const canonical = Vector.canonical(value)
		if (canonical.ok) {
			return canonical.value
		}
		throw malformed(label, describeFault(canonical.error))
	}
	if (isPlainRecord(value) && Object.hasOwn(value, "start") && Object.hasOwn(value, "end")) {
		const { start, end } = value
		if (typeof start === "bigint" && typeof end === "bigint" && start < end) {
			return { span: { start, end } }
		}
		if (
			typeof start === "number" &&
			typeof end === "number" &&
			Number.isInteger(start) &&
			Number.isInteger(end) &&
			start < end
		) {
			return { span: { start, end } }
		}
	}
	throw malformed(
		label,
		"a literal: a number, bigint, boolean, string, Decimal, Money, Vector or span"
	)
}

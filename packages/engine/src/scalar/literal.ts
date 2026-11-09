import type { ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import { validateText } from "#compiler/core/text.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { baseOf, type Roster, type ScalarType } from "#compiler/ir/scalar.ts"
import { statedRoster } from "#compiler/scalar/values/bits.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { unreadableOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { toUuid } from "#compiler/scalar/values/uuid.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value)

/**
 * A literal operand for a term of type `t`, as the Description boundary carries it (ir/desc.ts LiteralDesc): the
 * host value of t's base, since a literal compared with or written into a contract term adopts the contract.
 * The host representation is checked here, at construction: a JavaScript number is never a
 * numeric literal, an exact decimal string is parsed into its Decimal, a uuid takes its canonical lowercase spelling,
 * text must be storable, a handle must be in the roster, a vector must have the type's dimensions, and the
 * float specials travel wrapped. Ranges, typmods and refinements are the checker's: a value that is the right kind
 * but does not fit is ContractLiteral or MalformedDescription at compilation. The value is read once through hostRead:
 * reading it can run the caller's code (a proxy's traps, a getter), and a value whose reading throws is refused by its
 * carrier's host-type fault, as admission refuses it (values/identity.ts).
 */
export const literalDescFor = (
	t: ScalarType,
	value: unknown
): Result.Result<LiteralDesc, ValueFault> => {
	const base = baseOf(t)
	return hostRead(unreadableOf[base.carrier], () => hostLiteral(base, value))
}

/**
 * The literal of a base type `base` for the caller's `value`, which literalDescFor reads through hostRead.
 *
 * The Description holds the frozen canonical payload of the buffer's components now (Vector.canonical).
 *
 * A JavaScript integer: a fraction or an unsafe integer is the wrong host kind, as in Compute.
 */
const hostLiteral = (base: ScalarType, value: unknown): Result.Result<LiteralDesc, ValueFault> => {
	switch (base.carrier) {
		case "int2":
		case "int4":
			return isSafeInteger(value) ? Result.ok(value === 0 ? 0 : value) : Result.err("integerType")
		case "int8":
			return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")
		case "numeric":
			if (typeof value === "number") {
				return Result.err("decimalNumber")
			}
			return Decimal.parse(value)
		case "float4":
		case "float8":
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
			return Result.ok(value === 0 ? 0 : value)
		case "money":
			return value instanceof Money ? Result.ok(value) : Result.err("moneyType")
		case "bool":
			return typeof value === "boolean" ? Result.ok(value) : Result.err("boolType")
		case "uuid":
			return toUuid(value)
		case "date":
			return toCalendarDate(value)
		case "text":
			return validateText(value)
		case "bytes":
			return Result.err("bytesLiteral")
		case "code":
			return typeof value === "string" && base.roster.handles.includes(value)
				? Result.ok(value)
				: Result.err("codeHandle")
		case "bits":
			return bitsLiteral(value, base.roster)
		case "range4":
		case "range8":
		case "rangeDate": {
			if (!hasProperties(value) || isList(value)) {
				return Result.err("spanType")
			}
			const keys = Object.keys(value)
			if (keys.length !== 2 || !Object.hasOwn(value, "start") || !Object.hasOwn(value, "end")) {
				return Result.err("spanType")
			}
			const { start, end } = value
			const ok = (x: unknown): x is number | bigint | CalendarDate =>
				base.carrier === "range4"
					? isSafeInteger(x)
					: base.carrier === "range8"
						? typeof x === "bigint"
						: toCalendarDate(x).ok
			if (!ok(start) || !ok(end)) {
				return Result.err("spanEndpoint")
			}
			return Result.ok({ span: { start, end } })
		}
		case "vector":
			return Result.flatMap(Vector.admit(value, base.typmod.dims), Vector.canonical)
		case "exactInteger":
			return typeof value === "bigint" ? Result.ok(value) : Result.err("integerType")
		case "exactMoney":
			return value instanceof Money ? Result.ok(value) : Result.err("moneyType")
	}
}

/**
 * A set's literal: a Set whose members are each a handle of the roster, as its handles in the roster's declared order,
 * so one set has one literal. A value that is no Set, or holds a member that is no string, is bitsType; a string the
 * roster does not hold, or a set Bits.of made over another roster, whose handles are that roster's whatever their
 * names, is bitsMember.
 */
const bitsLiteral = (value: unknown, roster: Roster): Result.Result<LiteralDesc, ValueFault> => {
	if (!(value instanceof Set)) {
		return Result.err("bitsType")
	}
	const stated = statedRoster(value)
	if (stated !== undefined && stated !== roster.closed) {
		return Result.err("bitsMember")
	}
	const members: ReadonlyArray<unknown> = Array.from(value)
	if (!members.every((member) => typeof member === "string")) {
		return Result.err("bitsType")
	}
	if (!members.every((member) => roster.handles.includes(member))) {
		return Result.err("bitsMember")
	}
	return Result.ok({
		handles: Object.freeze(roster.handles.filter((handle) => members.includes(handle)))
	})
}

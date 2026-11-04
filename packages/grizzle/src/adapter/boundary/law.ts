import { Schema } from "effect"
import { exact } from "#adapter/boundary/exact.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import type { Law, LawSide, LawValue } from "#compiler/types/changeset/changeset.ts"

const isDecimal = (u: unknown): u is Decimal => u instanceof Decimal
const isMoney = (u: unknown): u is Money => u instanceof Money

/**
 * A float's special value, NaN or an infinity: a selection over a float field may name one (analysis/theory
 * description.ts lawValue reads a floatSpecial literal as the host holds it), so a law's number is finite or one of
 * these.
 */
const FloatSpecialSchema = Schema.declare(
	(u: unknown): u is number => typeof u === "number" && !Number.isFinite(u),
	{
		expected: "NaN, Infinity or -Infinity"
	}
)

/**
 * A selection's literal, as the host holds it (types/changeset LawValue): a number is an integer's or a float's value,
 * and a span of numbers is over integer, its bounds integers.
 */
const LawValueSchema = exact<LawValue>()(
	Schema.Union([
		Schema.String,
		Schema.Finite,
		FloatSpecialSchema,
		Schema.BigInt,
		Schema.Boolean,
		Schema.declare(isDecimal, { expected: "Decimal" }),
		Schema.declare(isMoney, { expected: "Money" }),
		Schema.Struct({ start: Schema.Int, end: Schema.Int }),
		Schema.Struct({ start: Schema.BigInt, end: Schema.BigInt }),
		Schema.declare(isVector, { expected: "Vector" })
	])
)

const LawSideSchema = exact<LawSide>()(
	Schema.Struct({
		relation: Schema.String,
		fields: Schema.NonEmptyArray(Schema.String),
		selection: Schema.Array(Schema.Struct({ field: Schema.String, value: LawValueSchema }))
	})
)

const RefSchema = Schema.Struct({ ref: Schema.String })

/**
 * The engine's Law (types/changeset), as a field of an error class that names a law: exactly that union, so the two
 * cannot drift apart.
 */
export const LawSchema = exact<Law>()(
	Schema.Union([
		Schema.Struct({
			kind: Schema.Literals(["primaryKey", "key"]),
			relation: Schema.String,
			fields: Schema.Array(Schema.String)
		}),
		Schema.Struct({ kind: Schema.Literal("check"), relation: Schema.String, name: Schema.String }),
		Schema.Struct({
			kind: Schema.Literals(["contained", "mirrors"]),
			from: LawSideSchema,
			to: LawSideSchema
		}),
		Schema.Struct({
			kind: Schema.Literal("coverage"),
			statement: Schema.Literals(["contained", "mirrors"]),
			from: LawSideSchema,
			to: LawSideSchema
		}),
		Schema.Struct({
			kind: Schema.Literal("alternatives"),
			relation: Schema.String,
			field: Schema.String
		}),
		Schema.Struct({
			kind: Schema.Literal("capacity"),
			target: LawSideSchema,
			from: LawSideSchema,
			weight: Schema.Union([
				Schema.Struct({ kind: Schema.Literal("count") }),
				Schema.Struct({ kind: Schema.Literals(["field", "duration"]), field: Schema.String })
			]),
			within: Schema.Struct({
				low: Schema.Union([Schema.BigInt, RefSchema]),
				high: Schema.Union([Schema.BigInt, RefSchema, Schema.Literal("*")])
			})
		}),
		Schema.Struct({ kind: Schema.Literal("contract"), contract: Schema.String }),
		Schema.Struct({
			kind: Schema.Literal("pattern"),
			source: Schema.String,
			flags: Schema.Literals(["u", "su"])
		}),
		Schema.Struct({
			kind: Schema.Literal("numericBound"),
			relation: Schema.String,
			field: Schema.String
		})
	])
)

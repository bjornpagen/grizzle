import { Array as Arr, Option, Predicate, Record as Rec, Schema } from "effect"
import { defsKeyOf, maxDefsRefHops } from "#model/defs-ref.ts"
import type { Parameter } from "#model/entities.ts"

/**
 * One value a parameter admits alone, as the request sends it: a string, a number or a boolean.
 */
export type ConstantValue = string | number | boolean

const Admits = Schema.Struct({
	$ref: Schema.optionalKey(Schema.String),
	const: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
	enum: Schema.optionalKey(Schema.Array(Schema.Json))
})

const decodeAdmits = Schema.decodeUnknownOption(Admits)

const decodeScalar = Schema.decodeUnknownOption(
	Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])
)

/**
 * The one value a stored schema admits, after its `$ref` chain: its `const`, or the member of a
 * one-member `enum`, when that value is a string, a number or a boolean.
 */
const admitsOne = (
	defs: Readonly<Record<string, Schema.Json>>,
	key: string,
	hops: number
): Option.Option<ConstantValue> =>
	Option.flatMap(
		Option.flatMap(Rec.get(defs, key), (node) =>
			Predicate.isObject(node) ? decodeAdmits(node) : Option.none()
		),
		(node) => {
			if (node.const !== undefined) {
				return Option.some(node.const)
			}

			if (node.enum !== undefined) {
				return node.enum.length === 1
					? Option.flatMap(Arr.head(node.enum), decodeScalar)
					: Option.none()
			}

			const next = node.$ref === undefined ? undefined : defsKeyOf(node.$ref)

			return next === undefined || hops >= maxDefsRefHops
				? Option.none()
				: admitsOne(defs, next, hops + 1)
		}
	)

/**
 * The constant a parameter is, when it is one: a required parameter written by style, whose schema
 * admits exactly one value (`const`, or a one-member `enum`) that is a string, a number or a
 * boolean. Such a parameter is no input: the request sends that value and no flag reads one. An
 * optional one stays an input, because sending it or not is the operator's choice.
 */
export const constantOf = (
	defs: Readonly<Record<string, Schema.Json>>,
	parameter: Parameter
): Option.Option<ConstantValue> =>
	parameter.required &&
	parameter.serialization.kind === "style" &&
	parameter.location !== "querystring"
		? admitsOne(defs, parameter.schema.key, 0)
		: Option.none()

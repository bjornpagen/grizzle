import { Array as Arr, Option, Predicate, Record as Rec } from "effect"
import { defsKeyOf } from "#model/defs-ref.ts"
import type { Parameter } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"

/**
 * One value a parameter admits alone, as the request sends it: a string, a number or a boolean.
 */
export type ConstantValue = string | number | boolean

/**
 * A JSON value that is a ConstantValue: a string, a number or a boolean. Every JSON number is finite: the loaders
 * refuse any other.
 */
const isConstantValue = (value: Json): value is ConstantValue =>
	Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)

/**
 * The one value a stored schema admits, after its `$ref` chain: its `const`, or the member of a
 * one-member `enum`, when that value is a string, a number or a boolean. `passed` holds the keys
 * the chain has passed: a reference back to one of them is a cycle, which admits none, so the
 * chain ends. A schema whose `$ref` is no string, whose `const` is none of those, or whose `enum`
 * is no array, admits none.
 */
const admitsOne = (
	defs: Readonly<Record<string, Json>>,
	key: string,
	passed: ReadonlySet<string>
): Option.Option<ConstantValue> =>
	Option.flatMap(Rec.get(defs, key), (node) => {
		if (!isObject(node)) {
			return Option.none()
		}

		const { $ref: ref, const: value, enum: members } = node
		if (
			(ref !== undefined && !Predicate.isString(ref)) ||
			(members !== undefined && !isArray(members))
		) {
			return Option.none()
		}

		if (value !== undefined) {
			return Option.liftPredicate(value, isConstantValue)
		}

		if (members !== undefined) {
			return members.length === 1
				? Option.filter(Arr.head(members), isConstantValue)
				: Option.none()
		}

		const next = ref === undefined ? undefined : defsKeyOf(ref)

		return next === undefined || passed.has(next)
			? Option.none()
			: admitsOne(defs, next, new Set([...passed, next]))
	})

/**
 * The constant a parameter is, when it is one: a required parameter written by style, whose schema
 * admits exactly one value (`const`, or a one-member `enum`) that is a string, a number or a
 * boolean. Such a parameter is no input: the request sends that value and no flag reads one. An
 * optional one stays an input, because sending it or not is the operator's choice.
 */
export const constantOf = (
	defs: Readonly<Record<string, Json>>,
	parameter: Parameter
): Option.Option<ConstantValue> =>
	parameter.required &&
	parameter.serialization.kind === "style" &&
	parameter.location !== "querystring"
		? admitsOne(defs, parameter.schema.key, new Set([parameter.schema.key]))
		: Option.none()

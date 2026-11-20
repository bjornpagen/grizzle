import { Array as Arr, Option, Predicate, Record, Result } from "effect"
import { evaluatePointerResult } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"

/**
 * A JSON object value.
 */
export type JsonObject = Readonly<Record<string, Json>>

/**
 * Whether a JSON value is an object (not an array, not null).
 */
export const isObject = (value: Json): value is JsonObject => Predicate.isObject(value)

/**
 * Whether a JSON value is an array.
 */
export const isArray = (value: Json): value is readonly Json[] => Arr.isArray<Json>(value)

/**
 * The node at `pointer`, `None` when the pointer is malformed or names no node.
 */
export const nodeAt = (root: Json, pointer: string): Option.Option<Json> =>
	Result.getSuccess(evaluatePointerResult(root, pointer))

/**
 * The own member `name` of a value when the value is an object and the member is a string.
 */
export const stringMember = (value: Json, name: string): string | undefined =>
	isObject(value)
		? Option.getOrUndefined(Option.filter(Record.get(value, name), Predicate.isString))
		: undefined

/**
 * One object member as a fold sees it: its key, its value and the value already folded.
 */
export interface JsonMember<A> {
	readonly key: string
	readonly value: Json
	readonly folded: A
}

/**
 * The three steps of a fold over a JSON value, each given the tokens of the node it folds.
 */
export interface JsonFold<A> {
	readonly array: (items: readonly A[], tokens: readonly string[]) => A
	readonly leaf: (value: null | boolean | number | string, tokens: readonly string[]) => A
	readonly object: (members: readonly JsonMember<A>[], tokens: readonly string[]) => A
}

/**
 * Folds a JSON value bottom up in document order: each item is folded with its index appended to
 * `tokens`, each object member (in insertion order) with its key appended. `tokens` are the tokens
 * of `value` itself, empty at a document root.
 */
export const foldJson = <A>(value: Json, fold: JsonFold<A>, tokens: readonly string[]): A => {
	if (isArray(value)) {
		return fold.array(
			Arr.map(value, (item, index) => foldJson(item, fold, [...tokens, `${index}`])),
			tokens
		)
	}

	return isObject(value)
		? fold.object(
				Arr.map(Record.toEntries(value), ([key, member]) => ({
					folded: foldJson(member, fold, [...tokens, key]),
					key,
					value: member
				})),
				tokens
			)
		: fold.leaf(value, tokens)
}

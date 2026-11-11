import { regex } from "arkregex"
import { Array as Arr, Option, Record, String as Str } from "effect"
import { isArray, isObject, nodeAt } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { childPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution } from "#resolve/index.ts"

/**
 * An object and where it sits: the document of the set that holds it, and its pointer there.
 */
export interface Place {
	readonly document: CanonicalKey["document"]
	readonly node: JsonObject
	readonly pointer: string
}

/**
 * A Path Item Object the checks walk: its `paths` key, the object at the end of its reference
 * chain, that object's pointer, and the use site under `/paths`.
 */
export interface PathItem {
	readonly key: string
	readonly node: JsonObject
	readonly pointer: string
	readonly use: string
}

/**
 * An Operation Object under a path item. `additional` marks a 3.2 `additionalOperations` entry,
 * whose method is its key as written; a fixed method field's method is upper-cased.
 */
export interface Operation {
	readonly additional: boolean
	readonly id: string | undefined
	readonly item: PathItem
	readonly method: string
	readonly node: JsonObject
	readonly pointer: string
}

/**
 * A path or server template expression, `{name}`, the name its one capture.
 */
export const expression = regex("\\{([^{}]+)\\}", "gu")

/**
 * Return the expression names of a template in order, repeats kept.
 */
export const expressionsOf = (template: string): readonly string[] =>
	Arr.getSomes(
		Arr.map(Arr.fromIterable(Str.matchAll(expression)(template)), (match) =>
			Option.fromUndefinedOr(match[1])
		)
	)

/**
 * The member `name` of the entry document's root object, `None` when it has none.
 */
export const rootMember = (resolution: Resolution, name: string): Option.Option<Json> =>
	isObject(resolution.value) ? Record.get(resolution.value, name) : Option.none()

/**
 * The entries of a value that is an object, none for anything else or nothing.
 */
export const entriesOf = (value: Option.Option<Json>): readonly (readonly [string, Json])[] =>
	Option.match(Option.filter(value, isObject), { onNone: () => [], onSome: Record.toEntries })

/**
 * The items of a value that is an array, none for anything else or nothing.
 */
export const listOf = (value: Option.Option<Json>): readonly Json[] =>
	Option.getOrElse(Option.filter(value, isArray), (): readonly Json[] => [])

/**
 * The member `name` of a value that is an object, `None` for anything else or nothing.
 */
export const memberOf = (value: Option.Option<Json>, name: string): Option.Option<Json> =>
	Option.flatMap(Option.filter(value, isObject), (object) => Record.get(object, name))

/**
 * Construct the canonical key of `pointer` in the entry document.
 */
export const site = (resolution: Resolution, pointer: string): CanonicalKey => ({
	document: resolution.document,
	pointer
})

/**
 * Follow the object at a use site through its Reference Object to the end of the chain, read from
 * the document of the set that holds it. A site with no reference is `node` itself; a target that
 * is not an object is `None`.
 */
export const locate = (
	resolution: Resolution,
	at: CanonicalKey,
	node: Json
): Option.Option<Place> => {
	const target = resolution.references.get(keyOf(at))?.target ?? at
	const value =
		target === at
			? Option.some(node)
			: Option.flatMap(
					Option.fromUndefinedOr(resolution.documents.get(target.document)),
					(document) => Option.fromUndefinedOr(nodeAt(document, target.pointer))
				)

	return Option.map(Option.filter(value, isObject), (object) => ({
		document: target.document,
		node: object,
		pointer: target.pointer
	}))
}

/**
 * Return the entry document's path items in `paths` order. A path item whose reference chain ends
 * in another document of the set is not walked: the checks read entry sites.
 */
export const pathItems = (resolution: Resolution): readonly PathItem[] =>
	Arr.flatMap(entriesOf(rootMember(resolution, "paths")), ([key, value]) => {
		const use = childPointer("/paths", key)

		return Option.match(
			Option.filter(
				locate(resolution, site(resolution, use), value),
				(located) => located.document === resolution.document
			),
			{
				onNone: () => [],
				onSome: (located) => [{ key, node: located.node, pointer: located.pointer, use }]
			}
		)
	})

/**
 * Convert an operation to a diagnostic's operation identity: method, path key and, when declared,
 * operationId.
 */
export const operationOf = (operation: Operation) =>
	operation.id === undefined
		? { method: operation.method, path: operation.item.key }
		: { method: operation.method, operationId: operation.id, path: operation.item.key }

import { Array as Arr, Data, Effect, Option, Record, Result } from "effect"
import type { Origin } from "#model/entities.ts"
import { isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import {
	PointerMemberNotFound,
	childPointer,
	evaluatePointerResult,
	ownPointer
} from "#model/pointer.ts"
import type { Json, PointerEvalError, PointerSyntaxError } from "#model/pointer.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution, ResolvedReference } from "#resolve/index.ts"

/**
 * The resolved reference whose use site is `site`, in whichever document of the set holds it.
 */
export const referenceIn = (
	resolution: Resolution,
	site: CanonicalKey
): ResolvedReference | undefined => resolution.references.get(keyOf(site))

/**
 * The origin of the element at `key`, whose pointer the generator built.
 */
export const originOf = (key: CanonicalKey): Effect.Effect<Origin> =>
	Effect.map(ownPointer(key.pointer), (pointer): Origin => ({ document: key.document, pointer }))

/**
 * The object a use site stands for: the end of its reference chain, or the site itself.
 */
export const follow = (resolution: Resolution, site: CanonicalKey): CanonicalKey =>
	referenceIn(resolution, site)?.target ?? site

/**
 * The node at `key`, read from its own document of the set. A document outside the set has no
 * member for its URI.
 */
const nodeInResult = (
	resolution: Resolution,
	key: CanonicalKey
): Result.Result<Json, PointerSyntaxError | PointerEvalError> => {
	const value = resolution.documents.get(key.document)

	return value === undefined
		? Result.fail(new PointerMemberNotFound({ pointer: key.pointer, token: key.document }))
		: evaluatePointerResult(value, key.pointer)
}

/**
 * The node at `key`, read from its own document of the set, or none when the document is outside
 * the set or the pointer names no node.
 */
export const nodeOption = (resolution: Resolution, key: CanonicalKey): Option.Option<Json> =>
	Result.getSuccess(nodeInResult(resolution, key))

/**
 * The node at `key`, read from its own document of the set.
 */
export const nodeIn = (
	resolution: Resolution,
	key: CanonicalKey
): Effect.Effect<Json, PointerSyntaxError | PointerEvalError> =>
	Effect.suspend(() => Effect.fromResult(nodeInResult(resolution, key)))

/**
 * A node of the document set that is not the object its place holds. Validation refuses a document
 * whose Object at such a place is no object, so normalization meets one only as a defect.
 */
class NotAnObject extends Data.TaggedError("NotAnObject")<{ readonly at: CanonicalKey }> {}

/**
 * The object at `key`, read from its own document of the set; a node of another shape, or none, is
 * a defect.
 */
export const objectIn = (resolution: Resolution, key: CanonicalKey): Effect.Effect<JsonObject> =>
	nodeIn(resolution, key).pipe(
		Effect.filterOrFail(isObject, () => new NotAnObject({ at: key })),
		Effect.orDie
	)

/**
 * The member names of the object at `key`, in the order the parsed object lists them, `None` when
 * no node is there; a node of another shape is a defect.
 */
export const memberNamesAt = (
	resolution: Resolution,
	key: CanonicalKey
): Effect.Effect<Option.Option<readonly string[]>> =>
	Option.match(nodeOption(resolution, key), {
		onNone: () => Effect.succeedNone,
		onSome: (node) =>
			isObject(node)
				? Effect.succeedSome(Record.keys(node))
				: Effect.die(new NotAnObject({ at: key }))
	})

/**
 * The key `tokens` below `key`, in the same document.
 */
export const childKey = (key: CanonicalKey, ...tokens: readonly string[]): CanonicalKey => ({
	document: key.document,
	pointer: Arr.reduce(tokens, key.pointer, (pointer, token) => childPointer(pointer, token))
})

/**
 * The schema a schema use site stands for: the end of its chain of schema references, in whichever document of the set
 * holds it. A chain that returns to a schema it has passed (an alias cycle, which schema normalization refuses as
 * DOC-23) stops at the schema that closes it, so every chain ends.
 */
export const settle = (resolution: Resolution, start: CanonicalKey): CanonicalKey => {
	const passed = new Set<string>()
	let current = start
	for (
		let reference = referenceIn(resolution, current);
		reference?.kind === "schema" && !passed.has(keyOf(current));
		reference = referenceIn(resolution, current)
	) {
		passed.add(keyOf(current))
		current = reference.target
	}

	return current
}

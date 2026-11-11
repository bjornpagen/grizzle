import { Array as Arr, Effect, Result } from "effect"
import type { Option } from "effect"
import { PointerMemberNotFound, childPointer, evaluatePointerResult } from "#model/pointer.ts"
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
		? Result.fail(PointerMemberNotFound.make({ pointer: key.pointer, token: key.document }))
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
 * The key `tokens` below `key`, in the same document.
 */
export const childKey = (key: CanonicalKey, ...tokens: readonly string[]): CanonicalKey => ({
	document: key.document,
	pointer: Arr.reduce(tokens, key.pointer, (pointer, token) => childPointer(pointer, token))
})

/**
 * How many schema references `settle` follows before it stops where it is.
 */
const maxHops = 16

/**
 * The schema a schema use site stands for: the end of its chain of schema references, in whichever document of the set
 * holds it, followed at most `maxHops` references.
 */
export const settle = (resolution: Resolution, start: CanonicalKey): CanonicalKey => {
	let current = start
	for (let hop = 0; hop < maxHops; hop += 1) {
		const reference = referenceIn(resolution, current)
		if (reference?.kind !== "schema") {
			return current
		}

		current = reference.target
	}

	return current
}

import { Array as Arr } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type ConcurrentChangeTag, changeTag, keyTag } from "#compiler/runtime/write/refusal.ts"

/**
 * The DETAIL text an arm raises for constant values, as its SQL expression computes it (write/refusal.ts raised): the
 * encoding the unit tests round-trip through readLawDetail and readChangeDetail.
 */
export const encodeRefusalDetail = (
	refusal:
		| { readonly kind: "law"; readonly relation: string }
		| { readonly kind: "change"; readonly reason: ConcurrentChangeTag; readonly relation: string },
	key: ReadonlyArray<{ readonly field: string; readonly text: string }>
): string => {
	const leading = refusal.kind === "law" ? [refusal.relation] : [refusal.reason, refusal.relation]
	const tag = refusal.kind === "law" ? keyTag : changeTag
	return `${tag}${jsonText([...leading, Arr.map(key, (k) => k.field), Arr.map(key, (k) => k.text)])}`
}

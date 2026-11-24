/** What the properties of boundary.test.ts read: its spaces, models and helpers. */

import {
	codePoint,
	constant,
	element,
	type Gen,
	int,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { type Drawn, type DrawnFeature, lsw, passed, type WildKind } from "@bjornpagen/testing/lsw"
import { Array as Arr, Option, Result } from "effect"
import { windowedInput } from "#adapter/db/input.ts"
import type { CallInputFault, CallInputRefused } from "#adapter/errors/failures.ts"
import type { PageCall } from "#adapter/page/execute.ts"
import { windowCall } from "#adapter/page/window.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"

import { relation, schema } from "#compiler/public/schema.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { Id } from "#test/support/ids.ts"

/**
 * The public boundary: every value a JavaScript caller can hand a paged member's input or a schema door is parsed once,
 * and a value the types refuse is a typed refusal from the vocabulary, never a defect.
 *
 * The oracle is the contract README "Reading" states, restated here: a paged member's input is exactly
 * `{ params, facts, window }`, its window exactly `{ anchor, size }`, its size a safe integer of at least 1 with no upper
 * bound, its anchor exactly `{ kind: "start" }`, `{ kind: "end" }`, `{ kind: "after", key }` or
 * `{ kind: "before", key }`, and an anchored kind's key a list of one value per comparator of the page's completed
 * order, each a value its comparator's codec admits (the one comparator here a text). A refusal is CallInputRefused, its
 * fault naming where it sits: `envelope` for the input, `window`, `size`, and `anchor` for the anchor and its key. Each
 * level is read once, through its own properties' descriptors, so a value in it that is not data (a refusing proxy, a
 * getter: WILD_IS_DATA) is refused where it sits, its code never run: an accessor is refused without being called. A
 * schema door takes a value schema(...) built, and refuses anything else as a MalformedDescription.
 *
 * Values are drawn live and wild (lsw): a live window is valid by construction, its size up to the largest safe
 * integer; a wild one is any value JavaScript can pass, in place of the whole window or of one of its fields. A window
 * has no earlier state, so none is stale. A valid input one of whose fields is an accessor returning its valid value is
 * refused at that field's record, its getter never called: a reader that called it would admit the input.
 *
 * Features: each live anchor kind, each wild kind at each site, each fault, each accessor; and each schema door's live
 * and wild values.
 */
type AnchorKind = "start" | "end" | "after" | "before"

/** A valid window: its anchor's kind, its size, and an anchored kind's key, one text. */
interface Window {
	readonly kind: AnchorKind
	readonly size: number
	readonly key: string
}

/** The one comparator's codec: a text's, whose encoder is the key's own reader. */
export const textCodec = scalarCodec(wildcardText, emptyCodebook)

export const keyed = (kind: AnchorKind): boolean => kind === "after" || kind === "before"

/** The page template each anchor kind runs. */
export const variants = { start: "first", end: "last", after: "after", before: "before" } as const

/** The README's window size: a safe integer of at least 1. */
const isWindowSizeSpec = (value: unknown): boolean =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1

/** Every wild kind but `anything`, which may draw a valid window itself. */
const windowWildKinds = [
	"null",
	"undefined",
	"negative-zero",
	"nan",
	"infinity",
	"bigint-for-number",
	"number-for-bigint",
	"lone-surrogate",
	"nul-character",
	"symbol",
	"function",
	"proxy",
	"throwing-getter"
] as const satisfies ReadonlyArray<WildKind>

const anchorValue = (w: Window): Readonly<Record<string, unknown>> =>
	keyed(w.kind) ? { kind: w.kind, key: [w.key] } : { kind: w.kind }

const windowValue = (w: Window): Readonly<Record<string, unknown>> => ({
	anchor: anchorValue(w),
	size: w.size
})

/** A window size: small, any safe integer, or the largest. */
const sizeGen: Gen<number> = weighted([
	[3, int(1, 7)],
	[1, int(1, Number.MAX_SAFE_INTEGER)],
	[1, constant(Number.MAX_SAFE_INTEGER)]
])

const windowGen: Gen<Window> = (source) => ({
	kind: source.draw(element<AnchorKind>(["start", "end", "after", "before"])),
	size: source.draw(sizeGen),
	key: source.draw(string(codePoint(0x20, 0x7e), { min: 0, max: 10 }))
})

/** Where a wild value goes: the whole window, its size, its anchor, or its key's one value. */
type WildSite = "window" | "size" | "anchor" | "key"

/** The field an accessor stands in for, returning the field's valid value when it is called. */
type AccessorField = "window" | "size" | "anchor" | "kind" | "key"

/** The fault an accessor at each field is refused with: the record that holds it. */
export const accessorFaults: { readonly [F in AccessorField]: CallInputFault } = {
	window: "envelope",
	size: "window",
	anchor: "window",
	kind: "anchor",
	key: "anchor"
}

/**
 * A case: a live or wild value at a site of a window; or a valid input one of whose fields is an accessor, which a
 * reader that judged it by calling it would admit.
 */
type WindowCase =
	| {
			readonly kind: "drawn"
			readonly site: WildSite
			readonly base: Window
			readonly drawn: Drawn<Window, never>
	  }
	| { readonly kind: "accessor"; readonly base: Window; readonly field: AccessorField }

export const windowCaseGen: Gen<WindowCase> = weighted<WindowCase>([
	[
		8,
		(source) => ({
			kind: "drawn",
			site: source.draw(element<WildSite>(["window", "size", "anchor", "key"])),
			base: source.draw(windowGen),
			drawn: source.draw(
				lsw<Window>({ live: windowGen, stale: Option.none(), wild: windowWildKinds })
			)
		})
	],
	[
		1,
		(source) => ({
			kind: "accessor",
			base: source.draw(windowGen),
			field: source.draw(element<AccessorField>(["window", "size", "anchor", "kind", "key"]))
		})
	]
])

/** `record` with `key` an enumerable getter returning `value`, counting its calls in `counter`. */
const getterAt = (
	record: Readonly<Record<string, unknown>>,
	key: string,
	value: unknown,
	counter: { calls: number }
): object => {
	const copy = { ...record }
	Object.defineProperty(copy, key, {
		enumerable: true,
		get: () => {
			counter.calls++
			return value
		}
	})
	return copy
}

/**
 * The input a case's accessor stands in: the valid input with `field` an enumerable getter returning its value,
 * counting its calls. The key's accessor is its list's one element; the kind's and the key's are of an anchored kind.
 */
export const withAccessor = (
	base: Window,
	field: AccessorField
): { readonly input: object; readonly calls: () => number } => {
	const counter = { calls: 0 }
	const w: Window = field === "key" || field === "kind" ? { ...base, kind: "after" } : base
	const anchor = anchorValue(w)
	const window = windowValue(w)
	const envelope = { params: {}, facts: {} }
	const at = (): object => {
		switch (field) {
			case "window":
				return getterAt(envelope, "window", window, counter)
			case "size":
				return { ...envelope, window: getterAt(window, "size", w.size, counter) }
			case "anchor":
				return { ...envelope, window: getterAt(window, "anchor", anchor, counter) }
			case "kind":
				return {
					...envelope,
					window: { ...window, anchor: getterAt(anchor, "kind", w.kind, counter) }
				}
			case "key": {
				const key: Array<unknown> = []
				Object.defineProperty(key, 0, {
					enumerable: true,
					get: () => {
						counter.calls++
						return w.key
					}
				})
				return { ...envelope, window: { ...window, anchor: { kind: w.kind, key } } }
			}
		}
	}
	return { input: at(), calls: () => counter.calls }
}

/** The window a drawn case hands its member: a live one, or the base with the wild value at its site. */
export const windowInput = (c: Extract<WindowCase, { readonly kind: "drawn" }>): unknown => {
	const d = c.drawn
	if (d.kind !== "wild") {
		return windowValue(d.value)
	}
	const value = passed(d)
	switch (c.site) {
		case "window":
			return value
		case "size":
			return { anchor: anchorValue(c.base), size: value }
		case "anchor":
			return { anchor: value, size: c.base.size }
		case "key":
			return {
				anchor: { kind: keyed(c.base.kind) ? c.base.kind : "after", key: [value] },
				size: c.base.size
			}
	}
}

/** What a window holding a wild value answers: admitted, or the fault that refuses it. */
type WildVerdict = "admitted" | CallInputFault

/**
 * The verdict on a wild value at `site`: a wild window is no record of an anchor and a size; a size is judged by the
 * size's rule; a wild anchor is no anchor; a key's value is the anchor's refusal where its comparator's codec refuses
 * it, the codec being that value's own reader.
 */
export const wildVerdict = (site: WildSite, value: unknown): WildVerdict => {
	switch (site) {
		case "window":
			return "window"
		case "size":
			return isWindowSizeSpec(value) ? "admitted" : "size"
		case "anchor":
			return "anchor"
		case "key":
			return typeof value === "string" && textCodec.encode(value).ok ? "admitted" : "anchor"
	}
}

/** A paged member's input's window read as its call reads it: its envelope, then its window. */
export const callOf = (input: unknown): Result.Result<PageCall, CallInputRefused> =>
	Result.flatMap(windowedInput(input), (read) => windowCall(read.window, [textCodec]))

export type WindowFeature =
	| DrawnFeature<never>
	| `anchor ${AnchorKind}`
	| `site ${WildSite}`
	| `refused at ${CallInputFault}`
	| `an accessor at the ${AccessorField}, refused uncalled`

export const windowFeatures: Arr.NonEmptyReadonlyArray<WindowFeature> = [
	"live",
	...Arr.map(windowWildKinds, (k: WildKind): WindowFeature => `wild ${k}`),
	"anchor start",
	"anchor end",
	"anchor after",
	"anchor before",
	"site window",
	"site size",
	"site anchor",
	"site key",
	"refused at window",
	"refused at size",
	"refused at anchor",
	"an accessor at the window, refused uncalled",
	"an accessor at the size, refused uncalled",
	"an accessor at the anchor, refused uncalled",
	"an accessor at the kind, refused uncalled",
	"an accessor at the key, refused uncalled"
]

/** A built schema, the one value a schema door admits. */
const Item = relation("Item", { id: Id }, ["id"])

export const Shop = schema("BoundaryShop", [Item], [])

export type DoorFeature = DrawnFeature<never>

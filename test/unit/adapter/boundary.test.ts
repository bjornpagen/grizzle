import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, constant, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import {
	type Drawn,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	WILD_KINDS,
	type WildKind
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { absurd, Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { windowedInput } from "#adapter/db/input.ts"
import type { CallInputFault } from "#adapter/errors/failures.ts"
import type { PageCall } from "#adapter/page/execute.ts"
import { windowCall } from "#adapter/page/window.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { assert, failed, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

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
 * Plants (~/.cache/grizzle-release/BR04/plants): boundary-page-size-zero.patch (a page of size 0 is admitted), applied
 * to page/window.ts isWindowSize.
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
const textCodec = scalarCodec(wildcardText, emptyCodebook)

const keyed = (kind: AnchorKind): boolean => kind === "after" || kind === "before"

/** The page template each anchor kind runs. */
const variants = { start: "first", end: "last", after: "after", before: "before" } as const

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
const accessorFaults: { readonly [F in AccessorField]: CallInputFault } = {
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

const windowCaseGen: Gen<WindowCase> = weighted<WindowCase>([
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
const withAccessor = (
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
const windowInput = (c: Extract<WindowCase, { readonly kind: "drawn" }>): unknown => {
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
const wildVerdict = (site: WildSite, value: unknown): WildVerdict => {
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
const callOf = (input: unknown): Result.Result<PageCall, { readonly fault: CallInputFault }> =>
	Result.flatMap(windowedInput(input), (read) => windowCall(read.window, [textCodec]))

type WindowFeature =
	| DrawnFeature<never>
	| `anchor ${AnchorKind}`
	| `site ${WildSite}`
	| `refused at ${CallInputFault}`
	| `an accessor at the ${AccessorField}, refused uncalled`

const windowFeatures: Arr.NonEmptyReadonlyArray<WindowFeature> = [
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
const Item = relation("Item", { id: uuid }, ["id"])
const Shop = schema("BoundaryShop", { Item }, [])

describe("the public boundary", () => {
	it.effect(
		"answers every paged member's window by the README's contract, and refuses every other value with a typed refusal",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "README Reading's window: its four anchors, a size of at least 1, a key its comparators' codecs admit"
						},
						suite: "unit/adapter/boundary-window",
						draw: drawn(windowCaseGen),
						literal: Formatter.format,
						coverage: required<WindowFeature>(windowFeatures, { cases: 2_000, sense: notesOnly }),
						kept: [],
						runs: 2_000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							if (c.kind === "accessor") {
								const { input, calls } = withAccessor(c.base, c.field)
								const refusal = failed(callOf(input))
								assert.equal(refusal.fault, accessorFaults[c.field])
								assert.equal(calls(), 0, "the caller's getter never runs")
								k.note(`an accessor at the ${c.field}, refused uncalled`)
								return
							}
							k.note(drawnFeature(c.drawn))
							const result = callOf({ params: {}, facts: {}, window: windowInput(c) })
							const d = c.drawn
							if (d.kind === "live") {
								const admitted = succeeded(result)
								const w = d.value
								k.note(`anchor ${w.kind}`)
								assert.equal(admitted.variant, variants[w.kind])
								assert.equal(admitted.size, w.size)
								assert.deepEqual(
									"boundary" in admitted ? admitted.boundary : [],
									keyed(w.kind) ? [succeeded(textCodec.encode(w.key))] : []
								)
								return
							}
							if (d.kind === "stale") {
								return absurd(d.from)
							}
							k.note(`site ${c.site}`)
							const verdict = wildVerdict(c.site, passed(d))
							if (verdict === "admitted") {
								succeeded(result)
								return
							}
							assert.equal(failed(result).fault, verdict)
							k.note(`refused at ${verdict}`)
						})
				)
			)
	)

	it.effect(
		"admits a built schema at the schema door, and refuses every other value as a MalformedDescription",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					type DoorFeature = DrawnFeature<never>
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "a schema door takes a value schema(...) built and refuses anything else"
							},
							suite: "unit/adapter/boundary-schema",
							draw: drawn(
								lsw<typeof Shop>({
									live: constant(Shop),
									stale: Option.none(),
									wild: WILD_KINDS
								})
							),
							literal: Formatter.format,
							coverage: required<DoorFeature>(
								["live", ...Arr.map(WILD_KINDS, (k: WildKind): DoorFeature => `wild ${k}`)],
								{ cases: 500, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d, k) =>
							Effect.sync(() => {
								k.note(drawnFeature(d))
								const parsed = parseSchemaInput(passed(d))
								if (d.kind === "live") {
									assert.ok(parsed.ok)
									return
								}
								assert.ok(!parsed.ok)
								assert.equal(parsed.error.reason._tag, "MalformedDescription")
							})
					)
				})
			)
	)
})

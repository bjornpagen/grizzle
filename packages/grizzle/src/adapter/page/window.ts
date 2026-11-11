import { Array as Arr, Predicate, Result } from "effect"
import { isExactRecord } from "#adapter/db/input.ts"
import { readHost } from "#adapter/engine.ts"
import { CallInputRefused } from "#adapter/errors/failures.ts"
import type { PageCall } from "#adapter/page/execute.ts"
import type { ParamText } from "#compiler/plan/common.ts"
import type { PageVariant, ScalarCodec } from "#compiler/plan/read.ts"

/**
 * A paged member's window, the `window` of its input (`{ params, facts, window }`), read once at the boundary into the
 * call its statement binds (execute.ts PageCall), before any SQL:
 *
 * - `size`: a safe integer of at least 1, with no upper bound, since the statement binds it as a bigint; any bound is
 *   the caller's.
 * - `anchor`: `{ kind: "start" }`, `{ kind: "after", key }`, `{ kind: "end" }` or `{ kind: "before", key }`. Its kind
 *   names the page template it runs (anchors). An anchored kind's Key holds one decoded value per comparator of the
 *   page's completed order, in that order, each written by its comparator column's codec as the boundary text the
 *   template's seek binds, so a Key is read exactly as a row's own values are and no token stands between them.
 *
 * Each value is read once off the caller's record (readHost), and nothing else of it is read: a record that holds any
 * other own key, a window that is no record of exactly an anchor and a size, an anchor that is no record of exactly its
 * kind and, for an anchored kind, its key, and a key of another length are refused with CallInputRefused, its fault naming
 * which; a key value its comparator's codec does not admit is the anchor's refusal.
 *
 * Each anchor kind: the page template it runs, and whether it carries a key.
 */
const anchors = {
	start: { variant: "first", keyed: false },
	after: { variant: "after", keyed: true },
	end: { variant: "last", keyed: false },
	before: { variant: "before", keyed: true }
} as const satisfies Record<string, { readonly variant: PageVariant; readonly keyed: boolean }>

/** The kinds of anchor a window takes. */
type AnchorKind = keyof typeof anchors

const isAnchorKind = (kind: unknown): kind is AnchorKind =>
	kind === "start" || kind === "after" || kind === "end" || kind === "before"

/** A window's size: a safe integer of at least 1. */
const isWindowSize = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1

const refused = (fault: CallInputRefused["fault"]): Result.Result<never, CallInputRefused> =>
	Result.fail(new CallInputRefused({ fault }))

/** A Key's boundary texts, one per comparator, each its codec's text of the Key's value at its position. */
const boundaryOf = (
	key: unknown,
	codecs: ReadonlyArray<ScalarCodec>
): Result.Result<ReadonlyArray<ParamText>, CallInputRefused> => {
	if (!Arr.isArray(key) || key.length !== codecs.length) {
		return refused("anchor")
	}
	const texts: Array<ParamText> = []
	for (const [at, codec] of codecs.entries()) {
		const text = codec.encode(key[at])
		if (!text.ok) {
			return refused("anchor")
		}
		texts.push(text.value)
	}
	return Result.succeed(texts)
}

/**
 * The call a caller's window is (see the header), its anchor's Key written by `codecs`, one per comparator of the
 * page's completed order, or its refusal.
 */
export const windowCall = (
	window: unknown,
	codecs: ReadonlyArray<ScalarCodec>
): Result.Result<PageCall, CallInputRefused> =>
	readHost<PageCall, CallInputRefused>(new CallInputRefused({ fault: "window" }), () => {
		if (!isExactRecord(window, ["anchor", "size"])) {
			return refused("window")
		}
		const size = window["size"]
		if (!isWindowSize(size)) {
			return refused("size")
		}
		const anchor = window["anchor"]
		if (!Predicate.isObject(anchor) || Arr.isArray(anchor)) {
			return refused("anchor")
		}
		const kind: unknown = Reflect.get(anchor, "kind")
		if (!isAnchorKind(kind)) {
			return refused("anchor")
		}
		const named = anchors[kind]
		if (!named.keyed) {
			return isExactRecord(anchor, ["kind"])
				? Result.succeed({ variant: named.variant, size })
				: refused("anchor")
		}
		if (!isExactRecord(anchor, ["kind", "key"])) {
			return refused("anchor")
		}
		return Result.map(boundaryOf(anchor["key"], codecs), (boundary) => ({
			variant: named.variant,
			size,
			boundary
		}))
	})

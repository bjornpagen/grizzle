import { Array as Arr, Predicate, Result } from "effect"
import { exactRecord } from "#adapter/db/input.ts"
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
 *   names the page template it runs (anchors). An anchored kind's RowKey holds one decoded value per comparator of the
 *   page's completed order, in that order, each written by its comparator column's codec as the boundary text the
 *   template's seek binds, so a RowKey is read exactly as a row's own values are and no token stands between them.
 *
 * Each value is read once, through its own property's descriptor (db/input.ts exactRecord, keyValues), and nothing
 * else of it is read: a window that is no record of exactly an anchor and a size, an anchor that is no record of exactly
 * its kind and, for an anchored kind, its key, a key that is no list of one value per comparator, and an accessor
 * anywhere among them are refused with CallInputRefused, its fault naming which; a key value its comparator's codec
 * does not admit is the anchor's refusal.
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

/**
 * The values of a RowKey, a list of exactly `length` values, each read through its index's own descriptor; or none, for
 * any other value, and for one holding an accessor or a hole among them.
 */
const keyValues = (key: unknown, length: number): ReadonlyArray<unknown> | undefined => {
	if (!Arr.isArray(key) || Reflect.ownKeys(key).length !== length + 1) {
		return undefined
	}
	const values: Array<unknown> = []
	for (let at = 0; at < length; at++) {
		const descriptor = Reflect.getOwnPropertyDescriptor(key, at)
		if (descriptor === undefined || !Predicate.hasProperty(descriptor, "value")) {
			return undefined
		}
		values.push(descriptor.value)
	}
	return values
}

/** A RowKey's boundary texts, one per comparator, each its codec's text of the RowKey's value at its position. */
const boundaryOf = (
	key: unknown,
	codecs: ReadonlyArray<ScalarCodec>
): Result.Result<ReadonlyArray<ParamText>, CallInputRefused> => {
	const values = keyValues(key, codecs.length)
	if (values === undefined) {
		return refused("anchor")
	}
	const texts: Array<ParamText> = []
	for (const [at, codec] of codecs.entries()) {
		const text = codec.encode(values[at])
		if (!text.ok) {
			return refused("anchor")
		}
		texts.push(text.value)
	}
	return Result.succeed(texts)
}

/**
 * The call an anchor is, with the window's `size`: its kind's template and, for an anchored kind, its RowKey's boundary
 * texts, or its refusal.
 */
const anchorCall = (
	anchor: unknown,
	size: number,
	codecs: ReadonlyArray<ScalarCodec>
): Result.Result<PageCall, CallInputRefused> => {
	const kind =
		Predicate.isObject(anchor) && !Arr.isArray(anchor)
			? Reflect.getOwnPropertyDescriptor(anchor, "kind")
			: undefined
	if (kind === undefined || !Predicate.hasProperty(kind, "value") || !isAnchorKind(kind.value)) {
		return refused("anchor")
	}
	const named = anchors[kind.value]
	if (!named.keyed) {
		return exactRecord(anchor, ["kind"]) === undefined
			? refused("anchor")
			: Result.succeed({ variant: named.variant, size })
	}
	const anchored = exactRecord(anchor, ["kind", "key"])
	if (anchored === undefined) {
		return refused("anchor")
	}
	return Result.map(boundaryOf(anchored["key"], codecs), (boundary) => ({
		variant: named.variant,
		size,
		boundary
	}))
}

/**
 * The call a caller's window is (see the header), its anchor's RowKey written by `codecs`, one per comparator of the
 * page's completed order, or its refusal: a window whose reading throws is refused at `window`, an anchor whose reading
 * throws at `anchor`.
 */
export const windowCall = (
	window: unknown,
	codecs: ReadonlyArray<ScalarCodec>
): Result.Result<PageCall, CallInputRefused> =>
	Result.flatMap(
		readHost(new CallInputRefused({ fault: "window" }), () => {
			const read = exactRecord(window, ["anchor", "size"])
			return read === undefined ? refused("window") : Result.succeed(read)
		}),
		(read) => {
			const size = read["size"]
			return isWindowSize(size)
				? readHost(new CallInputRefused({ fault: "anchor" }), () =>
						anchorCall(read["anchor"], size, codecs)
					)
				: refused("size")
		}
	)

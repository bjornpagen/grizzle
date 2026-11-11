import * as Arr from "effect/Array"
import * as Predicate from "effect/Predicate"
import * as Rec from "effect/Record"
import * as Result from "effect/Result"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { PageRequestRefused, type RequestFault } from "#adapter/errors/failures.ts"
import type { CursorError } from "#compiler/plan/common.ts"
import type { PageVariant } from "#compiler/plan/read.ts"
import { cursorError, readCaller } from "#compiler/plan/runtime.ts"

/**
 * Page request validation.
 *
 * The accepted request shapes are exactly { first }, { first, after }, { last } and { last, before }. The
 * types already say so (types/page PageRequest); this module checks it again for a caller the types do not reach, such
 * as a size or a cursor taken from an end user's request, before anything else of the page happens, so a refused
 * request compiles nothing and sends no SQL:
 *
 * - the request is the caller's value, read once as data at the runtime's boundary into a copy (core/host.ts
 *   readCaller): one whose reading throws (a refusing proxy), or that holds a getter or a setter, is refused, and every
 *   later read is of the copy, never of the caller's value;
 * - the request is an object whose own properties are control properties of exactly one direction: `first` with an
 *   optional `after`, or `last` with an optional `before`. Both sizes (mixed directions), an anchor of the other
 *   direction, both anchors, no size, or any other own property is refused;
 * - the size is a safe integer of at least 1, with no upper bound: the statements bind it, and the lookahead size plus
 *   one, as bigint parameters, which hold every safe integer. Zero, a negative or fractional number, an integer above
 *   Number.MAX_SAFE_INTEGER, NaN, the infinities, a bigint and a numeric string are refused. There is no default size,
 *   and the size is not part of a cursor's identity, so it may change on continuation;
 * - an omitted anchor is genuinely absent: a property is read only when it is an own property (Record.has), so an
 *   inherited one is not an anchor, and a supplied one must be a string. An explicitly supplied null or undefined
 *   cursor, or any other non-string, is CursorError `cursorType` (codec/cursor/fault.ts), the first step of
 *   cursor validation; the token's own validation follows once the query and its parameters are known (page.ts).
 *
 * A refused shape or size is a ReadFailure whose reason is PageRequestRefused with its fault, requestShape or
 * requestSize, at stage request: the request is the read's input, as a relation parameter is, and a page's error
 * channel is ReadError and CursorError only, keeping CursorError for the cursor itself (a malformed, oversized, or
 * mismatched cursor).
 *
 * A validated request: its variant, the requested size, and for after and before the caller's token, a string whose
 * own validation is the cursor codec's.
 */
export type PageRequestValue =
	| { readonly variant: "first"; readonly size: number }
	| { readonly variant: "after"; readonly size: number; readonly cursor: string }
	| { readonly variant: "last"; readonly size: number }
	| { readonly variant: "before"; readonly size: number; readonly cursor: string }

/** A page request refused for `fault`. */
const refused = (fault: RequestFault): ReadError =>
	new ReadFailure({ reason: new PageRequestRefused({ fault }) })

const shapeError = (): ReadError => refused("requestShape")

/** The control properties of each direction: its size and its anchor. */
const directions = {
	first: { size: "first", anchor: "after", anchored: "after", plain: "first" },
	last: { size: "last", anchor: "before", anchored: "before", plain: "last" }
} as const satisfies Record<
	string,
	{
		readonly size: string
		readonly anchor: string
		readonly anchored: PageVariant
		readonly plain: PageVariant
	}
>

const controlKeys: ReadonlySet<PropertyKey> = new Set(["first", "after", "last", "before"])

/** No key of a page request is left unread: every own property is copied. */
const requestKeys: ReadonlySet<string> = new Set()

/** An admitted size: a safe integer of at least 1. */
const isPageSize = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1

/** The request a caller's value is, or its refusal. */
export const pageRequest = (
	request: unknown
): Result.Result<PageRequestValue, ReadError | CursorError> => {
	if (!Predicate.isObject(request)) {
		return Result.fail(shapeError())
	}
	const read = readCaller(request, requestKeys)
	if (!read.ok) {
		return Result.fail(shapeError())
	}
	const fields = read.value.data
	if (Arr.some(Reflect.ownKeys(fields), (k) => !controlKeys.has(k))) {
		return Result.fail(shapeError())
	}
	const hasFirst = Rec.has(fields, "first")
	const hasLast = Rec.has(fields, "last")
	if (hasFirst === hasLast) {
		return Result.fail(shapeError())
	}
	const direction = hasFirst ? directions.first : directions.last
	const other = hasFirst ? directions.last : directions.first
	if (Rec.has(fields, other.anchor)) {
		return Result.fail(shapeError())
	}
	const size = fields[direction.size]
	if (!isPageSize(size)) {
		return Result.fail(refused("requestSize"))
	}
	if (!Rec.has(fields, direction.anchor)) {
		return Result.succeed({ variant: direction.plain, size })
	}
	const cursor = fields[direction.anchor]
	if (typeof cursor !== "string") {
		return Result.fail(cursorError("cursorType"))
	}
	return Result.succeed({ variant: direction.anchored, size, cursor })
}

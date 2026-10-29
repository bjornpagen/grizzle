import { Array as Arr, Predicate, Record as Rec, Result } from "effect"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { PageRequestRefused, type RequestFault } from "#adapter/errors/failures.ts"
import { cursorError } from "#compiler/codec/cursor/fault.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { type CursorError } from "#compiler/core/errors.ts"
import type { PageVariant } from "#compiler/lower/shapes/page/seek.ts"
import { hostArguments } from "#compiler/query/build/host.ts"

/**
 * Page request validation.
 *
 * The accepted request shapes are exactly { first }, { first, after }, { last } and { last, before }. The
 * types already say so (types/page PageRequest); this module checks it again for a caller the types do not reach, such
 * as a size or a cursor taken from an end user's request, before anything else of the page happens, so a refused
 * request compiles nothing and sends no SQL:
 *
 * - the request is the caller's value, read once as data at the builder's boundary (query/build/host.ts hostArguments):
 *   one whose reading throws (a refusing proxy), or that holds a getter or a setter, is refused, so every later read of
 *   it runs no caller code;
 * - the request is an object whose own properties are control properties of exactly one direction: `first` with an
 *   optional `after`, or `last` with an optional `before`. Both sizes (mixed directions), an anchor of the other
 *   direction, both anchors, no size, or any other own property is refused;
 * - the size is a safe integer from 1 to the fixed library limit pageMaxSize. Zero, a negative or fractional number,
 *   NaN, the infinities, a bigint and a numeric string are refused. There is no default size, and the size
 *   is not part of a cursor's identity, so it may change on continuation;
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
	ReadFailure.make({ reason: PageRequestRefused.make({ fault }) })

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

/** An admitted size: a safe integer from 1 to `maxSize`. */
const isPageSize = (value: unknown, maxSize: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maxSize

/**
 * The request a caller's value is, its size at most `maxSize` (core/policy.ts pageMaxSize in production), or its
 * refusal.
 */
export const pageRequest = (
	request: unknown,
	maxSize: number
): Result.Result<PageRequestValue, ReadError | CursorError> => {
	if (!Predicate.isObject(request)) {
		return Result.fail(shapeError())
	}
	if (
		!catchCompileError(() => {
			hostArguments("reader.page", request)
		}).ok
	) {
		return Result.fail(shapeError())
	}
	const own = Reflect.ownKeys(request)
	if (Arr.some(own, (k) => !controlKeys.has(k))) {
		return Result.fail(shapeError())
	}
	const fields: { readonly [key: string]: unknown } = request
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
	if (!isPageSize(size, maxSize)) {
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

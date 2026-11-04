import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { int4Max, int4Min, int8Max, int8Min } from "#compiler/scalar/values/integer.ts"

/**
 * The Span carrier of span(endpoint).
 *
 * A span is a nonempty bounded half-open interval [start, end) of integers: start < end, both finite. Endpoints are
 * pg.integer (int4range, a JavaScript integer number) or pg.bigint (int8range, a bigint), or a contract over one of
 * them, whose brand the type parameter carries. There are no unbounded, empty or closed-bound spans, so the host
 * value is exactly the two endpoints, and the half-open text '[start,end)' is PostgreSQL's canonical range output.
 * An exclusive end equal to the type's maximum is valid. A fixed-width span type, span(endpoint, width),
 * admits only a value whose end - start is that width, so a grizzle write never reaches the column's width
 * CHECK (physical/span/storage.ts).
 */
export type Span<E> = { readonly start: E; readonly end: E }

/** The range representation of the endpoint type. */
export type SpanEndpointCarrier = "int4" | "int8"

/** The host type of each endpoint representation: a JavaScript integer for int4range, a bigint for int8range. */
export interface SpanEndpointHost {
	readonly int4: number
	readonly int8: bigint
}

const endpointChecks: {
	readonly [P in SpanEndpointCarrier]: (
		value: unknown
	) => Result.Result<SpanEndpointHost[P], ValueFault>
} = {
	int4: (value) => {
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < int4Min ||
			value > int4Max
		) {
			return Result.err("spanEndpoint")
		}
		return Result.ok(value === 0 ? 0 : value)
	},
	int8: (value) => {
		if (typeof value !== "bigint" || value < int8Min || value > int8Max) {
			return Result.err("spanEndpoint")
		}
		return Result.ok(value)
	}
}

const checkEndpoint = <P extends SpanEndpointCarrier>(
	endpoint: P,
	value: unknown
): Result.Result<SpanEndpointHost[P], ValueFault> => {
	const check: (value: unknown) => Result.Result<SpanEndpointHost[P], ValueFault> =
		endpointChecks[endpoint]
	return check(value)
}

/**
 * A span from a host value: an object with exactly the own fields start and end, both endpoints of `endpoint`, with
 * start < end and, for a fixed width, end - start = width, computed exactly. The result is a fresh frozen object, so
 * no caller keeps a mutable handle on it.
 *
 * Own members, so `in` holds; it narrows the value to an object that has them.
 */
export const admitSpan = <P extends SpanEndpointCarrier>(
	endpoint: P,
	value: unknown,
	width: bigint | undefined
): Result.Result<Span<SpanEndpointHost[P]>, ValueFault> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return Result.err("spanType")
	}
	const proto: unknown = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) {
		return Result.err("spanType")
	}
	const keys = Reflect.ownKeys(value)
	if (keys.length !== 2 || !Object.hasOwn(value, "start") || !Object.hasOwn(value, "end")) {
		return Result.err("spanType")
	}
	if (!("start" in value) || !("end" in value)) {
		return Result.err("spanType")
	}
	const span = makeSpan(endpoint, value.start, value.end)
	if (width === undefined || !span.ok) {
		return span
	}
	return BigInt(span.value.end) - BigInt(span.value.start) === width
		? span
		: Result.err("spanWidth")
}

/** A span from its two endpoints. */
export const makeSpan = <P extends SpanEndpointCarrier>(
	endpoint: P,
	start: unknown,
	end: unknown
): Result.Result<Span<SpanEndpointHost[P]>, ValueFault> => {
	const s = checkEndpoint(endpoint, start)
	if (!s.ok) {
		return Result.err(s.error)
	}
	const e = checkEndpoint(endpoint, end)
	if (!e.ok) {
		return Result.err(e.error)
	}
	if (!(s.value < e.value)) {
		return Result.err("spanOrder")
	}
	return Result.ok(Object.freeze({ start: s.value, end: e.value }))
}

/** PostgreSQL's range order over nonempty bounded ranges (range_cmp): by start, then by end. */
export const compareSpan = <E extends number | bigint>(a: Span<E>, b: Span<E>): -1 | 0 | 1 => {
	if (a.start !== b.start) {
		return a.start < b.start ? -1 : 1
	}
	if (a.end !== b.end) {
		return a.end < b.end ? -1 : 1
	}
	return 0
}

/** The canonical range text, as int4range and int8range output write a half-open range. */
export const spanText = <E extends number | bigint>(span: Span<E>): string =>
	`[${span.start},${span.end})`

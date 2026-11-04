import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { type Described, describeFieldOrThrow, spanType } from "#compiler/scalar/registry.ts"
import { convertSpan } from "#compiler/scalar/values/convert.ts"
import { int4Max, int8Max } from "#compiler/scalar/values/integer.ts"
import type { Span } from "#compiler/scalar/values/span.ts"

/** The width as the caller gave it, admitted, or the refusal: a positive value of the endpoint's base type. */
const widthOf = (carrier: "int4" | "int8", width: unknown): number | bigint => {
	if (carrier === "int4") {
		if (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > int4Max) {
			throw malformedDescription(
				captureLoc("span width", []),
				"a span width over integer: a JavaScript integer 1-2147483647"
			)
		}
		return width
	}
	if (typeof width !== "bigint" || width < 1n || width > int8Max) {
		throw malformedDescription(
			captureLoc("span width", []),
			"a span width over bigint: a bigint 1-9223372036854775807"
		)
	}
	return width
}

/** A span's column over its endpoint's: an admitted endpoint is an integer, whose column is its conversion. */
export const spanColumn = <A>(endpoint: Column<A>): Column<Span<A>> => {
	if (endpoint.kind !== "convert") {
		throw malformedDescription(
			captureLoc("span endpoint", []),
			"a span endpoint over an integer field, whose column converts its text"
		)
	}
	return convertColumn(convertSpan(endpoint.convert))
}

/**
 * What the admission core decided: the endpoint as the registry admitted it, the width as the caller gave it (a number
 * over integer, a bigint over bigint) or undefined when it gave none, the span's Description and location.
 */
interface SpanParts {
	readonly endpoint: Described
	readonly width: number | bigint | undefined
	readonly desc: FieldDesc
	readonly loc: SourceLoc
}

/**
 * span(endpoint, width?): a bounded half-open extent over an integer endpoint.
 *
 * Span support is a separately admitted capability: an endpoint is a descriptor whose type has the
 * registry's spanEndpoint capability, which is exactly pg.integer, pg.bigint and contracts over them, aliases
 * included. Every other endpoint is refused with a capability diagnostic naming the endpoint type, the operation and
 * the missing capability: smallint (int4range plus endpoint bounds would be required), numeric, the
 * floats, money, and the serial family, which is a generation declaration (use its integer type). There
 * is no slow mode and no custom range type.
 *
 * The span lowers to int4range over an integer endpoint and int8range over a bigint one; a contract
 * endpoint keeps the base range, and its endpoints are branded. The optional width fixes the extent's
 * length, upper - lower, a positive value of the endpoint's base type: a JavaScript integer
 * up to 2147483647 over integer, a bigint up to 9223372036854775807 over bigint.
 *
 * The span's column reads range_out's "[start,end)" once and converts each endpoint with the endpoint descriptor's own
 * column, so a span over a contract delivers its branded endpoints: span(Cents) yields Span<Cents>.
 *
 * The admission core of span: a JavaScript caller can pass anything as the endpoint and in `rest`, the arguments after
 * it: none or an undefined width is span(endpoint), one width span(endpoint, width), and more are refused. The width
 * is read once, here; the Description holds it normalized. The public span (public/fields.ts) builds its descriptor
 * from these parts, its column typed by its endpoint.
 */
export const spanParts = (endpoint: unknown, rest: ReadonlyArray<unknown>): SpanParts => {
	if (rest.length > 1) {
		throw malformedDescription(captureLoc("span", []), "span(endpoint) or span(endpoint, width)")
	}
	const [width] = rest
	const described = describeFieldOrThrow(endpoint, SourceLoc("span endpoint", []))
	const loc = captureLoc(`span(${described.sql})`, [])
	const base = baseOf(described.scalar).carrier
	/**
	 * The endpoint's capability decides first, so a serial, smallint or money endpoint is always the capability
	 * diagnostic whatever width accompanies it.
	 */
	const unchecked = spanType(described.scalar, undefined, loc)
	if (!unchecked.ok) {
		throw unchecked.error
	}
	const given = width === undefined ? undefined : widthOf(base === "int4" ? "int4" : "int8", width)
	return {
		endpoint: described,
		width: given,
		desc: {
			kind: "span",
			endpoint: described.desc,
			width: given === undefined ? undefined : BigInt(given)
		},
		loc
	}
}

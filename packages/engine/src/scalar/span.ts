import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription, unsupported } from "#compiler/core/errors.ts"
import { int4Max, int8Max } from "#compiler/core/limits.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { dayNumber, lastCalendarDate } from "#compiler/ir/date.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import {
	type Described,
	describeFieldOrThrow,
	serialNameOf,
	spanType
} from "#compiler/scalar/registry.ts"
import type { Span } from "#compiler/scalar/values/span.ts"

/**
 * The width as the caller gave it, admitted, or the refusal: a positive value of the endpoint's base type, a count of
 * days over date, at most the days from 0001-01-01 to 9999-12-31.
 */
const widthOf = (carrier: "int4" | "int8" | "date", width: unknown): number | bigint => {
	if (carrier === "date") {
		const most = dayNumber(lastCalendarDate)
		if (typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > most) {
			throw malformedDescription(
				captureLoc("span width", []),
				`a span width over date: a JavaScript integer count of days 1-${most}`
			)
		}
		return width
	}
	if (carrier === "int4") {
		if (
			typeof width !== "number" ||
			!Number.isInteger(width) ||
			width < 1 ||
			width > int4Max.value
		) {
			throw malformedDescription(
				captureLoc("span width", []),
				`a span width over integer: a JavaScript integer 1-${int4Max.value}`
			)
		}
		return width
	}
	if (typeof width !== "bigint" || width < 1n || width > int8Max.value) {
		throw malformedDescription(
			captureLoc("span width", []),
			`a span width over bigint: a bigint 1-${int8Max.value}`
		)
	}
	return width
}

/** A span's column over its endpoint's: an admitted endpoint is an integer, whose column is its conversion. */
export const spanColumn = <A>(endpoint: Column<A>): Column<Span<A>> => {
	if (endpoint.kind === "convert") {
		const carrier = endpoint.conversion.carrier
		if (carrier === "int4" || carrier === "int8" || carrier === "date") {
			return convertColumn({ carrier: spanOver[carrier] })
		}
	}
	throw malformedDescription(
		captureLoc("span endpoint", []),
		"a span endpoint over an integer field, whose column converts its text"
	)
}

/** The span carrier over each endpoint carrier. */
const spanOver = { int4: "range4", int8: "range8", date: "rangeDate" } as const

interface SpanParts {
	readonly endpoint: Described
	readonly width: number | bigint | undefined
	readonly desc: FieldDesc
	readonly loc: SourceLoc
}

/**
 * span(endpoint, width?): a bounded half-open extent over an integer or a date endpoint.
 *
 * Span support is a separately admitted capability: an endpoint is a descriptor whose type has the
 * registry's spanEndpoint capability, which is exactly pg.integer, pg.bigint, date and contracts over them, aliases
 * included. Every other endpoint is refused with a capability diagnostic naming the endpoint type, the operation and
 * the missing capability: smallint (int4range plus endpoint bounds would be required), numeric, the
 * floats, money, and the serial family, a generation declaration and no value type, which is refused by its writing
 * (registry.ts serialNameOf) because its type is its integer's. There is no slow mode and no custom range type.
 *
 * The span lowers to int4range over an integer endpoint, int8range over a bigint one and daterange over a date; a
 * contract endpoint keeps the base range, and its endpoints are branded. The optional width fixes the extent's
 * length, upper - lower, a positive value of the endpoint's base type: a JavaScript integer
 * up to int4Max over integer, a bigint up to int8Max over bigint (ir/carriers.ts), a JavaScript integer count of days
 * over date.
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
	 * The endpoint decides first, whatever width accompanies it: a serial by its writing, since its type is its
	 * integer's, and a smallint or money endpoint by its capability.
	 */
	const serial = serialNameOf(described)
	if (serial !== undefined) {
		throw unsupported(
			loc,
			`spanEndpoint: ${serial} is a serial generation declaration, not a value type; spans are over integer, bigint and contracts over them`
		)
	}
	const unchecked = spanType(described.scalar, undefined, loc)
	if (!unchecked.ok) {
		throw unchecked.error
	}
	const given =
		width === undefined
			? undefined
			: widthOf(base === "int4" ? "int4" : base === "date" ? "date" : "int8", width)
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

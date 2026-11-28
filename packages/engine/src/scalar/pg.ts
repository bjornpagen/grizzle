import type { Column } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import {
	carrierColumn,
	type NumericHostOf,
	numericColumn
} from "#compiler/scalar/values/convert.ts"
import {
	checkNumericTypmod,
	type Numeric,
	type NumericBound,
	type NumericTypmod,
	numericBoundRefusal
} from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"

/** A descriptor whose values are A. */
type ColumnDescriptor<Sql extends SqlTag, A> = Descriptor<Sql> & { readonly column: Column<A> }

/**
 * numeric(p, s): the descriptor holds its typmod as members, FieldDesc's numeric (ir/desc.ts), and its column its values:
 * a bigint's at scale 0, whose values are integers, and a Numeric's at any other.
 */
interface NumericTypmodDescriptor<Host extends Numeric | bigint> extends ColumnDescriptor<
	"numeric",
	Host
> {
	readonly precision: number
	readonly scale: number
}

const plain = <const T extends PgScalarName, A>(
	type: T,
	column: Column<A>
): ColumnDescriptor<T, A> =>
	defineField({}, type, { kind: "pg", type }, { column }, SourceLoc(type, []), bareEnv)

export const int2 = plain("int2", carrierColumn("int2"))
export const int4 = plain("int4", carrierColumn("int4"))
export const int8 = plain("int8", carrierColumn("int8"))
export const float4 = plain("float4", carrierColumn("float4"))
export const float8 = plain("float8", carrierColumn("float8"))
export const money = plain("money", carrierColumn("money"))
export const bool = plain("bool", carrierColumn("bool"))
/**
 * inet and cidr, PostgreSQL's network address types (scalar/values/net.ts): an address with its network's mask, and a
 * network, whose address has no bit set right of its mask. A value is any text inet_in or cidr_in reads, and its host
 * value the one text inet_out or cidr_out prints of it, so '1.2.3.4/32' is the inet '1.2.3.4'.
 */
export const inet = plain("inet", carrierColumn("inet"))
export const cidr = plain("cidr", carrierColumn("cidr"))

/**
 * numeric(p, s)'s typmod as a JavaScript caller passes it, its precision and scale both declared and nothing beside
 * them: PostgreSQL's numerictypmodin rule (values/decimal.ts checkNumericTypmod), every other argument a malformed
 * description, thrown.
 */
export const admitNumericTypmod = (
	precision: unknown,
	scale: unknown,
	extra: ReadonlyArray<unknown>
): NumericTypmod => {
	if (scale === undefined || extra.length > 0) {
		throw malformedDescription(
			captureLoc("numeric", []),
			"numeric(p, s): its precision and its scale, both declared"
		)
	}
	const typmod = checkNumericTypmod(precision, scale)
	if (!typmod.ok) {
		throw malformedDescription(captureLoc("numeric", []), describeFault(typmod.error))
	}
	return typmod.value
}

/**
 * numeric(p, s), its typmod admitted (admitNumericTypmod). Its column is its scale's (values/convert.ts numericColumn),
 * so its host type is NumericHostOf<S>: a bigint at scale 0, a Numeric at any other.
 */
const numericTypmod = <const S extends number>(
	precision: number,
	scale: S,
	...extra: ReadonlyArray<never>
): NumericTypmodDescriptor<NumericHostOf<S>> => {
	const typmod = admitNumericTypmod(precision, scale, extra)
	return defineField(
		{},
		"numeric",
		{ kind: "numeric", precision: typmod.precision, scale: typmod.scale },
		{
			precision: typmod.precision,
			scale: typmod.scale,
			column: numericColumn({ precision: typmod.precision, scale })
		},
		SourceLoc(`numeric(${typmod.precision}, ${typmod.scale})`, []),
		bareEnv
	)
}

/**
 * numeric of no typmod within a computed numeric's bound (ir/scalar.ts NumericBound): its descriptor holds the bound
 * as a member, FieldDesc's computedNumeric (ir/desc.ts), and its column numeric's carrier's, so its host type is
 * Numeric at every scale, as the computed value it stores is read.
 */
interface NumericBoundDescriptor extends ColumnDescriptor<"numeric", Numeric> {
	readonly bound: NumericBound
}

/**
 * numeric.within(digits, scale): numeric of no typmod whose every value is NaN, an infinity or a finite value below
 * 10^digits in magnitude of at most `scale` fraction digits, the bound a sum, a mean or an operation proves of the
 * value it computes (ir/scalar.ts NumericBound), so a field of it stores such a value exactly, as it was read: never
 * rounded, which numeric(p, s) would, nor refused for an infinity, which numeric(p, s) holds none of. The bound is the
 * column's CHECK (physical/numeric/storage.ts boundedNumeric) and the host boundary's (values/decimal.ts withinBound).
 * Its digits and scale are numericBoundRefusal's, narrower than numeric's own limits: any other argument,
 * or a third, is MalformedDescription, thrown.
 */
const numericWithin = (
	digits: number,
	scale: number,
	...extra: ReadonlyArray<never>
): NumericBoundDescriptor => {
	const refusal =
		extra.length > 0
			? "numeric.within(digits, scale): its digits and its scale alone"
			: numericBoundRefusal(digits, scale)
	if (refusal !== undefined) {
		throw malformedDescription(captureLoc("numeric.within", []), refusal)
	}
	const bound: NumericBound = Object.freeze({
		digits: digits === 0 ? 0 : digits,
		scale: scale === 0 ? 0 : scale
	})
	return defineField(
		{},
		"numeric",
		{ kind: "computedNumeric", bound },
		{ bound, column: carrierColumn("numeric") },
		SourceLoc(`numeric.within(${bound.digits}, ${bound.scale})`, []),
		bareEnv
	)
}

/**
 * numeric, PostgreSQL's numeric of no typmod, the descriptor that is also numeric(p, s)'s constructor (numericTypmod),
 * as SQL spells `numeric` and `numeric(p, s)`: every value numeric holds, at numeric's own limits (scalar/registry.ts
 * numericOwnLimits), NaN and the infinities among them. Its column is numeric's carrier's, so its host type is Numeric
 * whatever the value's scale, and a value passes into and out of it as it is, never rounded to a scale nothing stated.
 * Its member `within` is numeric of no typmod within a narrower bound (numericWithin).
 */
export const numeric = defineField(
	numericTypmod,
	"numeric",
	{ kind: "pg", type: "numeric" },
	{ column: carrierColumn("numeric"), within: numericWithin },
	SourceLoc("numeric", []),
	bareEnv
)

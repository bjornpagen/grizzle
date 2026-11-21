import type { Column } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import { minted } from "#compiler/scalar/minted.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import { storedSearchDescriptor } from "#compiler/scalar/search.ts"
import {
	carrierColumn,
	type NumericHostOf,
	numericColumn
} from "#compiler/scalar/values/convert.ts"
import {
	checkNumericTypmod,
	type Decimal,
	type NumericBound,
	type NumericTypmod,
	numericBoundRefusal
} from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { vector } from "#compiler/scalar/vector.ts"

/** A descriptor whose values are A. */
type ColumnDescriptor<Sql extends SqlTag, A> = Descriptor<Sql> & { readonly column: Column<A> }

/**
 * numeric(p, s): the descriptor holds its typmod as members, FieldDesc's numeric (ir/desc.ts), and its column its values:
 * a bigint's at scale 0, whose values are integers, and a Decimal's at any other.
 */
interface NumericTypmodDescriptor<Host extends Decimal | bigint> extends ColumnDescriptor<
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
	defineField({}, type, { kind: "pg", type }, { column }, SourceLoc(`pg.${type}`, []), bareEnv)

const smallint = plain("smallint", carrierColumn("int2"))
const integer = plain("integer", carrierColumn("int4"))
const bigint = plain("bigint", carrierColumn("int8"))
const real = plain("real", carrierColumn("float4"))
const money = plain("money", carrierColumn("money"))
const boolean = plain("boolean", carrierColumn("bool"))
/**
 * inet and cidr, PostgreSQL's network address types (scalar/values/net.ts): an address with its network's mask, and a
 * network, whose address has no bit set right of its mask. A value is any text inet_in or cidr_in reads, and its host
 * value the one text inet_out or cidr_out prints of it, so '1.2.3.4/32' is the inet '1.2.3.4'.
 */
const inet = plain("inet", carrierColumn("inet"))
const cidr = plain("cidr", carrierColumn("cidr"))

/** double precision, the one name its descriptor's source location spells with brackets, as its key is written. */
const doublePrecision: ColumnDescriptor<"double precision", number> = defineField(
	{},
	"double precision",
	{ kind: "pg", type: "double precision" },
	{ column: carrierColumn("float8") },
	SourceLoc('pg["double precision"]', []),
	bareEnv
)

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
			captureLoc("pg.numeric", []),
			"numeric(p, s): its precision and its scale, both declared"
		)
	}
	const typmod = checkNumericTypmod(precision, scale)
	if (!typmod.ok) {
		throw malformedDescription(captureLoc("pg.numeric", []), describeFault(typmod.error))
	}
	return typmod.value
}

/**
 * numeric(p, s), its typmod admitted (admitNumericTypmod). Its column is its scale's (values/convert.ts numericColumn),
 * so its host type is NumericHostOf<S>: a bigint at scale 0, a Decimal at any other.
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
		SourceLoc(`pg.numeric(${typmod.precision}, ${typmod.scale})`, []),
		bareEnv
	)
}

/**
 * numeric of no typmod within a computed numeric's bound (ir/scalar.ts NumericBound): its descriptor holds the bound
 * as a member, FieldDesc's computedNumeric (ir/desc.ts), and its column numeric's carrier's, so its host type is
 * Decimal at every scale, as the computed value it stores is read.
 */
interface NumericBoundDescriptor extends ColumnDescriptor<"numeric", Decimal> {
	readonly bound: NumericBound
}

/**
 * pg.numeric.within(digits, scale): numeric of no typmod whose every value is NaN, an infinity or a finite value below
 * 10^digits in magnitude of at most `scale` fraction digits, the bound a sum, a mean or an operation proves of the
 * value it computes (ir/scalar.ts NumericBound), so a field of it stores such a value exactly, as it was read: never
 * rounded, which numeric(p, s) would, nor refused for an infinity, which numeric(p, s) holds none of. The bound is the
 * column's CHECK (physical/numeric/storage.ts boundedNumeric) and the host boundary's (values/decimal.ts withinBound).
 * Its digits and scale are numericBoundRefusal's, narrower than numeric's own limits, pg.numeric's: any other argument,
 * or a third, is MalformedDescription, thrown.
 */
const numericWithin = (
	digits: number,
	scale: number,
	...extra: ReadonlyArray<never>
): NumericBoundDescriptor => {
	const refusal =
		extra.length > 0
			? "pg.numeric.within(digits, scale): its digits and its scale alone"
			: numericBoundRefusal(digits, scale)
	if (refusal !== undefined) {
		throw malformedDescription(captureLoc("pg.numeric.within", []), refusal)
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
		SourceLoc(`pg.numeric.within(${bound.digits}, ${bound.scale})`, []),
		bareEnv
	)
}

/**
 * numeric, PostgreSQL's numeric of no typmod, the descriptor that is also numeric(p, s)'s constructor (numericTypmod),
 * as SQL spells `numeric` and `numeric(p, s)`: every value numeric holds, at numeric's own limits (scalar/registry.ts
 * numericOwnLimits), NaN and the infinities among them. Its column is numeric's carrier's, so its host type is Decimal
 * whatever the value's scale, and a value passes into and out of it as it is, never rounded to a scale nothing stated.
 * Its member `within` is numeric of no typmod within a narrower bound (numericWithin).
 */
const numeric = defineField(
	numericTypmod,
	"numeric",
	{ kind: "pg", type: "numeric" },
	{ column: carrierColumn("numeric"), within: numericWithin },
	SourceLoc("pg.numeric", []),
	bareEnv
)

/**
 * The pg namespace: PostgreSQL's numeric, money and boolean descriptors, each under the one name PostgreSQL's
 * format_type prints for its type, which is its SQL tag: smallint, integer, bigint, numeric (numeric(p, s) its call),
 * real, "double precision", money, boolean, inet and cidr. A type has one spelling, so no declaration names one type two ways. smallserial, serial, bigserial
 * and uuidv7 are no descriptors but the refusal of one (scalar/minted.ts): grizzle mints no ids.
 *
 * - `pg.numeric` is numeric of no typmod, every value numeric holds, its host type Decimal: a field, a parameter, a
 *   declared function's argument or result or a contract's base of it passes each value as it is.
 * - `pg.numeric.within(digits, scale)` is numeric of no typmod within a computed numeric's bound, the type a stored
 *   field of a sum's or a mean's value is of, exactly (numericWithin).
 * - `pg.numeric(p, s)` is numeric with its typmod, precision and scale both declared, so every value a field of it
 *   holds has the digits its typmod states. PostgreSQL's numerictypmodin rule is checked: precision
 *   1-numericMaxPrecision and scale numericMinScale-numericMaxScale (ir/carriers.ts), both integers, a scale larger
 *   than the precision permitted. Its host type follows its values: a bigint at scale 0, whose values are integers and
 *   never NaN, and a Decimal at any other scale.
 *
 * - `pg.tsvector(configuration)` is a search document of a text search configuration of pg_catalog's, a field its
 *   caller writes, each value a document a read delivered, written back as it is (scalar/search.ts
 *   storedSearchDescriptor); the generated field PostgreSQL parses from its row's texts is searchDocument's.
 *
 * A malformed typmod from a JavaScript caller is CompileError MalformedDescription, thrown synchronously, the builders'
 * convention. Precision and scale are runtime values only, the TypeScript signatures in types/fields taking a number.
 *
 * Each descriptor's column is its carrier's conversion (values/convert.ts), so its host type is the conversion's:
 * pg.bigint's is BigInt, a bigint, and the public binding (public/fields.ts) checks it against `Field<bigint, "bigint">`.
 */
export const pgDescriptors = Object.freeze({
	smallint,
	integer,
	bigint,
	numeric,
	real,
	"double precision": doublePrecision,
	money,
	boolean,
	inet,
	cidr,
	smallserial: minted,
	serial: minted,
	bigserial: minted,
	uuidv7: minted,
	vector,
	tsvector: storedSearchDescriptor
})

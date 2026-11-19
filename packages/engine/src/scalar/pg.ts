import type { Column } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import { minted } from "#compiler/scalar/minted.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import {
	carrierColumn,
	type NumericHostOf,
	numericColumn
} from "#compiler/scalar/values/convert.ts"
import {
	checkNumericTypmod,
	type Decimal,
	type NumericTypmod
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
const numeric = <const S extends number>(
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
 * The pg namespace: PostgreSQL's numeric, money and boolean descriptors, each under the one name PostgreSQL's
 * format_type prints for its type, which is its SQL tag: smallint, integer, bigint, numeric, real, "double precision",
 * money and boolean. A type has one spelling, so no declaration names one type two ways. smallserial, serial, bigserial
 * and uuidv7 are no descriptors but the refusal of one (scalar/minted.ts): grizzle mints no ids.
 *
 * - `pg.numeric(p, s)` is numeric with its typmod, precision and scale both declared: there is no numeric field
 *   without one, so every numeric value a field holds has the digits its typmod states. PostgreSQL's numerictypmodin
 *   rule is checked: precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale (ir/carriers.ts), both
 *   integers, a scale larger than the precision permitted. Its host type follows its values: a bigint at scale 0, whose
 *   values are integers and never NaN, and a Decimal at any other scale.
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
	smallserial: minted,
	serial: minted,
	bigserial: minted,
	uuidv7: minted,
	vector
})

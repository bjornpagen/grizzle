import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { derived, type Limit, postgresSource } from "#compiler/core/limits.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { binary32Precision, binary64Precision } from "#compiler/ir/carriers.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import { serialAliases } from "#compiler/scalar/serial.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import { checkNumericTypmod, type Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { vector } from "#compiler/scalar/vector.ts"

/** A descriptor whose values are A. */
type ColumnDescriptor<Sql extends SqlTag, A> = Descriptor<Sql> & { readonly column: Column<A> }

/** numeric(p, s): the descriptor holds its typmod as members, FieldDesc's numeric (ir/desc.ts). */
interface NumericTypmodDescriptor extends ColumnDescriptor<"numeric", Decimal> {
	readonly precision: number
	readonly scale: number
}

type FloatDescriptorConstructor = ColumnDescriptor<"double precision", number> &
	((
		precision: unknown
	) => ColumnDescriptor<"real", number> | ColumnDescriptor<"double precision", number>)

const plain = <const T extends PgScalarName, A>(
	type: T,
	column: Column<A>
): ColumnDescriptor<T, A> =>
	defineField({}, type, { kind: "pg", type }, { column }, SourceLoc(`pg.${type}`, []), bareEnv)

const smallint = plain("smallint", convertColumn(convertByCarrier.int2({ carrier: "int2" })))
const integer = plain("integer", convertColumn(convertByCarrier.int4({ carrier: "int4" })))
const bigint = plain("bigint", convertColumn(convertByCarrier.int8({ carrier: "int8" })))
const real = plain("real", convertColumn(convertByCarrier.float4({ carrier: "float4" })))
const money = plain("money", convertColumn(convertByCarrier.money({ carrier: "money" })))
const boolean = plain("boolean", convertColumn(convertByCarrier.bool({ carrier: "bool" })))

/**
 * PostgreSQL's date, the date contract's base (scalar/date.ts): no field is declared over it bare, since a bare date
 * column holds the infinities and dates past 9999 that no CalendarDate is, so it is no member of the pg namespace.
 */
export const pgDate = plain("date", convertColumn(convertByCarrier.date({ carrier: "date" })))

const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

const floatP = `${postgresSource}/doc/src/sgml/datatype.sgml#L905-L910`

/** The greatest binary precision float(p) maps to real: real's own, binary32's. */
const floatRealPrecision: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bits",
	scope: "the binary precision p of float(p) that selects real",
	from: [binary32Precision],
	derivation: `p names the least binary precision, and real is binary32, so float(1) through float(binary32's precision) select real: "accepts float(1) to float(24) as selecting the real type" (${floatP})`,
	compute: ([p]) => p.value
})

/** The greatest binary precision float(p) admits: double precision's own, binary64's. */
const floatDoublePrecision: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bits",
	scope: "the binary precision p of float(p) that selects double precision",
	from: [binary64Precision],
	derivation: `double precision is binary64, so float(p) past real's precision through binary64's selects it and a greater p draws an error: "float(25) to float(53) select double precision. Values of p outside the allowed range draw an error." (${floatP})`,
	compute: ([p]) => p.value
})

/** float(p): PostgreSQL's binary precision rule. */
const float = (
	precision: unknown
): ColumnDescriptor<"real", number> | ColumnDescriptor<"double precision", number> => {
	if (!isInteger(precision) || precision < 1 || precision > floatDoublePrecision.value) {
		throw malformedDescription(
			captureLoc("pg.float", []),
			`a float binary precision: an integer 1-${floatRealPrecision.value} (real) or ${floatRealPrecision.value + 1}-${floatDoublePrecision.value} (double precision)`
		)
	}
	return precision <= floatRealPrecision.value ? real : doublePrecision
}

const doublePrecision: FloatDescriptorConstructor = defineField(
	(precision: unknown) => float(precision),
	"double precision",
	{ kind: "pg", type: "double precision" },
	{ column: convertColumn(convertByCarrier.float8({ carrier: "float8" })) },
	SourceLoc('pg["double precision"]', []),
	bareEnv
)

/** numeric's column, every typmod's: Decimal.fromOutput reads PostgreSQL's text into the value's one form, at any scale. */
const numericColumn: Column<Decimal> = convertColumn(
	convertByCarrier.numeric({ carrier: "numeric", typmod: undefined })
)

/**
 * numeric(p, s), its precision and scale both declared, as a JavaScript caller passes them: PostgreSQL's
 * numerictypmodin rule (values/decimal.ts checkNumericTypmod), every other argument a malformed description.
 */
const numeric = (...args: ReadonlyArray<unknown>): NumericTypmodDescriptor => {
	const [precision, scale, ...extra] = args
	if (args.length < 2 || extra.length > 0) {
		throw malformedDescription(
			captureLoc("pg.numeric", []),
			"numeric(p, s): its precision and its scale, both declared"
		)
	}
	const typmod = checkNumericTypmod(precision, scale)
	if (!typmod.ok) {
		throw malformedDescription(captureLoc("pg.numeric", []), describeFault(typmod.error))
	}
	return defineField(
		{},
		"numeric",
		{ kind: "numeric", precision: typmod.value.precision, scale: typmod.value.scale },
		{ precision: typmod.value.precision, scale: typmod.value.scale, column: numericColumn },
		SourceLoc(`pg.numeric(${typmod.value.precision}, ${typmod.value.scale})`, []),
		bareEnv
	)
}

/**
 * The pg namespace: PostgreSQL's numeric, money and boolean descriptors under their own names.
 *
 * Every PostgreSQL spelling normalizes at construction to one descriptor, which is also one Description and one
 * ScalarType: `pg.int` and `pg.int4` are `pg.integer`, `pg.int2` is `pg.smallint`, `pg.int8`
 * is `pg.bigint`, `pg.float4` is `pg.real`, `pg.float8` and bare `pg.float` are `pg["double precision"]`, `pg.bool` is
 * `pg.boolean`, `pg.decimal` is `pg.numeric`, and `pg.serial2`, `pg.serial4` and `pg.serial8` are the serial forms.
 * Each alias is the very same frozen value, so alias spelling changes neither identity nor schema.
 *
 * - `pg.numeric(p, s)` is numeric with its typmod, precision and scale both declared: there is no numeric field
 *   without one, so every numeric value a field holds has the digits its typmod states. PostgreSQL's numerictypmodin
 *   rule is checked: precision 1-numericMaxPrecision and scale numericMinScale-numericMaxScale (ir/scalar.ts), both
 *   integers, a scale larger than the precision permitted. `pg.decimal` is the same function.
 * - `pg.float` is double precision, a value and a constructor at once, and `pg.float(p)` follows PostgreSQL: binary
 *   precision 1-floatRealPrecision selects real and past it through floatDoublePrecision double precision; every other
 *   value is invalid. The result is the real or double precision descriptor itself, so `pg.float(24)` is `pg.real`.
 *   Because `pg.float` and `pg["double precision"]` are one value, that value is the callable one.
 *
 * A malformed typmod from a JavaScript caller is CompileError MalformedDescription, thrown synchronously, the builders'
 * convention. Precision, scale and float's choice are runtime values only: the TypeScript signatures in
 * types/fields take a number, and the type of pg.float(p) is real or double precision.
 *
 * Each descriptor's column is its carrier's conversion (values/convert.ts), so its host type is the conversion's:
 * pg.bigint's is BigInt, a bigint, and the public binding (public/fields.ts) checks it against `Field<bigint, "bigint">`.
 *
 * The namespace, every PostgreSQL spelling included.
 */
export const pgDescriptors = Object.freeze({
	smallint,
	int2: smallint,
	integer,
	int: integer,
	int4: integer,
	bigint,
	int8: bigint,
	numeric,
	decimal: numeric,
	real,
	float4: real,
	"double precision": doublePrecision,
	float8: doublePrecision,
	float: doublePrecision,
	money,
	boolean,
	bool: boolean,
	...serialAliases,
	vector
})

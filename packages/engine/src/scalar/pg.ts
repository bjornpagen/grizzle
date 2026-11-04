import { type Column, convertColumn } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import type { NumericTypmod } from "#compiler/ir/scalar.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import { serialAliases } from "#compiler/scalar/serial.ts"
import { convertByCarrier } from "#compiler/scalar/values/convert.ts"
import { checkNumericTypmod, type Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { vector } from "#compiler/scalar/vector.ts"

/** A descriptor whose values are A. */
type ColumnDescriptor<Sql extends SqlTag, A> = Descriptor<Sql> & { readonly column: Column<A> }

/**
 * numeric(p, s): the descriptor holds its typmod as members. Bare numeric holds neither, so the two are the arms of
 * FieldDesc's numeric (ir/desc.ts).
 */
interface NumericTypmodDescriptor extends ColumnDescriptor<"numeric", Decimal> {
	readonly precision: number
	readonly scale: number
}

/**
 * Bare numeric, whose call admits any arguments, as a JavaScript caller passes them, and refuses all but numeric(p) and
 * numeric(p, s).
 */
type NumericDescriptorConstructor = ColumnDescriptor<"numeric", Decimal> &
	((...args: ReadonlyArray<unknown>) => NumericTypmodDescriptor)

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

const isInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value)

/** float(p): PostgreSQL's binary precision rule. */
const float = (
	precision: unknown
): ColumnDescriptor<"real", number> | ColumnDescriptor<"double precision", number> => {
	if (!isInteger(precision) || precision < 1 || precision > 53) {
		throw malformedDescription(
			captureLoc("pg.float", []),
			"a float binary precision: an integer 1-24 (real) or 25-53 (double precision)"
		)
	}
	return precision <= 24 ? real : doublePrecision
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
 * The typmod of numeric(p) or numeric(p, s), as a JavaScript caller passes its arguments: a scale left out (or
 * undefined) is numeric(p), the one-element typmod list.
 */
const numericTypmod = (args: ReadonlyArray<unknown>): NumericTypmod => {
	if (args.length === 0 || args.length > 2) {
		throw malformedDescription(
			captureLoc("pg.numeric", []),
			"numeric(p) or numeric(p, s): one or two typmod arguments"
		)
	}
	const typmod = checkNumericTypmod(args[1] === undefined ? [args[0]] : [args[0], args[1]])
	if (!typmod.ok) {
		throw malformedDescription(captureLoc("pg.numeric", []), describeFault(typmod.error))
	}
	return typmod.value
}

const numeric: NumericDescriptorConstructor = defineField(
	(...args: ReadonlyArray<unknown>): NumericTypmodDescriptor => {
		const typmod = numericTypmod(args)
		return defineField(
			{},
			"numeric",
			{ kind: "numeric", precision: typmod.precision, scale: typmod.scale },
			{ precision: typmod.precision, scale: typmod.scale, column: numericColumn },
			SourceLoc(`pg.numeric(${typmod.precision}, ${typmod.scale})`, []),
			bareEnv
		)
	},
	"numeric",
	{ kind: "numeric" },
	{ column: numericColumn },
	SourceLoc("pg.numeric", []),
	bareEnv
)

/**
 * The pg namespace: PostgreSQL's numeric, money and boolean descriptors under their own names.
 *
 * Every PostgreSQL spelling normalizes at construction to one descriptor, which is also one Description and one
 * ScalarType: `pg.int` and `pg.int4` are `pg.integer`, `pg.int2` is `pg.smallint`, `pg.int8`
 * is `pg.bigint`, `pg.float4` is `pg.real`, `pg.float8` and bare `pg.float` are `pg["double precision"]`, `pg.bool` is
 * `pg.boolean`, `pg.decimal` is `pg.numeric`, and `pg.serial2`, `pg.serial4` and `pg.serial8` are the serial forms.
 * Each alias is the very same frozen value, so alias spelling changes neither identity nor schema.
 *
 * Two descriptors are values and constructors at once:
 *
 * - `pg.numeric` is bare numeric, and `pg.numeric(p)` and `pg.numeric(p, s)` are the typmod forms; numeric(p) is
 *   numeric(p, 0), one typmod. PostgreSQL's numerictypmodin rule is checked: precision 1-1000 and scale
 *   -1000-1000, both integers, a scale larger than the precision permitted. `pg.decimal` is the same
 *   function, so `pg.decimal(p, s)` is `pg.numeric(p, s)`.
 * - `pg.float` is double precision, and `pg.float(p)` follows PostgreSQL: binary precision 1-24 selects real and 25-53
 *   double precision; every other value is invalid. The result is the real or double precision
 *   descriptor itself, so `pg.float(24)` is `pg.real`. Because `pg.float` and `pg["double precision"]` are one value,
 *   that value is the callable one.
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

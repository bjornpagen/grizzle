import type { Column } from "#compiler/core/decoder.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { derived, type Limit, postgresSource } from "#compiler/core/limits.ts"
import { captureLoc, SourceLoc } from "#compiler/core/loc.ts"
import { binary32Precision, binary64Precision } from "#compiler/ir/carriers.ts"
import type { PgScalarName } from "#compiler/ir/desc.ts"
import { bareEnv, type Descriptor, defineField, type SqlTag } from "#compiler/scalar/registry.ts"
import { serialAliases } from "#compiler/scalar/serial.ts"
import { carrierColumn } from "#compiler/scalar/values/convert.ts"
import { checkNumericTypmod, type Decimal } from "#compiler/scalar/values/decimal.ts"
import { describeFault } from "#compiler/scalar/values/fault.ts"
import { vector } from "#compiler/scalar/vector.ts"

/** The integers 1 through N, a union of their literals. */
type OneThrough<
	N extends number,
	Counted extends ReadonlyArray<unknown> = [unknown],
	Below = never
> = Counted["length"] extends N
	? Below | N
	: OneThrough<N, [...Counted, unknown], Below | Counted["length"]>

/**
 * The binary precisions float(p) admits, 1 through binary64's 53, and real's among them, 1 through binary32's 24, as
 * PostgreSQL resolves them (floatRealPrecision and floatDoublePrecision).
 */
export type FloatPrecision = OneThrough<53>
type RealPrecision = OneThrough<24>

/** The SQL type float(P) resolves to: real where real's precision holds P, double precision past it. */
export type FloatSql<P extends FloatPrecision> = P extends RealPrecision
	? "real"
	: "double precision"

/** A descriptor whose values are A. */
type ColumnDescriptor<Sql extends SqlTag, A> = Descriptor<Sql> & { readonly column: Column<A> }

/** numeric(p, s): the descriptor holds its typmod as members, FieldDesc's numeric (ir/desc.ts). */
interface NumericTypmodDescriptor extends ColumnDescriptor<"numeric", Decimal> {
	readonly precision: number
	readonly scale: number
}

/** The real or double precision descriptor float(P) resolves to. */
type FloatDescriptor<P extends FloatPrecision> = ColumnDescriptor<FloatSql<P>, number>

/** Every binary precision float(p) admits, each with the descriptor it resolves to. */
type FloatDescriptors = { readonly [P in FloatPrecision]: FloatDescriptor<P> }

type FloatDescriptorConstructor = ColumnDescriptor<"double precision", number> &
	(<const P extends FloatPrecision>(precision: P) => FloatDescriptor<P>)

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

/** Whether a JavaScript caller's precision is one float(p) admits: an entry of floatDescriptors. */
export const isFloatPrecision = (value: unknown): value is FloatPrecision =>
	isInteger(value) && Object.hasOwn(floatDescriptors, value)

/** The refusal of a precision float(p) admits no descriptor for. */
export const refuseFloat = (): never => {
	throw malformedDescription(
		captureLoc("pg.float", []),
		`a float binary precision: an integer 1-${floatRealPrecision.value} (real) or ${floatRealPrecision.value + 1}-${floatDoublePrecision.value} (double precision)`
	)
}

/**
 * float(p): PostgreSQL's binary precision rule, read off the descriptors each precision resolves to, so the type of
 * float(P) is the descriptor P resolves to. A JavaScript caller's precision of no entry is a malformed description.
 */
const float = <const P extends FloatPrecision>(precision: P): FloatDescriptor<P> =>
	isFloatPrecision(precision) ? floatDescriptors[precision] : refuseFloat()

const doublePrecision: FloatDescriptorConstructor = defineField(
	<const P extends FloatPrecision>(precision: P) => float(precision),
	"double precision",
	{ kind: "pg", type: "double precision" },
	{ column: carrierColumn("float8") },
	SourceLoc('pg["double precision"]', []),
	bareEnv
)

/**
 * The descriptor of each binary precision float(p) admits: real through floatRealPrecision, double precision past it
 * through floatDoublePrecision, the two Limits' values (FloatPrecision, types/fields/field.ts).
 */
export const floatDescriptors: FloatDescriptors = Object.freeze({
	1: real,
	2: real,
	3: real,
	4: real,
	5: real,
	6: real,
	7: real,
	8: real,
	9: real,
	10: real,
	11: real,
	12: real,
	13: real,
	14: real,
	15: real,
	16: real,
	17: real,
	18: real,
	19: real,
	20: real,
	21: real,
	22: real,
	23: real,
	24: real,
	25: doublePrecision,
	26: doublePrecision,
	27: doublePrecision,
	28: doublePrecision,
	29: doublePrecision,
	30: doublePrecision,
	31: doublePrecision,
	32: doublePrecision,
	33: doublePrecision,
	34: doublePrecision,
	35: doublePrecision,
	36: doublePrecision,
	37: doublePrecision,
	38: doublePrecision,
	39: doublePrecision,
	40: doublePrecision,
	41: doublePrecision,
	42: doublePrecision,
	43: doublePrecision,
	44: doublePrecision,
	45: doublePrecision,
	46: doublePrecision,
	47: doublePrecision,
	48: doublePrecision,
	49: doublePrecision,
	50: doublePrecision,
	51: doublePrecision,
	52: doublePrecision,
	53: doublePrecision
})

/** numeric's column, every typmod's: Decimal.fromOutput reads PostgreSQL's text into the value's one form, at any scale. */
const numericColumn: Column<Decimal> = carrierColumn("numeric")

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
 * convention. Precision and scale are runtime values only, the TypeScript signatures in types/fields taking a number;
 * float's binary precision is typed, and the type of pg.float(p) is the descriptor p resolves to.
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

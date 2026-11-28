import { SourceLoc } from "#compiler/core/loc.ts"
import { isExactValue, type ScalarType } from "#compiler/ir/scalar.ts"
import { bareEnv, carrierSql, defineField } from "#compiler/scalar/registry.ts"
import { carrierColumn } from "#compiler/scalar/values/convert.ts"
import { moneyFractionDigits } from "#compiler/scalar/values/decimal.ts"

/**
 * exactInteger: an integer of any size, the type integer arithmetic delivers (ir/scalar.ts ExactType) at numeric's own
 * limit, so a field of it holds every value a sum, a product or a difference of integers is, written as it is. Its host
 * type is bigint, unbranded: its column is the exact integer carrier's conversion, BigInt reading numeric_out's digits
 * (values/convert.ts). It is stored as PostgreSQL's numeric of no typmod, its column CHECKed to the integers a bigint
 * spells, scale 0, never NaN or an infinity (physical/numeric/storage.ts exactNumeric), and no key holds one, since its
 * widest value outgrows every index entry: a key's integer is a numeric(p, 0) or a int8.
 */
export const exactIntegerDescriptor = defineField(
	{},
	carrierSql.exactInteger,
	{ kind: "exact", carrier: "exactInteger" },
	{ column: carrierColumn("exactInteger") },
	SourceLoc("exactInteger", []),
	bareEnv
)

/**
 * exactMoney: an amount of money of any size, the type money arithmetic and a money sum deliver (ir/scalar.ts ExactType)
 * at numeric's own limit, so a field of it holds a total no signed 64-bit count of cents holds. Its host type is Money,
 * the minor-unit count of any size (values/money.ts Money.exact): its column is the exact money carrier's conversion,
 * Money.fromOutput reading the amount at money's own scale. It is stored as PostgreSQL's numeric of no typmod, its
 * column CHECKed to amounts at exactly moneyFractionDigits fraction digits, the scale money::numeric writes and the Money
 * carrier reads and writes, never NaN or an infinity (physical/numeric/storage.ts exactNumeric), and no key holds one: a
 * key's amount is a money or a numeric(p, 2).
 */
export const exactMoneyDescriptor = defineField(
	{},
	carrierSql.exactMoney,
	{ kind: "exact", carrier: "exactMoney" },
	{ column: carrierColumn("exactMoney") },
	SourceLoc("exactMoney", []),
	bareEnv
)

/**
 * The one scale of an exact value's stored text, by its type (ir/scalar.ts ExactType): an exact integer's none, an
 * amount's money's fraction digits, the scale money::numeric writes and the Money carrier reads and writes
 * (values/money.ts Money.fromOutput, toString), which an exact field's column CHECK holds it to
 * (physical/numeric/storage.ts exactNumeric); none for any other type.
 */
export const exactScaleOf = (type: ScalarType): number | undefined => {
	if (!isExactValue(type)) {
		return undefined
	}
	switch (type.carrier) {
		case "exactInteger":
			return 0
		case "exactMoney":
			return moneyFractionDigits
	}
}

import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { type CarrierSpec, compareValues, type HostOf } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import { isVector } from "#compiler/scalar/values/vector.ts"
import { assert } from "#test/support/assert.ts"

/** The runtime merge of heading-group statements (R21), as a test orders decoded rows. */
interface MergeSpec {
	/** The common completed order, the discriminant among its keys. */
	readonly order: CompletedOrder
	/** The type of each ordered column, as the statements' decoders produce its host value. */
	readonly types: Readonly<Record<string, ScalarType>>
}

type DecodedRow = { readonly [column: string]: unknown }

/** A span host value: both endpoints of one integer carrier (scalar/values/span.ts). */
const isSpanValue = (value: unknown): value is Span<number> | Span<bigint> =>
	typeof value === "object" &&
	value !== null &&
	"start" in value &&
	"end" in value &&
	((typeof value.start === "number" && typeof value.end === "number") ||
		(typeof value.start === "bigint" && typeof value.end === "bigint"))

/** A decoded value of an ordered column: the host value of some carrier (scalar/values/identity.ts CarrierHost). */
const isHostValue = (value: unknown): value is HostOf<CarrierSpec> =>
	typeof value === "number" ||
	typeof value === "bigint" ||
	typeof value === "boolean" ||
	typeof value === "string" ||
	value instanceof Decimal ||
	value instanceof Money ||
	isVector(value) ||
	isSpanValue(value)

/**
 * The comparator of decoded rows under a completed order: PostgreSQL's B-tree order per column (values/identity.ts
 * compareValues: numeric and float with NaN last, text in code point order, enums in roster order), reversed for a
 * descending key. A row whose ordered value is no host value fails the test.
 */
export const mergeComparator = (
	spec: MergeSpec
): Result.Result<(a: DecodedRow, b: DecodedRow) => number, CompileError> => {
	const keys: Array<{
		readonly column: string
		readonly sign: 1 | -1
		readonly spec: CarrierSpec
	}> = []
	for (const k of spec.order.keys) {
		const type = spec.types[k.column]
		if (type === undefined) {
			return Result.err(
				malformedDescription(
					SourceLoc(`heading-group merge on ${k.column}`, []),
					"an ordered column with a type"
				)
			)
		}
		keys.push({ column: k.column, sign: k.dir === "asc" ? 1 : -1, spec: carrierSpecOf(type) })
	}
	return Result.ok((a, b) => {
		for (const k of keys) {
			const x = a[k.column]
			const y = b[k.column]
			assert.ok(
				isHostValue(x) && isHostValue(y),
				`a decoded value of the ordered column ${k.column}`
			)
			const c = compareValues(k.spec, x, y)
			if (c !== 0) {
				return c * k.sign
			}
		}
		return 0
	})
}

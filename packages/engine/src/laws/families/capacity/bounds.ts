import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CapacityAggregate, CheckedBound, FamilyLaw, LawWeight } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** The carrier of an aggregate a capacity checks: a count's bigint, or a sum's bigint or numeric (see `capacityCheck`). */
export type SummedCarrier = CapacityAggregate["carrier"]

export type CapacityCheck =
	| { readonly kind: "existence" }
	| {
			readonly kind: "aggregate"
			readonly weight: LawWeight
			/** The aggregate's carrier, and its type, which its zero branch and its literal bounds are written in. */
			readonly carrier: SummedCarrier
			readonly type: ScalarType
			readonly bounds: NonEmptyReadonlyArray<CheckedBound>
	  }

/** What the law function checks for one target row: the existence variant, or the aggregate the capacity's
 * normalization typed (`capacityAggregate`).
 *
 * What a residual scalar-group capacity checks: the aggregate and its type over the bounds the law carries, and how
 * each bound is compared.
 *
 * - Bounds. `within(n)` is exactly n, `within(low, high)` the inclusive range and `within(low, "*")` has no upper
 *   bound . The law carries the bounds a group can break, low before high, as the recognizer
 *   left them: a count or a duration weight is never negative, so a literal lower bound of zero or
 *   less holds for every group and is not checked; a field weight may be negative, so its every bound is.
 * - The existence variant. A count whose remaining bounds are exactly "at least one" is an existence law: the
 *   group is nonempty, `within(1n, "*")` ("fewer than one approver in the group"). Its probe is one indexed existence
 *   test, never a count of the group.
 * - The aggregate. A count is `count(*)`, bigint. A field weight is `sum(field)` with SUM's result type
 *   (`aggregateOverload`): smallint and integer sum to bigint, bigint and numeric to numeric,
 *   a contract contributing its base. The capacity's normalization types it (`capacityAggregate`), refusing a weight of real, double precision or money, whose sum rounds or overflows. A duration weight is the width
 *   of the source's span summed in numeric: each width is `upper(s)::numeric - lower(s)::numeric`, so neither a width
 *   at the endpoint type's limits (a span from the minimum of int8 to its maximum is 2^64 - 1 wide) nor the group's
 *   total can overflow, and the law's violation query computes the same numeric width, so a Validate that runs it
 *   never raises where this check passed.
 * - Comparison. The capacity's normalization parsed each bound once against the aggregate (ir/law.ts CapacityBound): a
 *   literal bound is a literal of the aggregate's type, and a `ref` bound, a field of the target row, carries the exact
 *   carrier both sides are cast to, the one the law's violation query compares them in: the aggregate's own, or the
 *   bound's when it is wider, a numeric bound against a count for instance, since casting it down would round it. A
 *   bound of real or double precision never reaches here: the normalization refuses it, since no carrier compares a
 *   float exactly with an exact sum. A money bound meets the aggregate in numeric, which both convert to exactly. */
export const capacityCheck = (law: FamilyLaw<"scalarCapacity">): CapacityCheck => {
	const { weight, bounds, aggregate } = law
	const [only, ...others] = bounds
	if (
		weight.kind === "count" &&
		only.side === "low" &&
		only.value.kind === "literal" &&
		only.value.literal.kind === "int" &&
		only.value.literal.value === 1n &&
		others.length === 0
	) {
		return { kind: "existence" }
	}
	return { kind: "aggregate", weight, carrier: aggregate.carrier, type: aggregate.type, bounds }
}

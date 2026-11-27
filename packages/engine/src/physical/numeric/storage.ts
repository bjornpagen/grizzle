import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	exactParts,
	type FiniteParts,
	infinityParts,
	nanParts,
	negativeInfinityParts
} from "#compiler/core/decimal.ts"
import { identity } from "#compiler/core/identity.ts"
import {
	integerTypmodOf,
	type NumericBound,
	numericBoundOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { exactScaleOf } from "#compiler/scalar/exact.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { and, binary, call, isIn, lit, lt, or, types } from "#compiler/sql/build.ts"

/**
 * An integer numeric column's CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * numeric(p, 0) is an integer type: its host value is a bigint (scalar/values/identity.ts CarrierSpec), and its column
 * `pg_catalog.numeric(p, 0) NOT NULL`. PostgreSQL's numeric(p, 0) holds NaN as well, which no bigint spells, so the
 * column carries the named CHECK of the integers:
 *
 *     CONSTRAINT "__ledger_points_integer_<digest>" CHECK (("points" <> 'NaN'::numeric) IS TRUE)
 *
 * The codec's host boundary admits a bigint alone, a literal of the type refuses NaN, and a cast into it is defined only
 * on a value proved no NaN (scalar/values/decimal.ts normalizeNumeric, scalar/compute/lower.ts fitsTarget), so it
 * refuses only a direct writer. Its name is the naming door's hashed integerCheck.
 */
export const integerNumeric = Object.freeze({
	holds: (type: ScalarType): boolean => integerTypmodOf(type) !== undefined,
	generationProves: false,
	named: identity.integerCheck,
	predicate: (_: unknown, column: Expr): Expr =>
		binary("<>", column, lit.decimal(nanParts, types.numeric)),
	reason: (relation: string, field: string): string =>
		`the integers a bigint spells of ${relation}.${field}: numeric(p, 0) holds no NaN`
})

/** The scale of an exact field's type, which exactNumeric holds of alone. */
const exactScale = (type: ScalarType): number =>
	defined(exactScaleOf(type), "an exact field's type, which exactNumeric holds of")

/**
 * `scale(value) = <the type's scale>`: a value of an exact type, `type`, held to the values its host spells, at its one
 * scale, never NaN or an infinity, whose scale is NULL: the one predicate a stored column's CHECK (exactNumeric) and a
 * variant's domain over an arm's field of an exact type (physical/ddl/variants.ts) state it by, each where NULL refuses.
 */
export const exactPredicate = (value: Expr, type: ScalarType): Expr =>
	binary("=", call("scale", [value]), lit.int(exactScale(type), types.integer))

/**
 * An exact field's CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * An exact integer or exact money field (scalar/exact.ts) is PostgreSQL's numeric of no typmod, its column
 * `pg_catalog.numeric NOT NULL`, which holds every display scale, NaN and the infinities as well, none of which its host
 * value spells: a bigint has no fraction, and a Money no other scale than money's. So the column carries the named CHECK
 * of the values at its type's one scale (exactScaleOf):
 *
 *     CONSTRAINT "__ledger_total_exact_<digest>" CHECK (("pg_catalog"."scale"("total") = 2) IS TRUE)
 *
 * scale() of NaN or an infinity is NULL, which IS TRUE refuses, so the one comparison refuses them too, and a value at
 * another scale, 5.0 for an integer, 1.5 for an amount, which would read back as another text. The codec's host boundary
 * admits a bigint or a Money alone, which it writes at that scale, and integer and money arithmetic make values at it,
 * so it refuses only a direct writer. Its name is the naming door's hashed exactCheck.
 */
export const exactNumeric = Object.freeze({
	holds: (type: ScalarType): boolean => exactScaleOf(type) !== undefined,
	generationProves: false,
	named: identity.exactCheck,
	predicate: (_: unknown, column: Expr, type: ScalarType): Expr => exactPredicate(column, type),
	reason: (relation: string, field: string, type: ScalarType): string =>
		`the values its host spells of ${relation}.${field}: numeric at scale ${exactScale(type)}, never NaN or an infinity`
})

/**
 * The bound of a column of numeric of no typmod narrower than numeric's own limits, a computed numeric's
 * (pg.numeric.within); none for pg.numeric, whose bound PostgreSQL's own format is, and for every other type.
 */
const narrowerBoundOf = (type: ScalarType): NumericBound | undefined => {
	const bound = numericBoundOf(type)
	return bound === undefined ||
		(bound.digits >= numericMaxIntegerDigits && bound.scale >= numericMaxFractionDigits)
		? undefined
		: bound
}

/**
 * 10^digits, the magnitude a bound's finite values stay below, as a numeric literal's parts: a coefficient of `digits`
 * zeros at scale 0, or 1 at scale -digits below one.
 */
const powerOfTen = (digits: number): FiniteParts =>
	digits >= 0 ? exactParts(10n ** BigInt(digits), 0) : exactParts(1n, -digits)

/**
 * The predicate of a computed numeric column's bound (ir/scalar.ts NumericBound) over the unqualified column `column`,
 * as a row CHECK spells it: NaN or an infinity, which numeric of no typmod holds and a computed value may be, or a
 * finite value of at most `scale` fraction digits, `min_scale(v) <= scale`, below 10^digits in magnitude,
 * `abs(v) < 1e<digits>`, each part left out where numeric's own limit states it already.
 */
const boundPredicate = (column: Expr, bound: NumericBound): Expr => {
	const finite: Array<Expr> = []
	if (bound.scale < numericMaxFractionDigits) {
		finite.push(binary("<=", call("min_scale", [column]), lit.int(bound.scale, types.integer)))
	}
	if (bound.digits < numericMaxIntegerDigits) {
		finite.push(lt(call("abs", [column]), lit.decimal(powerOfTen(bound.digits), types.numeric)))
	}
	const specials = isIn(column, [
		lit.decimal(nanParts, types.numeric),
		lit.decimal(infinityParts, types.numeric),
		lit.decimal(negativeInfinityParts, types.numeric)
	])
	return isNonEmpty(finite) ? or([specials, and(finite)]) : specials
}

/**
 * A computed numeric column's CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * pg.numeric.within(digits, scale) is numeric of no typmod within a computed numeric's bound (ir/scalar.ts
 * NumericBound): its column is `pg_catalog.numeric NOT NULL`, which holds every numeric value, so the column carries
 * the named CHECK of the bound, NaN and the infinities passing as numeric of no typmod holds them:
 *
 *     CONSTRAINT "__ledger_total_bound_<digest>" CHECK ((("total" IN ('NaN'::numeric, 'Infinity'::numeric,
 *       '-Infinity'::numeric)) OR ((min_scale("total") <= 2) AND (abs("total") < '100000'::numeric))) IS TRUE)
 *
 * The codec's host boundary admits a value of the bound alone, as a literal written into the column is (values/decimal.ts
 * withinBound), so it refuses only a direct writer. Its name is the naming door's hashed boundCheck.
 */
export const boundedNumeric = Object.freeze({
	holds: (type: ScalarType): boolean => narrowerBoundOf(type) !== undefined,
	generationProves: false,
	named: identity.boundCheck,
	predicate: (_: unknown, column: Expr, type: ScalarType): Expr => {
		const bound = narrowerBoundOf(type)
		return bound === undefined ? lit.bool(true) : boundPredicate(column, bound)
	},
	reason: (relation: string, field: string, type: ScalarType): string =>
		`the computed numeric bound of ${relation}.${field}: ${boundText(narrowerBoundOf(type))}`
})

/** What a bound holds, as a column CHECK's reason states it: numeric's own limits where it states none narrower. */
const boundText = (bound: NumericBound | undefined): string =>
	bound === undefined
		? "numeric's own limits"
		: `NaN, an infinity, or a value below 10^${bound.digits} in magnitude of at most ${bound.scale} fraction digits`

import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { nanParts } from "#compiler/core/decimal.ts"
import { identity } from "#compiler/core/identity.ts"
import { integerTypmodOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { exactScaleOf } from "#compiler/scalar/exact.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, lit, types } from "#compiler/sql/build.ts"

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
	named: identity.exactCheck,
	predicate: (_: unknown, column: Expr, type: ScalarType): Expr =>
		binary("=", call("scale", [column]), lit.int(exactScale(type), types.integer)),
	reason: (relation: string, field: string, type: ScalarType): string =>
		`the values its host spells of ${relation}.${field}: numeric at scale ${exactScale(type)}, never NaN or an infinity`
})

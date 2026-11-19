import { nanParts } from "#compiler/core/decimal.ts"
import { identity } from "#compiler/core/identity.ts"
import { integerTypmodOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, lit, types } from "#compiler/sql/build.ts"

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

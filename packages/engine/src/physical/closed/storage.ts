import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { identity } from "#compiler/core/identity.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { onlyOf, rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { isIn, lit, types } from "#compiler/sql/build.ts"

/** The subset a closed id column holds and its roster, which only a column `closedSubset` holds of has. */
const subsetOf = (type: ScalarType) => ({
	roster: defined(rosterOf(type), "a closed id's roster"),
	only: defined(onlyOf(type), "a closed id of a subset")
})

/**
 * A closed id column's subset CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * closedId(R, { only }) or closedId(R, { except }) holds a subset S of R's handles (ir/scalar.ts CodeType `only`). Its
 * column is the roster's domain, which holds every live code of R, so the column carries the named CHECK of S's codes:
 *
 *     CONSTRAINT "__open_attribute_subset_class_<digest>" CHECK ("class" IN (3, 5, 8))
 *
 * The codec's host boundary admits a handle of S alone (scalar/values/identity.ts), so it refuses only a direct writer.
 * Its name is the naming door's hashed subsetCheck.
 */
export const closedSubset = Object.freeze({
	holds: (type: ScalarType): boolean => onlyOf(type) !== undefined,
	named: identity.subsetCheck,
	predicate: (b: InstallBuilder, column: Expr, type: ScalarType): Expr => {
		const { roster, only } = subsetOf(type)
		const codec = defined(
			b.names.codes.rosters.get(roster.closed),
			"the codebook holds every roster"
		)
		return isIn(
			column,
			mapNonEmpty(only, (handle) => lit.int(codeOf(codec, handle), types.smallint))
		)
	},
	reason: (relation: string, field: string, type: ScalarType): string => {
		const { roster, only } = subsetOf(type)
		return `the handles of ${roster.closed} ${relation}.${field} holds: ${only.join(", ")}`
	}
})

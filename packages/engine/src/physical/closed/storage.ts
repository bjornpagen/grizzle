import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { identity } from "#compiler/core/identity.ts"
import { type Codebook, codeOf } from "#compiler/ir/codes.ts"
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
 * `value IN (<the subset's codes>)`: a value of a closed id of a subset, `type`, held to its subset's codes in the
 * installation's codes, the one predicate a stored column's CHECK (closedSubset) and a variant's domain over an arm's
 * field of a subset (physical/ddl/variants.ts) state it by.
 */
export const subsetPredicate = (codes: Codebook, value: Expr, type: ScalarType): Expr => {
	const { roster, only } = subsetOf(type)
	const codec = defined(codes.rosters.get(roster.closed), "the codebook holds every roster")
	return isIn(
		value,
		mapNonEmpty(only, (handle) => lit.int(codeOf(codec, handle), types.smallint))
	)
}

/**
 * A closed id column's subset CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * closedId(R, { only }) or closedId(R, { except }) holds a subset S of R's handles (ir/scalar.ts CodeType `only`). Its
 * column is the roster's domain, which holds every live code of R, so the column carries the named CHECK of S's codes:
 *
 *     CONSTRAINT "__open_attribute_subset_class_<digest>" CHECK ("class" IN (3, 5, 8))
 *
 * The codec's host boundary admits a handle of S alone (scalar/values/identity.ts), so it refuses only a direct writer.
 * Its name is the naming door's hashed subsetCheck. A generated field, and a key generation, carries none: the analysis
 * admits a generation only of a type within the field's subset (analysis/schema.ts generatedTypeRule, ir/scalar.ts
 * subsetWithin), and a term's subset is a proof: a field's read of its CHECK or its generation, a variant's tag of its
 * domain's CHECK, a literal of its own handle, an operation of its operands', and no cast narrows one, so PostgreSQL
 * computes, and a key generation's row CHECK holds, a value of the subset alone.
 */
export const closedSubset = Object.freeze({
	holds: (type: ScalarType): boolean => onlyOf(type) !== undefined,
	generationProves: true,
	named: identity.subsetCheck,
	predicate: (b: InstallBuilder, column: Expr, type: ScalarType): Expr =>
		subsetPredicate(b.names.codes, column, type),
	reason: (relation: string, field: string, type: ScalarType): string => {
		const { roster, only } = subsetOf(type)
		return `the handles of ${roster.closed} ${relation}.${field} holds: ${only.join(", ")}`
	}
})

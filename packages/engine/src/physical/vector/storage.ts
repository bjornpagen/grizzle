import { identity } from "#compiler/core/identity.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { vectorFunctions } from "#compiler/lower/conservative/vector/index.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { lit, qualifiedCall, types } from "#compiler/sql/build.ts"

/** The pgvector extension a vector schema requires: its name, and the version admission verifies (scripts/pg/build.sh
 * builds the same tag). */
export const vectorExtension = { name: "vector", version: "0.8.7" } as const

export const isVectorType = (t: ScalarType): boolean => baseOf(t).carrier === "vector"

/** The predicate of the cosine-domain CHECK over the unqualified column `column`, as a row CHECK spells it. */
const normPredicate = (vectorSchema: string, column: Expr): Expr => ({
	kind: "between",
	expr: qualifiedCall(
		{
			kind: "qualified",
			schema: vectorSchema,
			name: vectorFunctions.norm,
			volatility: "IMMUTABLE"
		},
		[column]
	),
	low: lit.float(cosineNormMin, types.double),
	high: lit.float(cosineNormMax, types.double),
	not: false
})

/** A vector column's norm CHECK, a column CHECK (physical/ddl/column-checks.ts ColumnCheckKind).
 *
 * `vector(N)` is the column `<ext>.vector(N) NOT NULL`, the extension's own type qualified by the schema the
 * installation names (`columnType`), of N dimensions, 1-vectorMaxDimensions, plus the named CHECK of the cosine
 * domain (ir/carriers.ts cosineNormMin and cosineNormMax, the norms for which pgvector's binary32 cosine_distance is a
 * number in [0, 2]):
 *
 *     CONSTRAINT "__document_embedding_norm_value_<digest>"
 *       CHECK (("vector_ext"."vector_norm"("value") BETWEEN '3.3881317890172014e-21'::double precision
 *         AND '9223372036854775808'::double precision) IS TRUE)
 *
 * vector_norm accumulates in double precision, and the bounds are exact powers of two, so the CHECK is one exact
 * native comparison; it never invokes a model service and never normalizes. The codec's host boundary admits only a
 * vector of the domain, so it refuses only a direct writer, or a value within rounding of a bound on which the host and
 * the native summation order disagree. Its name is the naming door's hashed normCheck.
 *
 * The installation that stores or types any vector creates the extension if it is absent, `CREATE EXTENSION IF NOT
 * EXISTS vector SCHEMA <ext>`, in Setup, before the tables and domains that name its type (InstallBuilder.provider), and
 * so does one whose closed facts alone hold a vector, which their VALUES lists cast to its type. pgvector is not a
 * trusted extension: where the migration identity cannot create it, an administrator creates it first in that schema
 * and the statement finds it present (`vectorProvider`). A schema without vectors gets no extension object at all. */
export const vectorNorm = Object.freeze({
	holds: isVectorType,
	generationProves: false,
	named: identity.normCheck,
	predicate: (b: InstallBuilder, column: Expr): Expr =>
		normPredicate(b.settings.vectorSchema, column),
	reason: (relation: string, field: string): string =>
		`the cosine domain of ${relation}.${field}: vector_norm in [${cosineNormMin}, ${cosineNormMax}]`
})

/** The extension provider of an installation whose closed or derived relations type a vector, which no stored column's
 * type names: their VALUES lists and views cast to it (InstallBuilder.provider). */
export const vectorProvider = (b: InstallBuilder): void => {
	if (
		Object.values(b.model.theory.relations).some(
			(r) => r.kind !== "relation" && r.fields.some((c) => isVectorType(c.type))
		)
	) {
		b.provider("vector")
	}
}

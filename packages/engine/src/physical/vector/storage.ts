import { compareText } from "#compiler/core/canonical.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { vectorFunctions } from "#compiler/lower/conservative/vector/index.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/vector.ts"
import type { Expr, InlineConstraint } from "#compiler/sql/ast.ts"
import { lit, qualifiedCall, tableCol, types } from "#compiler/sql/build.ts"

/** The pgvector extension a vector schema requires: its name, and the version admission verifies (scripts/pg/build.sh
 * builds the same tag). */
export const vectorExtension = { name: "vector", version: "0.8.7" } as const

export const isVectorType = (t: ScalarType): boolean => baseOf(t).carrier === "vector"

/** The predicate of the cosine-domain CHECK over the unqualified column `column`, as a row CHECK spells it. */
const normPredicate = (vectorSchema: string, column: Expr): Expr => ({
	kind: "between",
	expr: qualifiedCall(vectorSchema, vectorFunctions.norm, [column]),
	low: lit.float(cosineNormMin, types.double),
	high: lit.float(cosineNormMax, types.double),
	not: false
})

/** A vector column's norm CHECK: its relation and field, its identity, and the constraint its table declares. */
interface VectorNorm {
	readonly relation: string
	readonly field: string
	readonly named: Identity<"normCheck">
	readonly constraint: InlineConstraint
}

const vectorColumns = (heading: ReadonlyArray<HeadingColumn>): ReadonlyArray<HeadingColumn> =>
	heading.filter((c) => isVectorType(c.type))

/** The norm CHECK of every vector column of every stored relation, in relation then field order, for its table's
 * CREATE TABLE to declare (`addVectorNorms` adds their objects once the tables stand).
 *
 * `pg.vector(N)` is the column `<ext>.vector(N) NOT NULL`, the extension's own type qualified by the schema the
 * installation names (`columnType`), of N dimensions, 1-16000, plus the named CHECK of the nondegenerate cosine domain:
 *
 *     CONSTRAINT "document_embedding__norm__value"
 *       CHECK (("vector_ext"."vector_norm"("value") BETWEEN '1.52587890625e-05'::double precision
 *         AND '65536'::double precision) IS TRUE)
 *
 * vector_norm accumulates in double precision, and the bounds are the exact binary values 2^-16 and 2^16, so the CHECK
 * is one exact native comparison; it never invokes a model service and never normalizes. It is declared inline by the
 * table's CREATE TABLE beside the row's other CHECKs, and PostgreSQL enforces it on every write, grizzle's or a direct
 * SQL writer's. It is a refinement of the field, not a law of the schema: it has no law id and no witness, and
 * grizzle's own writes meet the codec's host boundary first, so it refuses only a direct writer, or a value within
 * rounding of a bound on which the host and the native summation order disagree. The CHECK is
 * `<table>__norm__<column>`: its own name segment, so no declared check of the relation, `<table>__check__<name>`, can
 * claim it.
 *
 * The installation that stores or types any vector creates the extension if it is absent, `CREATE EXTENSION IF NOT
 * EXISTS vector SCHEMA <ext>`, in Setup, before the tables and domains that name its type (InstallBuilder.provider), and
 * so does one whose closed facts alone hold a vector, which their VALUES lists cast to its type. pgvector is not a
 * trusted extension: where the migration identity cannot create it, an administrator creates it first in that schema
 * and the statement finds it present. A schema without vectors gets no extension object at all. */
export const vectorNorms = (b: InstallBuilder): ReadonlyArray<VectorNorm> => {
	const relations = Object.entries(b.model.theory.relations).toSorted(([x], [y]) =>
		compareText(x, y)
	)
	if (relations.some(([, r]) => r.kind !== "relation" && vectorColumns(r.fields).length > 0)) {
		b.provider("vector")
	}
	return relations.flatMap(([name, r]) =>
		r.kind === "relation"
			? vectorColumns(r.fields).map((c): VectorNorm => {
					const named = identity.normCheck(name, c.name)
					return {
						relation: name,
						field: c.name,
						named,
						constraint: {
							kind: "check",
							name: b.name(named),
							predicate: normPredicate(
								b.settings.vectorSchema,
								tableCol(b.names.column(name, c.name))
							)
						}
					}
				})
			: []
	)
}

/** Each norm CHECK's object, which its table declares inline, so it carries no statement: after its table. */
export const addVectorNorms = (b: InstallBuilder, norms: ReadonlyArray<VectorNorm>): void => {
	for (const n of norms) {
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.settings.installation,
					relation: b.names.relationNamed(n.relation),
					name: n.named
				},
				ddl: [],
				reasons: [
					enforcement(`the cosine domain of ${n.relation}.${n.field}: vector_norm in [2^-16, 2^16]`)
				],
				phase: "structure"
			},
			[b.table(n.relation)]
		)
	}
}

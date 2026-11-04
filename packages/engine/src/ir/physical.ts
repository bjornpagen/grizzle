import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ColumnIdent, DomainName, RelationIdent } from "#compiler/core/ids.ts"
import { baseOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import type { QualifiedFunctionRef, TypeName, TypeRef, TypeSchema } from "#compiler/sql/ast.ts"
import { namedType, numericType, types } from "#compiler/sql/build.ts"

/** How the declared names of one schema map to PostgreSQL objects, each qualified by its schema. */
export interface PhysicalNames {
	/** The table of a relation, or the materialized view of a derived relation. */
	readonly relation: (relation: string) => { readonly schema: string; readonly name: RelationIdent }
	readonly column: (relation: string, field: string) => ColumnIdent
	/** The enum type of a closed roster, by its declared name: the naming door's (core/identity.ts identity.enumType). */
	readonly enumType: (closed: DeclaredName) => {
		readonly schema: TypeSchema
		readonly name: RelationIdent
	}
	/** The domain of a contract, by its declared name: the naming door's (core/identity.ts identity.contractDomain). */
	readonly contractDomain: (contract: DeclaredName) => {
		readonly schema: TypeSchema
		readonly name: DomainName
	}
	/**
	 * The structural __text_<slug> domain of a regex refinement, or undefined when the caller has none to name; the
	 * slug is the text package's, so the default knows none.
	 */
	readonly textDomain: (
		regex: RegexRef
	) => { readonly schema: TypeSchema; readonly name: DomainName } | undefined
	/** The schema the vector extension lives in (`vector_ext` on the local cluster), the schema of its vector type. */
	readonly vectorSchema: TypeSchema
	/**
	 * The installation's refusal function (write/refusal.ts), which a context source raises an unreadable claims
	 * setting through (sql/print.ts contextClaims).
	 */
	readonly refusal: QualifiedFunctionRef
}

/** The type an installed name names: an enum, a domain. */
export const qualifiedType = (name: TypeName): TypeRef => namedType(name.schema, name.name, [])

/**
 * The PostgreSQL base type of a scalar: what a literal in a persistent expression, and a cast that must not reach a
 * domain, is typed by. It drops every refinement, so it never names a contract's or a text refinement's domain; the
 * installer types columns by those (physical/ddl/names.ts columnType).
 */
export const baseTypeRef = (names: PhysicalNames, t: ScalarType): TypeRef => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "int2":
			return types.smallint
		case "int4":
			return types.integer
		case "int8":
			return types.bigint
		case "numeric":
			return b.typmod === undefined
				? types.numeric
				: numericType(b.typmod.precision, b.typmod.scale)
		case "float4":
			return types.real
		case "float8":
			return types.double
		case "money":
			return types.money
		case "bool":
			return types.boolean
		case "uuid":
			return types.uuid
		case "text":
			return types.text
		case "range4":
			return types.int4range
		case "range8":
			return types.int8range
		case "enum":
			return qualifiedType(names.enumType(b.roster.closed))
		case "vector":
			return namedType(names.vectorSchema, "vector", [b.typmod.dims])
		case "exactInteger":
			return b.digits <= 18 ? types.bigint : types.numeric
		case "exactMoney":
			return types.numeric
	}
}

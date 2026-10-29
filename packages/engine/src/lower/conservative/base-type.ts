import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import type { ObjectName, TypeRef } from "#compiler/sql/ast.ts"
import { namedType, numericType, types } from "#compiler/sql/build.ts"

/** The type an installed name names: an enum, a domain. */
export const qualifiedType = (name: ObjectName): TypeRef => namedType(name.schema, name.name, [])

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
	}
}

import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ColumnIdent, DomainName, RelationIdent } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { int8ExactDigits } from "#compiler/ir/carriers.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { baseOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import type {
	ObjectName,
	QualifiedFunctionRef,
	TypeName,
	TypeRef,
	TypeSchema
} from "#compiler/sql/ast.ts"
import { namedType, numericType, types } from "#compiler/sql/build.ts"

/**
 * A closed relation as its installed constants hold it, what a closed law's CHECK and a closed read read: its string of
 * cells' function, read `width` bits a cell at the mixed-radix index of its key fields' codes, each key field with its
 * radix, its code space holes included, in key order; its payload fields in declared order, each with its radix and,
 * for an open-typed field, the function of its dictionary, the field's values in code order, none for a closed id; and
 * the function of its key set, one bit per point of the key space, set where the relation holds a tuple.
 */
export interface ClosedConstant {
	readonly function: ObjectName
	readonly key: NonEmptyReadonlyArray<{ readonly field: string; readonly radix: number }>
	readonly width: number
	readonly payload: ReadonlyArray<{
		readonly field: string
		readonly radix: number
		readonly dictionary: ObjectName | undefined
	}>
	readonly keys: ObjectName
}

/** How the declared names of one schema map to PostgreSQL objects, each qualified by its schema. */
export interface PhysicalNames {
	/** The table of a relation, or the materialized view of a derived relation. */
	readonly relation: (relation: string) => { readonly schema: string; readonly name: RelationIdent }
	readonly column: (relation: string, field: string) => ColumnIdent
	/**
	 * A roster's domain, by its declared name: the naming door's (core/identity.ts identity.rosterDomain), what a code
	 * column, a code cast and a code parameter are typed by.
	 */
	readonly rosterDomain: (roster: DeclaredName) => {
		readonly schema: TypeSchema
		readonly name: DomainName
	}
	/**
	 * The domain of a set over a roster, by the roster's declared name: the naming door's (core/identity.ts
	 * identity.bitsDomain) at the roster's size in the installation's codes, bit(size) admitting only live codes' bits,
	 * what a set column, a set cast and a set parameter are typed by.
	 */
	readonly bitsDomain: (roster: DeclaredName) => {
		readonly schema: TypeSchema
		readonly name: DomainName
	}
	/**
	 * The domain of a contract, by its declared name: the naming door's (core/identity.ts identity.contractDomain), by
	 * the digest of its physical definition, which contracts of one definition share.
	 */
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
	 * The installation's codes (ir/codes.ts): every code literal, set literal and bit(n) width reads them, so the
	 * schema's artifacts are compiled for the installation that holds them.
	 */
	readonly codes: Codebook
	/** A closed relation's installed constants, by its declared name. */
	readonly closed: (relation: string) => ClosedConstant
	/**
	 * The installation's refusal function (write/refusal.ts), which a context source raises an unreadable claims
	 * setting through (sql/print.ts contextClaims).
	 */
	readonly refusal: QualifiedFunctionRef
}

/** The type an installed name names: a domain. */
export const qualifiedType = (name: TypeName): TypeRef => namedType(name.schema, name.name, [])

/**
 * The PostgreSQL base type of a scalar: what a literal in a persistent expression, and a cast that must not reach a
 * domain, is typed by. It drops every refinement, so it never names a contract's, a text refinement's or a roster's
 * domain; the installer types columns by those (physical/ddl/names.ts columnType). A closed id is its code, a smallint.
 * A set over a roster is its roster's bits domain, bit(n) with n its roster's codes, holes included, under the CHECK
 * that admits only live codes' bits: a bare bit(n) would pad or cut a set of another size silently, so no set is ever
 * typed by it.
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
		case "code":
			return types.smallint
		case "bits":
			return qualifiedType(names.bitsDomain(b.roster.closed))
		case "vector":
			return namedType(names.vectorSchema, "vector", [b.typmod.dims])
		case "exactInteger":
			return b.digits <= int8ExactDigits.value ? types.bigint : types.numeric
		case "exactMoney":
			return types.numeric
	}
}

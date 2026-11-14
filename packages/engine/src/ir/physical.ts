import { Refusal } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import type { DeclaredName, ParamPlace } from "#compiler/core/identity.ts"
import type { ColumnIdent, DomainName, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { int8ExactDigits } from "#compiler/ir/carriers.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	baseOf,
	contractOf,
	patternsText,
	type RegexRef,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type {
	Collation,
	QualifiedFunctionRef,
	TypeName,
	TypeRef,
	TypeSchema
} from "#compiler/sql/ast.ts"
import { cUtf8Collation, namedType, numericType, types } from "#compiler/sql/build.ts"
import type { ClosedConstant } from "#compiler/sql/constants.ts"

/**
 * A selection key's law column: a key over a selected side, `key(on(select(R, φ), f))`, installs the generated column
 * `CASE WHEN φ THEN f END` (laws/model LawColumn) under a UNIQUE NULLS DISTINCT, and this is that column, its term's
 * field `f` of R, and φ's conjuncts over R's row, one per field in declared order. The column equals `e` exactly where
 * every conjunct holds and `f = e`, for any `e` not NULL, so a read of R that holds every conjunct and fixes `f` reads
 * it by the column, which the UNIQUE's index serves (lower/conservative/match-region probeColumns).
 */
export interface SelectionKey {
	readonly column: ColumnIdent
	readonly field: string
	readonly guard: NonEmptyReadonlyArray<ScalarExpr>
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
	 * identity.bitsDomain) at the roster's width in the installation's codes, bit(width) admitting only live codes' bits,
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
	/**
	 * The pattern domain of a declared parameter's place over `regex`: the naming door's (core/identity.ts
	 * identity.paramDomain), by the place and the digest of the pattern's definition, which every placeholder of the
	 * parameter is cast to, so PostgreSQL checks its value against the pattern as it binds it and a refusal names the
	 * parameter. The installation creates it for every pattern its served workload's parameters name.
	 */
	readonly paramDomain: (
		place: ParamPlace,
		regex: RegexRef
	) => { readonly schema: TypeSchema; readonly name: DomainName }
	/** The schema the vector extension lives in (`vector_ext` on the local cluster), the schema of its vector type. */
	readonly vectorSchema: TypeSchema
	/**
	 * The installation's codes (ir/codes.ts): every code literal, set literal and bit(n) width reads them, so the
	 * schema's artifacts are compiled for the installation that holds them.
	 */
	readonly codes: Codebook
	/** A closed relation's installed constants, by its declared name. */
	readonly closed: (relation: string) => ClosedConstant
	/** The selection keys' law columns of a stored relation, by its declared name (`SelectionKey`): none for a
	 * relation with none. */
	readonly selectionKeys: (relation: string) => ReadonlyArray<SelectionKey>
	/**
	 * The installation's refusal function (write/refusal.ts), which a context source raises an unreadable claims
	 * setting through (sql/print.ts contextClaims).
	 */
	readonly refusal: QualifiedFunctionRef
}

/** A name the owned schema cannot supply is a defect of the caller's input, refused as MalformedDescription.
 * A function declaration, so that control flow knows a call never returns. */
export function missing(capability: string): never {
	throw new Refusal(malformedDescription(SourceLoc("physical names", []), capability))
}

/** The type an installed name names: a domain. */
export const qualifiedType = (name: TypeName): TypeRef => namedType(name.schema, name.name, [])

/**
 * The PostgreSQL base type of a scalar: what a literal in a persistent expression, and a cast that must not reach a
 * domain, is typed by. It drops every refinement, so it never names a contract's, a text refinement's or a roster's
 * domain; the installer types columns by those (fieldColumnType). A closed id is its code, a smallint.
 * A set over a roster is its roster's bits domain, bit(n) with n its roster's codes, holes included, rounded up to whole
 * hex digits, under the CHECK that admits only live codes' bits: a bare bit(n) would pad or cut a set of another size silently, so no set is ever
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
		case "date":
			return types.date
		case "text":
			return types.text
		case "bytes":
			return types.bytea
		case "range4":
			return types.int4range
		case "range8":
			return types.int8range
		case "rangeDate":
			return types.daterange
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

/** The column type of a scalar, with the fixed collation when the type is builtin text. */
export interface ColumnType {
	readonly type: TypeRef
	/** The fixed collation of builtin text; undefined for every other type. */
	readonly collation: Collation | undefined
}

/** The type a column or a cast of this scalar names: the contract's domain, the text refinement's domain, or the base. */
export const fieldColumnType = (names: PhysicalNames, t: ScalarType): ColumnType => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	if (t.carrier === "text" && t.text.regex !== "wildcard") {
		const domain = names.textDomain(t.text.regex)
		if (domain === undefined) {
			missing(`physical: no structural text domain for ${patternsText(t.text.regex.patterns)}`)
		}
		return { type: qualifiedType(domain), collation: undefined }
	}
	return collated(refinedBase(names, t))
}

/**
 * The type a value of `t` is stored and cast as once its contract and text refinement are set aside: a closed id's
 * roster domain, its codes' range proof, or the base type.
 */
const refinedBase = (names: PhysicalNames, t: ScalarType): TypeRef => {
	const b = baseOf(t)
	return b.carrier === "code"
		? qualifiedType(names.rosterDomain(b.roster.closed))
		: baseTypeRef(names, t)
}

/** A column type of `type`, with the fixed collation when it is builtin text. */
const collated = (type: TypeRef): ColumnType => ({
	type,
	collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
})

/**
 * The type of a column a law adds (a constant tag, a partial term, a family's drawn column): its held field's type's
 * base, the fixed collation for text, and never a contract's, a pattern's or a roster's domain.
 *
 * - A fold's hidden accumulator holds the fold's running value, filled in its carrier (runtime/write/fill.ts), which the
 *   plane's contract need not admit between members: a sum under an upper bound can pass the bound and come back under
 *   it, so the contract's domain would refuse a state whose laws hold.
 * - Every other law column holds a value of its field's type, or NULL outside its selection: a field's own, which its
 *   column's domain checked; the law model's literal of the type; pred of a natural, x - 1 where x > 0; or a natural
 *   the host draws, a count copy, an index or a parent start. A domain would only judge again, on every row, what
 *   the law model proves.
 *
 * A set's base is its bits domain, which admits NULL as every domain does (sql/print.ts).
 */
export const lawColumnType = (names: PhysicalNames, t: ScalarType): ColumnType =>
	collated(baseTypeRef(names, t))

/** A contract domain's base: an inner contract's domain, a closed id's roster domain, or the unrefined base type,
 * `text` collated for a refined text base, whose pattern the outer domain's own CHECK carries. */
export const domainBase = (names: PhysicalNames, base: ScalarType): ColumnType => {
	const contract = contractOf(base)
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	return collated(refinedBase(names, base))
}

import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { flatMapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { Refusal, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { malformedDescription } from "#compiler/core/errors.ts"
import { type RowTypeDigest, rowTypeDigest } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	type ParamPlace
} from "#compiler/core/identity.ts"
import type { ColumnIdent, DomainName, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { int8ExactDigits } from "#compiler/ir/carriers.ts"
import { type Codebook, codecOf } from "#compiler/ir/codes.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { ClosedTheoryRelation } from "#compiler/ir/law.ts"
import type { InstalledSpellings } from "#compiler/ir/pattern.ts"
import type { ClosedIndex } from "#compiler/ir/rel.ts"
import { baseOf, regexOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import type {
	Collation,
	ColumnDefinition,
	QualifiedFunctionRef,
	TypeName,
	TypeRef,
	TypeSchema
} from "#compiler/sql/ast.ts"
import { arrayOf, cUtf8Collation, namedType, numericType, types } from "#compiler/sql/build.ts"
import type { ClosedConstant } from "#compiler/sql/constants.ts"
import type { StoredColumns } from "#compiler/sql/stored.ts"

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

/**
 * grizzle's library: the SQL functions of its own that a scalar operation's SQL calls, each a constant of parameters
 * (sql/ast.ts CreateConstant) named by its definition's digest (physical/ddl/library.ts), which an installation installs
 * where its schema's persistent expressions call it: cutBefore and cutFrom, a text cut at the first of a set of
 * characters (scalar/compute/registry.ts textCut); isXsdPattern, whether a text is an XML Schema 1.0 pattern
 * (textIsXsdPattern); resolveReference, RFC 3986's resolution of a reference against a
 * base (textResolveReference); textDigest, a text's SHA-256 (textSha256); and wall, a zone's wall clock at an instant
 * by PostgreSQL's tzdata (zoneWall), which an installation installs where a program of its served workload calls it.
 */
export const libraryFns = [
	"cutBefore",
	"cutFrom",
	"isXsdPattern",
	"resolveReference",
	"textDigest",
	"wall"
] as const
export type LibraryFn = (typeof libraryFns)[number]

/** How the declared names of one schema map to PostgreSQL objects, each qualified by its schema. */
export interface PhysicalNames {
	/** The table of a relation, or the table of a stored derived relation. */
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
	 * A roster's names constant, by its declared name (physical/ddl/constants.ts namesConstant): its handles in code
	 * order as one name[], which a zone's closed id is read through as its IANA name (registry.ts zoneWall).
	 */
	readonly rosterNames: (roster: DeclaredName) => QualifiedFunctionRef
	/**
	 * The domain of a contract, by its declared name: the naming door's (core/identity.ts identity.contractDomain), by
	 * the digest of its physical definition, which contracts of one definition share.
	 */
	readonly contractDomain: (contract: DeclaredName) => {
		readonly schema: TypeSchema
		readonly name: DomainName
	}
	/**
	 * The structural text domain of a regex refinement: the naming door's (core/identity.ts identity.textDomain), by the
	 * digest of its definition, which the installation holds for every refinement any artifact over it types a value by
	 * (physical/ddl/domains.ts planTextDomains), so every refinement has one, and a name outside an installation's set
	 * is refused as UninstalledDomain where the statement naming it is compiled.
	 */
	readonly textDomain: (regex: RegexRef) => {
		readonly schema: TypeSchema
		readonly name: DomainName
	}
	/**
	 * The pattern domain of a declared parameter's place over `regex`: the naming door's (core/identity.ts
	 * identity.paramDomain), by the place and the digest of its definition over the pattern's structural text domain,
	 * which every placeholder of the parameter is cast to, so PostgreSQL checks its value against the pattern as it
	 * binds it and a refusal names the parameter. The installation creates it for every pattern its served workload's parameters name.
	 */
	readonly paramDomain: (
		place: ParamPlace,
		regex: RegexRef
	) => { readonly schema: TypeSchema; readonly name: DomainName }
	/**
	 * The installation's digest domain (core/identity.ts identity.digestDomain), bytea of exactly 32 bytes, what a
	 * digest column is typed by; a digest's cast and parameter are bytea, its length held at the door.
	 */
	readonly digestDomain: { readonly schema: TypeSchema; readonly name: DomainName }
	/** The schema the vector extension lives in (`vector_ext` on the local cluster), the schema of its vector type. */
	readonly vectorSchema: TypeSchema
	/**
	 * The installation's schemas, each level's: every schema of the objects these names name but the environment's,
	 * pg_catalog and an extension's, which an object's identity reads its definition apart from
	 * (sql/type-schemas.ts digestedHooks).
	 */
	readonly installed: ReadonlySet<string>
	/**
	 * The installation's codes (ir/codes.ts) of the rosters the schema declares, its level's and those below it, each
	 * one whose domains the names name (physical/ddl/names.ts levelCodes): every code literal, set literal and bit(n)
	 * width reads them, so the schema's artifacts are compiled for the installation that holds them.
	 */
	readonly codes: Codebook
	/**
	 * How the installation spells each pattern a match reads (ir/pattern.ts InstalledSpellings): one spelling of each
	 * language it installs, its history as its codes are, whose ARE every statement reads.
	 */
	readonly spellings: InstalledSpellings
	/** A closed relation's installed constants, by its declared name. */
	readonly closed: (relation: string) => ClosedConstant
	/**
	 * A library function of the installation (`LibraryFn`), qualified by the installation's schema, where the
	 * installation installs it: one any of its artifacts or a program of its served workload calls
	 * (physical/install/plan.ts artifactObjects, ServedTypes `library`). Any other is refused as UninstalledFunction
	 * where the statement calling it is compiled, never by PostgreSQL where it runs.
	 */
	readonly library: (fn: LibraryFn) => QualifiedFunctionRef
	/**
	 * The closed relations' theories, by their declared names: their headings, rows and the values a read of one takes
	 * (lower/conservative/expr/share.ts).
	 */
	readonly closedRelations: ReadonlyMap<string, ClosedTheoryRelation>
	/**
	 * The closed relations indexed for the host's reads of them (runtime/write/fill.ts closedIndexOf), by their declared
	 * names: what a constant subterm's C.at, C.row and C.has evaluate to where a persistent expression or a query's is
	 * lowered (physical/ddl/expr.ts plannedConstants, lower/conservative/expr/share.ts). Made once for the installation,
	 * so no expression a lowering rewrites reads a relation's rows.
	 */
	readonly closedIndex: ClosedIndex
	/** The selection keys' law columns of a stored relation, by its declared name (`SelectionKey`): none for a
	 * relation with none. */
	readonly selectionKeys: (relation: string) => ReadonlyArray<SelectionKey>
	/**
	 * The installation's refusal function (write/refusal.ts), which a context source raises an unreadable claims
	 * setting through (sql/print.ts contextClaims).
	 */
	readonly refusal: QualifiedFunctionRef
	/**
	 * The text columns a B-tree holds the suffix key of (sql/suffix.ts StoredColumns), whose every suffix test a
	 * statement reads as its key's range (seekingSuffixes): a judged read's own seeks' (physical/ddl/rules.ts), none for
	 * any other statement, which no suffix key serves.
	 */
	readonly suffixed: StoredColumns
	/**
	 * A declared function, by its declared name (schema/function.ts fn): its installed name, in the schema of the level
	 * that declares it, where its row types are too (physical/ddl/functions.ts).
	 */
	readonly declaredFunction: (name: string) => {
		readonly ref: QualifiedFunctionRef
		readonly types: TypeSchema
	}
}

/**
 * The row type of a heading in its schema (rowTypeOf): its attributes, the digest of its definition, which names it,
 * and its type.
 */
export interface RowType {
	readonly attributes: NonEmptyReadonlyArray<ColumnDefinition>
	readonly definition: RowTypeDigest
	readonly named: Identity<"rowType">
	readonly type: TypeRef
}

/** An attribute of a row type: a value of a scalar, or rows of another row type (an array of it) or one row of one. */
export type RowAttribute =
	| { readonly kind: "value"; readonly type: ScalarType }
	| { readonly kind: "rows" | "row"; readonly rowType: RowType }

/**
 * The row type of a heading a declared function's signature names, in its function's schema `schema`: its attributes,
 * a value's its field's base type, text collated as every grizzle column is (lawColumnType), rows of another heading's
 * an array of that one's row type and one row's that row type itself, both of the same schema, which the installation
 * creates first; and its type, named by the digest of its definition (core/identity.ts identity.rowType), each value
 * attribute as it stands and each other by the definition of the row type it holds, so equal headings share it at any
 * level, and a heading of values alone has the name it had before a heading could hold another. The installation
 * creates it (physical/ddl/functions.ts), and a call's rows argument casts each element to it.
 */
export const rowTypeOf = (
	names: PhysicalNames,
	schema: TypeSchema,
	heading: NonEmptyReadonlyArray<{ readonly name: string; readonly type: RowAttribute }>
): RowType => {
	const valueColumn = (name: string, type: ScalarType): ColumnDefinition => {
		const column = lawColumnType(names, type)
		return { name, type: column.type, collation: column.collation }
	}
	const attributes = flatMapNonEmpty(heading, (f): NonEmptyReadonlyArray<ColumnDefinition> => {
		switch (f.type.kind) {
			case "value":
				return [valueColumn(f.name, f.type.type)]
			case "rows":
				return [
					{
						name: f.name,
						type: defined(arrayOf(f.type.rowType.type), "the array of a row type"),
						collation: undefined
					}
				]
			case "row":
				return [{ name: f.name, type: f.type.rowType.type, collation: undefined }]
		}
	})
	const definition = rowTypeDigest(
		heading.map((f) =>
			f.type.kind === "value"
				? valueColumn(f.name, f.type.type)
				: { name: f.name, [f.type.kind]: f.type.rowType.definition }
		),
		withoutSourceLocs
	)
	const named = identity.rowType(definition)
	return { attributes, definition, named, type: namedType(schema, identifierOf(named), []) }
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
 * bytes, under the CHECK that admits only live codes' bits: a bare bit(n) would pad or cut a set of another size silently, so no set is ever
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
		case "inet":
			return types.inet
		case "cidr":
			return types.cidr
		case "text":
			return types.text
		case "bytes":
		case "sha256":
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
		case "tsvector":
			return types.tsvector
		case "exactInteger":
			return b.digits <= int8ExactDigits ? types.bigint : types.numeric
		case "exactMoney":
			return types.numeric
	}
}

/**
 * The type a session's own object holds a value of `t` by: a write's carrier, a staged one, a rule judge's delta. It is
 * the value's base type (baseTypeRef), but a set's: baseTypeRef reads a set as its roster's bits domain, and a session's
 * object holds it by the domain's own base, bit(n) of the roster's width, which a value of another length entering it
 * refuses (22026). So no session object names an installation's domain: PostgreSQL refuses to drop a domain a column of
 * another session's temporary table is typed by (2BP01) and to add a constraint to it ("cannot access temporary tables
 * of other sessions"), and refuses the table to a role without USAGE on the domain (42501); a value reaches its stored
 * column through the column's domain, which judges it there.
 */
export const sessionTypeRef = (names: PhysicalNames, t: ScalarType): TypeRef => {
	const b = baseOf(t)
	return b.carrier === "bits"
		? types.bit(codecOf(names.codes, b.roster).width)
		: baseTypeRef(names, t)
}

/** The column type of a scalar, with the fixed collation when the type is builtin text. */
export interface ColumnType {
	readonly type: TypeRef
	/** The fixed collation of builtin text; undefined for every other type. */
	readonly collation: Collation | undefined
}

/**
 * The type a column or a cast of this scalar names: the contract's domain, the text refinement's structural domain, or
 * the base. It is the one physical type of a value of `t` wherever grizzle types one: a stored or view column, a
 * carrier's column, a cast, and a declared function's result as each read of it casts it (lower/conservative/call),
 * that cast being the one check PostgreSQL makes of what the function's body returned.
 */
export const fieldColumnType = (names: PhysicalNames, t: ScalarType): ColumnType => {
	const { contract } = t
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	const regex = t.carrier === "text" ? regexOf(t.text) : undefined
	if (regex !== undefined) {
		return { type: qualifiedType(names.textDomain(regex)), collation: undefined }
	}
	return collated(refinedBase(names, t))
}

/**
 * The type a value of `t` is stored and cast as once its contract and text refinement are set aside: a closed id's
 * roster domain, its codes' range proof; a digest's domain, its length's; or the base type.
 */
const refinedBase = (names: PhysicalNames, t: ScalarType): TypeRef => {
	const b = baseOf(t)
	switch (b.carrier) {
		case "code":
			return qualifiedType(names.rosterDomain(b.roster.closed))
		case "sha256":
			return qualifiedType(names.digestDomain)
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "text":
		case "bytes":
		case "bits":
		case "inet":
		case "cidr":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
			return baseTypeRef(names, t)
	}
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
	const { contract } = base
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	return collated(refinedBase(names, base))
}

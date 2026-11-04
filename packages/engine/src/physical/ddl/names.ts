import { nominal } from "#compiler/core/brand.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity,
	maxIdentifierBytes,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import type { ConstraintName, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { baseTypeRef, qualifiedType } from "#compiler/lower/conservative/base-type.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import type { Owned, OwnedEntry, OwnedRole } from "#compiler/schema/own.ts"
import type { Collation, FunctionName, ObjectName, TypeRef, TypeSchema } from "#compiler/sql/ast.ts"
import { cUtf8Collation } from "#compiler/sql/build.ts"
import { type OutsideProbe, probeIdentity } from "#compiler/write/insert/unique.ts"

/** A name the owned schema cannot supply is a defect of the caller's input, refused as MalformedDescription.
 * A function declaration, so that control flow knows a call never returns. */
export function missing(capability: string): never {
	throw new Refusal(malformedDescription(SourceLoc("physical names", []), capability))
}

const typeSchema = nominal<string, TypeSchema>()

/** The schema of the types an installation holds, its enums and domains: its own, by its identity. */
export const installationTypes = (installation: Identity<"schema">): TypeSchema =>
	typeSchema(identifierOf(installation))

/** The schema of the vector extension's types, the one the installation was given for the extension. */
export const vectorTypes = (schema: string): TypeSchema => typeSchema(schema)

export interface InstallNames extends PhysicalNames {
	/** The identity of the PostgreSQL schema every object is created in, which every role installed beside it embeds. */
	readonly installation: Identity<"schema">
	/** The PostgreSQL schema every object is created in, the installation's identifier. */
	readonly schema: string
	/** The same schema as the schema of the types it holds, its enums and domains. */
	readonly types: TypeSchema
	/** The identity sequence of a serial field. */
	readonly sequence: (relation: string, field: string) => ObjectName
	/** A serial field's advance function, which takes the bigint to advance past. */
	readonly advance: (relation: string, field: string) => ObjectName
	/** The primary key constraint of a stored relation, which an insert into a span primary key names as its
	 * arbiter. */
	readonly primaryKey: (relation: string) => ConstraintName
	/** The identity a relation's table, enum type or materialized view is named by. */
	readonly relationNamed: (relation: string) => Identity<"table" | "enum" | "view">
}

interface NamesInput {
	readonly owned: Owned
	readonly installation: Identity<"schema">
	readonly vectorSchema: string
	/** The canonical pattern key digests the installation gives a structural text domain. */
	readonly textDomains: ReadonlySet<string>
}

/** A login's or role's PostgreSQL role, `<schema>__<name>`, longer than PostgreSQL's `limit` bytes. */
export interface RoleTooLong {
	readonly role: string
	readonly limit: number
}

/** A login's or role's PostgreSQL role, when it fits PostgreSQL's 63 bytes with its schema's name. */
const fittedRole = <K extends "login" | "role">(
	named: Identity<K>
): Result.Result<Identity<K>, RoleTooLong> =>
	utf8Length(named.identifier) > maxIdentifierBytes
		? Result.err({ role: named.identifier, limit: maxIdentifierBytes })
		: Result.ok(named)

/** A login's or role's PostgreSQL role (fittedRole), or its refusal at `loc`. */
const fitted = <K extends "login" | "role">(named: Identity<K>, loc: SourceLoc): Identity<K> => {
	const role = fittedRole(named)
	if (!role.ok) {
		throw new Refusal(
			CompileError.make({
				_tag: "RoleNameTooLong",
				at: loc,
				of: named.kind,
				role: role.error.role,
				limit: role.error.limit
			})
		)
	}
	return role.value
}

/** A login's PostgreSQL role, under the installation (roles are cluster-wide), by the name its ownership declared
 * (schema/own.ts ownLogin), when it fits PostgreSQL's 63 bytes. */
export const fittedLogin = (
	installation: Identity<"schema">,
	name: DeclaredName
): Result.Result<Identity<"login">, RoleTooLong> => fittedRole(identity.login(installation, name))

/** A login's PostgreSQL role (fittedLogin), or its refusal at `loc`. */
export const loginIdentity = (
	installation: Identity<"schema">,
	name: DeclaredName,
	loc: SourceLoc
): Identity<"login"> => fitted(identity.login(installation, name), loc)

/** A role's PostgreSQL role, its theory role, under the installation, by the name its ownership declared
 * (schema/own.ts ownRole). */
export const roleIdentity = (
	installation: Identity<"schema">,
	name: DeclaredName,
	loc: SourceLoc
): Identity<"role"> => fitted(identity.role(installation, name), loc)

/** A role relation's view in its role's schema, by the name role ownership declared (schema/own.ts ownRole). */
export const roleView = (role: Identity<"role">, e: OwnedEntry): Identity<"roleView"> =>
	identity.roleView(role, e.name)

/**
 * The column a reference to a view's field names, a derived relation's or a role query entry's, its name parsed where
 * the reference resolves. Every field a heading names was declared, by its analysis (analysis/derived/analyze.ts
 * declaredHeading), so a reference that does not parse resolves to nothing, refused as MalformedDescription.
 */
const viewColumn = (field: string): Identity<"column"> => {
	const parsed = parseDeclaredName(field)
	if (!parsed.ok) {
		missing(`physical: the view field ${JSON.stringify(field)}, a name ${parsed.error}`)
	}
	return identity.column(parsed.value)
}

/** The installed names of one role: its theory role, its schema, each relation's view, each writable entry's filter
 * function and each of its probes, by their argument types: a filter function's T's fields the membership reads, a
 * probe's its parameters (write/insert/unique.ts probeParams), each at its base type. A probe is named by its identity
 * (`probe`, write/insert/unique.ts probeIdentity), the one the installation creates it by; a key probe is also named by
 * its key's fields (`keyProbe`) and a unique probe by its object's installed name (`uniqueProbe`), which is that
 * identity. */
export interface WorldNames {
	readonly role: string
	readonly schema: string
	readonly view: (relation: string) => { readonly schema: string; readonly name: RelationIdent }
	readonly filterFunction: (entry: string, args: ReadonlyArray<TypeRef>) => FunctionName
	readonly probe: (entry: string, probe: OutsideProbe, args: ReadonlyArray<TypeRef>) => FunctionName
	readonly keyProbe: (
		entry: string,
		key: ReadonlyArray<string>,
		args: ReadonlyArray<TypeRef>
	) => FunctionName
	readonly uniqueProbe: (
		entry: string,
		object: ConstraintName,
		args: ReadonlyArray<TypeRef>
	) => FunctionName
}

/** The names of a role, installed under `installation`. A theory role that does not fit 63 bytes with the installation's
 * name is refused as MalformedDescription, thrown as a Refusal; an installation, which names every one first, has
 * refused it already. */
export const worldNames = (role: OwnedRole, installation: Identity<"schema">): WorldNames => {
	const theory = roleIdentity(installation, role.name, role.loc)
	const schema = identifierOf(installation)
	const roleSchema = identifierOf(identity.roleSchema(theory))
	return {
		role: identifierOf(theory),
		schema: roleSchema,
		view: (relation) => {
			const e = role.relations[relation]
			if (e === undefined) {
				missing(`physical: no relation ${relation} in role ${role.name}`)
			}
			return { schema: roleSchema, name: identifierOf(roleView(theory, e)) }
		},
		filterFunction: (entry, args) => ({
			schema,
			name: identifierOf(identity.filter(theory, entry)),
			args
		}),
		probe: (entry, probe, args) => ({
			schema,
			name: identifierOf(probeIdentity(theory, entry, probe)),
			args
		}),
		keyProbe: (entry, key, args) => ({
			schema,
			name: identifierOf(identity.keyProbe(theory, entry, key)),
			args
		}),
		uniqueProbe: (entry, object, args) => ({
			schema,
			name: identifierOf(identity.uniqueProbe(theory, entry, object)),
			args
		})
	}
}

/** What a role reads its relations through: every relation of it is its view in the role's schema, a whole entry's
 * columns its table's (or its materialized view's) and a query entry's its definition's head fields, each a field's
 * column; enums, domains and the vector extension stay the base's. */
export const roleReadNames = (names: InstallNames, role: OwnedRole): PhysicalNames => {
	const world = worldNames(role, names.installation)
	return {
		...names,
		relation: world.view,
		column: (relation, field) => {
			const e = role.relations[relation]
			if (e === undefined) {
				missing(`physical: no relation ${relation} in role ${role.name}`)
			}
			return e.kind === "whole"
				? names.column(e.relation.name, field)
				: identifierOf(viewColumn(field))
		}
	}
}

const relationOf = (owned: Owned, relation: string) => {
	const r = owned.relations[relation]
	if (r === undefined) {
		missing(`physical: no relation ${relation} in the owned schema`)
	}
	return r
}

/** The installed names of one schema, gathered under the PostgreSQL schema the installation targets, so the installer,
 * the grants and the query lowerings (`PhysicalNames`) address one set of objects. Every name is minted at the naming
 * door (core/identity.ts) from the identity of what it names: ownership mints the relations', fields', contracts',
 * keys', checks' and sequences', the law model those of the objects it specializes, and the installer every other
 * one, a structural text domain by its pattern key's digest.
 *
 * The worlds' names (`worldNames`) are minted from declared names under the installation's identity: a login's
 * PostgreSQL role and a role's, its theory role (roles are cluster-wide); a role's schema; in it one view per role
 * relation, whose columns are its fields'; a role's policy on a table it writes; a writable entry's filter function,
 * key probes and unique probes in the base schema.
 *
 * Column types: a contract column is typed by its domain, a refined text column by its structural domain, a wildcard
 * text column is `text COLLATE pg_catalog.pg_c_utf8`, a closedId by its roster's enum, a span by int4range or
 * int8range, a vector by the extension's vector(N), and every other scalar by the native type of its name. The base
 * type, which drops every refinement, is the lowering's. */
export const installNames = (input: NamesInput): InstallNames => {
	const { owned, installation } = input
	const schema = identifierOf(installation)
	const types = installationTypes(installation)
	return {
		installation,
		schema,
		types,
		vectorSchema: vectorTypes(input.vectorSchema),
		refusal: { kind: "qualified", schema, name: identifierOf(identity.refusal()) },
		relation: (relation) => ({ schema, name: relationOf(owned, relation).ident }),
		column: (relation, field) => {
			const r = relationOf(owned, relation)
			if (r.kind === "derived") {
				return identifierOf(viewColumn(field))
			}
			const f = r.fields[field]
			if (f === undefined) {
				missing(`physical: no field ${relation}.${field}`)
			}
			return f.column
		},
		enumType: (closed) => ({ schema: types, name: identifierOf(identity.enumType(closed)) }),
		/** A contract's domain by its name, whether the base declares it or a context field does: ownership named a base
		 * contract's, the installer a context contract's (`contextContracts`). */
		contractDomain: (contract) => ({
			schema: types,
			name: identifierOf(identity.contractDomain(contract))
		}),
		textDomain: (regex) =>
			input.textDomains.has(regex.key)
				? { schema: types, name: identifierOf(identity.textDomain(regex.key)) }
				: undefined,
		sequence: (relation, field) => {
			const sequence = relationOf(owned, relation).fields[field]?.sequence
			if (sequence === undefined) {
				missing(`physical: ${relation}.${field} has no identity sequence`)
			}
			return { schema, name: identifierOf(sequence) }
		},
		advance: (relation, field) => {
			if (relationOf(owned, relation).fields[field]?.sequence === undefined) {
				missing(`physical: ${relation}.${field} has no identity sequence`)
			}
			return { schema, name: identifierOf(identity.advance(relation, field)) }
		},
		primaryKey: (relation) => {
			const key = relationOf(owned, relation).keys.find((k) => k.primary)
			if (key === undefined) {
				missing(`physical: ${relation} has no primary key`)
			}
			return key.constraint
		},
		relationNamed: (relation) => relationOf(owned, relation).named
	}
}

/** The column type of a scalar, with the fixed collation when the type is builtin text. */
interface ColumnType {
	readonly type: TypeRef
	/** The fixed collation of builtin text; undefined for every other type. */
	readonly collation: Collation | undefined
}

/** The type a column or a cast of this scalar names: the contract's domain, the text refinement's domain, or the base. */
export const columnType = (names: PhysicalNames, t: ScalarType): ColumnType => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	if (t.carrier === "text" && t.text.regex !== "wildcard") {
		const domain = names.textDomain(t.text.regex)
		if (domain === undefined) {
			missing(
				`physical: no structural text domain for /${t.text.regex.source}/${t.text.regex.flags}`
			)
		}
		return { type: qualifiedType(domain), collation: undefined }
	}
	const type = baseTypeRef(names, t)
	return {
		type,
		collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
	}
}

/** A contract domain's base: an inner contract's domain, or the unrefined base type, `text` collated for a
 * refined text base, whose pattern the outer domain's own CHECK carries. */
export const domainBase = (names: PhysicalNames, base: ScalarType): ColumnType => {
	const contract = contractOf(base)
	if (contract !== undefined) {
		return { type: qualifiedType(names.contractDomain(contract.name)), collation: undefined }
	}
	const type = baseTypeRef(names, base)
	return {
		type,
		collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
	}
}

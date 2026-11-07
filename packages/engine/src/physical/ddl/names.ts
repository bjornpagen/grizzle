import { nominal } from "#compiler/core/brand.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { DomainDigest } from "#compiler/core/fingerprint.ts"
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
import type { Codebook, RosterCodec } from "#compiler/ir/codes.ts"
import type { DomainCheck } from "#compiler/ir/law.ts"
import {
	baseTypeRef,
	type PhysicalNames,
	qualifiedType,
	type SelectionKey
} from "#compiler/ir/physical.ts"
import { baseOf, contractOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import type { NamedNative } from "#compiler/laws/model/model.ts"
import type { Owned, OwnedEntry, OwnedRole } from "#compiler/schema/own.ts"
import type { Collation, FunctionName, ObjectName, TypeRef, TypeSchema } from "#compiler/sql/ast.ts"
import { cUtf8Collation } from "#compiler/sql/build.ts"
import type { ClosedConstant } from "#compiler/sql/constants.ts"
import { type OutsideProbe, probeIdentity } from "#compiler/write/insert/unique.ts"

/** A name the owned schema cannot supply is a defect of the caller's input, refused as MalformedDescription.
 * A function declaration, so that control flow knows a call never returns. */
export function missing(capability: string): never {
	throw new Refusal(malformedDescription(SourceLoc("physical names", []), capability))
}

const typeSchema = nominal<string, TypeSchema>()

/** The schema of the types an installation holds, its domains: its own, by its identity. */
export const installationTypes = (installation: Identity<"schema">): TypeSchema =>
	typeSchema(identifierOf(installation))

/** The schema of the vector extension's types, the one the installation was given for the extension. */
export const vectorTypes = (schema: string): TypeSchema => typeSchema(schema)

export interface InstallNames extends PhysicalNames {
	/** The identity of the PostgreSQL schema every object is created in, which every role installed beside it embeds. */
	readonly installation: Identity<"schema">
	/** The PostgreSQL schema every object is created in, the installation's identifier. */
	readonly schema: string
	/** The same schema as the schema of the types it holds, its domains. */
	readonly types: TypeSchema
	/** The identity sequence of a serial field. */
	readonly sequence: (relation: string, field: string) => ObjectName
	/** A serial field's advance function, which takes the bigint to advance past. */
	readonly advance: (relation: string, field: string) => ObjectName
	/** The primary key constraint of a stored relation, which an insert into a span primary key names as its
	 * arbiter. */
	readonly primaryKey: (relation: string) => ConstraintName
	/** The identity a relation's table, roster domain or materialized view is named by. */
	readonly relationNamed: (relation: string) => Identity<"table" | "rosterDomain" | "view">
	/**
	 * The identity of a contract's domain, by the contract's declared name: the digest of the domain's physical definition
	 * (W6.Q10), so contracts of one definition share one domain. Its CHECK is `identity.domainCheck` of it.
	 */
	readonly contractNamed: (contract: DeclaredName) => Identity<"contractDomain">
	/** The identity of the structural text domain of a pattern the installation names, by its definition's digest. */
	readonly textNamed: (regex: RegexRef) => Identity<"textDomain"> | undefined
}

/**
 * What a contract's domain is defined from: its base and its CHECK, the law model's domain native's for a base
 * contract and a context contract's own, from which `define` spells the domain's definition over the installation's
 * names (physical/ddl/domains.ts contractDomainDdl), whose digest names the domain.
 */
export interface ContractSource {
	readonly base: ScalarType
	readonly check: DomainCheck
}

/**
 * Each stored relation's selection keys' law columns (ir/physical.ts SelectionKey), from the law model's natives: every
 * law column generated under a non-empty guard whose term is a field of its relation, and which a UNIQUE's columns
 * hold, so a probe of it is served by the UNIQUE's index. A guarded column no UNIQUE holds, a containment's source, is
 * no key: a probe rewritten to it would read no index.
 */
export const selectionKeysOf = (
	natives: ReadonlyArray<NamedNative>
): ReadonlyMap<string, ReadonlyArray<SelectionKey>> => {
	const unique = new Set(
		natives.flatMap(({ object: o }) =>
			o.kind === "Unique"
				? o.columns.flatMap((c) =>
						c.kind === "law" ? [`${o.relation.name}\u0000${c.column}`] : []
					)
				: []
		)
	)
	const out = new Map<string, Array<SelectionKey>>()
	for (const { object: o } of natives) {
		if (o.kind !== "LawColumn" || o.value.kind !== "generated") {
			continue
		}
		const [first, ...rest] = o.value.guard
		const term = o.value.term
		if (
			first === undefined ||
			term.kind !== "column" ||
			!o.relation.fields.some((f) => f.name === term.column.name) ||
			!unique.has(`${o.relation.name}\u0000${o.column}`)
		) {
			continue
		}
		const key: SelectionKey = { column: o.column, field: term.column.name, guard: [first, ...rest] }
		const known = out.get(o.relation.name)
		if (known === undefined) {
			out.set(o.relation.name, [key])
		} else {
			known.push(key)
		}
	}
	return out
}

interface NamesInput {
	readonly owned: Owned
	readonly installation: Identity<"schema">
	readonly vectorSchema: string
	/** Each pattern the installation gives a structural text domain, by its canonical key, with its domain's
	 * definition's digest. */
	readonly textDomains: ReadonlyMap<string, DomainDigest>
	/** Each contract the installation gives a domain, a base one or a context field's, by its declared name. */
	readonly contracts: ReadonlyMap<DeclaredName, ContractSource>
	/** The digest of a contract's domain's definition over `names` (physical/ddl/domains.ts). */
	readonly define: (
		names: PhysicalNames,
		contract: DeclaredName,
		source: ContractSource
	) => DomainDigest
	/** The installation's codes. */
	readonly codes: Codebook
	/** Each closed relation's installed constants, by its declared name (physical/ddl/constants.ts). */
	readonly closed: ReadonlyMap<string, ClosedConstant>
	/** Each stored relation's selection keys' law columns, by its declared name (`selectionKeysOf`). */
	readonly selectionKeys: ReadonlyMap<string, ReadonlyArray<SelectionKey>>
}

/** A login's or role's PostgreSQL role, `<schema>__<name>`, longer than PostgreSQL's `limit` bytes. */
export interface RoleTooLong {
	readonly role: string
	readonly limit: number
}

/** A login's or role's PostgreSQL role, when it fits PostgreSQL's maxIdentifierBytes with its schema's name. */
const fittedRole = <K extends "login" | "role">(
	named: Identity<K>
): Result.Result<Identity<K>, RoleTooLong> =>
	utf8Length(named.identifier) > maxIdentifierBytes.value
		? Result.err({ role: named.identifier, limit: maxIdentifierBytes.value })
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
 * column; domains, constants and the vector extension stay the base's. */
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

/** A relation the installation installs an object of its own for, by name: a table, a roster's domain or a view. */
const installedOf = (owned: Owned, relation: string) => {
	const r = relationOf(owned, relation)
	if (r.kind === "closedRelation") {
		return missing(`physical: the closed relation ${relation} installs no relation of its own`)
	}
	return r
}

/** A roster's codes in the installation's codebook, which holds every roster the schema declares. */
const rosterCodec = (codes: Codebook, roster: DeclaredName): RosterCodec =>
	codes.rosters.get(roster) ?? missing(`physical: no codes for roster ${roster}`)

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
 * text column is `text COLLATE pg_catalog.pg_c_utf8`, a closed id by its roster's domain over smallint, a set by its
 * roster's bits domain, a span by int4range or int8range, a vector by the extension's vector(N), and every other scalar
 * by the native type of its name. The base type, which drops every refinement but a set's, is the lowering's. */
export const installNames = (input: NamesInput): InstallNames => {
	const { owned, installation } = input
	const schema = identifierOf(installation)
	const types = installationTypes(installation)
	/** Each contract's domain's digest, once: an inner contract's is read while an outer one's is spelled. */
	const digests = new Map<DeclaredName, DomainDigest>()
	const contractNamed = (contract: DeclaredName): Identity<"contractDomain"> => {
		const known = digests.get(contract)
		if (known !== undefined) {
			return identity.contractDomain(known)
		}
		const source =
			input.contracts.get(contract) ?? missing(`physical: no domain for contract ${contract}`)
		const digest = input.define(names, contract, source)
		digests.set(contract, digest)
		return identity.contractDomain(digest)
	}
	const textNamed = (regex: RegexRef): Identity<"textDomain"> | undefined => {
		const digest = input.textDomains.get(regex.key)
		return digest === undefined ? undefined : identity.textDomain(digest)
	}
	const names: InstallNames = {
		installation,
		schema,
		types,
		vectorSchema: vectorTypes(input.vectorSchema),
		refusal: { kind: "qualified", schema, name: identifierOf(identity.refusal()) },
		relation: (relation) => ({ schema, name: installedOf(owned, relation).ident }),
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
		rosterDomain: (roster) => ({
			schema: types,
			name: identifierOf(identity.rosterDomain(roster))
		}),
		bitsDomain: (roster) => ({
			schema: types,
			name: identifierOf(identity.bitsDomain(roster, rosterCodec(input.codes, roster).width))
		}),
		codes: input.codes,
		closed: (relation) =>
			input.closed.get(relation) ?? missing(`physical: no closed relation ${relation}`),
		selectionKeys: (relation) => input.selectionKeys.get(relation) ?? [],
		/** A contract's domain by its name, whether the base declares it or a context field does, named by its definition. */
		contractDomain: (contract) => ({ schema: types, name: identifierOf(contractNamed(contract)) }),
		contractNamed,
		textDomain: (regex) => {
			const named = textNamed(regex)
			return named === undefined ? undefined : { schema: types, name: identifierOf(named) }
		},
		textNamed,
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
		relationNamed: (relation) => installedOf(owned, relation).named
	}
	return names
}

/** The column type of a scalar, with the fixed collation when the type is builtin text. */
export interface ColumnType {
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
 * - A fold's hidden accumulator holds the fold's running value, filled in its carrier (write/family/fold.ts), which the
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

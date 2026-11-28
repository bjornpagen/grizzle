import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CanonicalRelation } from "#compiler/analysis/derived/canonical.ts"
import { catchCompileError, Refusal } from "#compiler/core/canonical.ts"
import { CompileError, type UninstalledType } from "#compiler/core/errors.ts"
import type { DomainDigest } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredName,
	type HeldName,
	type Fitted,
	type Identity,
	identifierOf,
	identity,
	type ParamPlace,
	nameFaultText,
	parseDeclaredName,
	roleIdentity,
	wholeSchemaIdentity
} from "#compiler/core/identity.ts"
import type { ConstraintName, RelationIdent } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { HeadName } from "#compiler/ir/instant.ts"
import type { ClosedTheoryRelation, DomainCheck } from "#compiler/ir/law.ts"
import type { InstalledSpellings } from "#compiler/ir/pattern.ts"
import {
	type LibraryFn,
	missing,
	type PhysicalNames,
	type SelectionKey
} from "#compiler/ir/physical.ts"
import type { RegexRef, ScalarType } from "#compiler/ir/scalar.ts"
import type { NamedNative } from "#compiler/laws/model/model.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { volatilityClause } from "#compiler/physical/ddl/functions.ts"
import { libraryRef } from "#compiler/physical/ddl/library.ts"
import { closedIndexOf, type ClosedTable } from "#compiler/runtime/write/fill.ts"
import {
	type Owned,
	type OwnedLogin,
	type OwnedRelation,
	type OwnedRole,
	type OwnedWorldEntry,
	rostersOf,
	wholeViewOf
} from "#compiler/schema/own.ts"
import type { FunctionName, ObjectName, TypeRef, TypeSchema } from "#compiler/sql/ast.ts"
import type { ClosedConstant } from "#compiler/sql/constants.ts"
import { storedColumns } from "#compiler/sql/stored.ts"
import { installationTypes, vectorTypes } from "#compiler/sql/type-schemas.ts"
import { type OutsideProbe, probeIdentity } from "#compiler/write/insert/unique.ts"
import { refusalRef } from "#compiler/write/refusal.ts"

export interface InstallNames extends PhysicalNames {
	/**
	 * The identity of the root's PostgreSQL schema, which holds what is the installation's own, every level's alike:
	 * its migrations ledger, its refusal, isolation and snapshot functions, its constants, its contract and text domains
	 * and its rules' functions.
	 */
	readonly installation: Identity<"schema">
	/** The root's PostgreSQL schema, the installation's identifier. */
	readonly schema: string
	/** The root's schema as the schema of the types it holds, the contract and text domains. */
	readonly types: TypeSchema
	/**
	 * The identity of each level's PostgreSQL schema, root first, as Owned.levels lists the levels: a level's schema
	 * holds its relations' tables, and its rosters' domains. A role's or a login's PostgreSQL role embeds its own level's.
	 */
	readonly levels: NonEmptyReadonlyArray<Identity<"schema">>
	/** The identity of the PostgreSQL schema of the level that declares a relation, a roster among them. */
	readonly levelOf: (relation: string) => Identity<"schema">
	/** The table of a head, by its name (ir/instant.ts HeadName), in the schema its identities place it in
	 * (headIdentities, physical/ddl/stamps.ts). */
	readonly head: (head: HeadName) => ObjectName
	/** The stamp function of a head, by its name, beside its table, which takes its keys' arrays
	 * (physical/ddl/stamps.ts). */
	readonly stamp: (head: HeadName) => ObjectName
	/** The primary key constraint of a stored relation, which an insert into a span primary key names as its
	 * arbiter. */
	readonly primaryKey: (relation: string) => ConstraintName
	/** The identity a relation's table, roster domain or stored table is named by. */
	readonly relationNamed: (relation: string) => Identity<"table" | "rosterDomain" | "view">
	/**
	 * The whole view of an anonymous canonical relation's stored table (analysis/derived/canonical.ts), which no role
	 * names: named by its form's digest (core/identity.ts canonicalWholeView) in the schema of whole views of the level
	 * its table installs in, which every role that reads it (analysis/schema.ts CheckedSchema serves) reads it through,
	 * as a whole entry's relation is read (RoleViewName `whole`).
	 */
	readonly canonicalWholeView: (
		relation: string
	) => Extract<RoleViewName, { readonly kind: "whole" }>
	/**
	 * The whole view of a stored relation, as every role holding it whole reads it (RoleViewName `whole`): a declared
	 * relation's in its level's schema of whole views (`wholeViewName`, nameRole's own), an anonymous canonical relation's
	 * by its form (`canonicalWholeView`).
	 */
	readonly wholeView: (relation: string) => ObjectName
	/**
	 * The identity of a contract's domain, by the contract's declared name: the digest of the domain's physical definition,
	 * so contracts of one definition share one domain. Its CHECK is `identity.domainCheck` of it.
	 */
	readonly contractNamed: (contract: DeclaredName) => Identity<"contractDomain">
	/** The identity of the structural text domain of a pattern, by its definition's digest, where the installation
	 * installs it, and otherwise UninstalledDomain (NamesInput `textNamed`). */
	readonly textNamed: (regex: RegexRef) => Identity<"textDomain">
	/** The identity of a roster's domain, which ownership minted with the roster. */
	readonly rosterNamed: (roster: HeldName) => Identity<"rosterDomain">
	/** The identity of the domain of sets over a roster, at the roster's width in the installation's codes. */
	readonly bitsNamed: (roster: HeldName) => Identity<"bitsDomain">
}

/**
 * What a contract's domain is defined from: its base and its CHECK, the law model's domain native's for a base
 * contract and a context contract's own, from which `define` spells the domain's definition over the installation's
 * names (physical/ddl/domains.ts contractDefinition), whose digest names the domain.
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
	/** The canonical relation each derived relation's name, or an anonymous canonical relation's, names, whose table holds
	 * its rows where one does (analysis/schema.ts CheckedSchema canonicalOf). */
	readonly canonical: (relation: string) => CanonicalRelation
	/** Each level's PostgreSQL schema, root first, index for index with Owned.levels. */
	readonly levels: NonEmptyReadonlyArray<Identity<"schema">>
	readonly vectorSchema: string
	/**
	 * The structural text domain of a pattern, by its definition's digest (physical/ddl/domains.ts textDomainIdentity),
	 * where the installation installs one, and otherwise UninstalledDomain where the statement naming it is compiled
	 * (physical/install/plan.ts ParamSource).
	 */
	readonly textNamed: (regex: RegexRef) => Identity<"textDomain">
	/** Each contract the installation gives a domain by its definition, a base one, a context field's or a served
	 * parameter's, by its declared name. */
	readonly contracts: ReadonlyMap<DeclaredName, ContractSource>
	/** Each contract outside the base a snapshot's installation installs for its served parameters, by its declared
	 * name, with the digest of its domain's definition, as snapshot.json records it (physical/ddl/domains.ts
	 * InstalledParams). */
	readonly recordedContracts: ReadonlyMap<DeclaredName, DomainDigest>
	/** The pattern domain of a parameter's place over a pattern (physical/ddl/domains.ts paramDomainIdentity), refused
	 * as UninstalledDomain where the installation installs none (physical/install/plan.ts ParamSource). */
	readonly paramNamed: (place: ParamPlace, regex: RegexRef) => Identity<"paramDomain">
	/** The digest of a contract's domain's definition over `names`, read in no schema (physical/ddl/domains.ts). */
	readonly define: (
		names: PhysicalNames,
		contract: DeclaredName,
		source: ContractSource
	) => DomainDigest
	/** The installation's codes, every level's rosters', which the names hold of `owned`'s rosters alone (levelCodes). */
	readonly codes: Codebook
	/** How the installation spells each pattern a match reads (ir/pattern.ts installedSpellings). */
	readonly spellings: InstalledSpellings
	/** Each closed relation's installed constants, by its declared name (physical/ddl/constants.ts). */
	readonly closed: ReadonlyMap<string, ClosedConstant>
	/** Each closed relation's theory, its heading and its rows, by its declared name. */
	readonly closedRelations: ReadonlyMap<string, ClosedTheoryRelation>
	/** The closed relations as the host reads them (analysis/schema.ts closedTableOf), by their declared names. */
	readonly closedTable: ClosedTable
	/** Each stored relation's selection keys' law columns, by its declared name (`selectionKeysOf`). */
	readonly selectionKeys: ReadonlyMap<string, ReadonlyArray<SelectionKey>>
	/** The library functions the installation installs (physical/install/plan.ts artifactObjects, ServedTypes). */
	readonly library: ReadonlyArray<LibraryFn>
}

/**
 * The view a role reads one of its relations through: a whole entry's is its relation's whole view,
 * `<wholeSchema>.<relation>` in the whole views' schema of the relation's level, the one view of it every role holding
 * it whole reads (`whole`); a query entry's is its own, in the role's schema (`query`). Each derived relation the role
 * reads in full (schema/own.ts OwnedRole `wholeDerived`) is named a whole view too, whatever the installation infers of
 * its storage, which it creates where the relation is stored. The installation creates a whole view for a stored
 * relation and a stored derived one alone: a roster's or a closed relation's whole entry is named so, but no statement
 * reads it, every query reading a roster's handles as codes and a closed relation's rows through its constants. A
 * whole view names the relation it is, `relation`, by its name as the installation's facts are keyed (its declared
 * name, or a stored canonical relation's), so whatever reads a role's statements back reads each whole view as that
 * relation from the one value that names it (program/isolation/member-facts.ts extractNames).
 */
export type RoleViewName =
	| {
			readonly kind: "whole"
			readonly schema: Fitted<"wholeSchema">
			readonly name: Identity<"wholeView">
			readonly relation: string
	  }
	| {
			readonly kind: "query"
			readonly schema: Identity<"roleSchema">
			readonly name: Identity<"roleView">
	  }

/** A role of an installation named under its levels: the owned role, its PostgreSQL role and the view of each of its
 * relations (RoleViewName), by the relation's declared name, each fitted once, here, before anything is compiled for it,
 * so every world name read from it (worldNames) is a name the installation can create. */
export interface NamedRole {
	readonly owned: OwnedRole
	readonly theory: Fitted<"role">
	readonly views: ReadonlyMap<string, RoleViewName>
}

/** A login of an installation named under its levels: the owned login and each of its roles named (NamedRole), in the
 * login's order. */
export interface NamedLogin {
	readonly owned: OwnedLogin
	readonly roles: ReadonlyArray<NamedRole>
}

/**
 * The whole view of the declared relation `relation` among the installation's `levels`, `<wholeSchema>.<relation>` in
 * its level's schema of whole views, which `reader` reads it through, declared at `at`: the one name of it every role
 * holding it whole reads and the installation creates (InstallNames `wholeView`).
 */
const wholeViewName = (
	levels: NonEmptyReadonlyArray<Identity<"schema">>,
	relation: OwnedRelation,
	reader: string,
	at: SourceLoc
): Extract<RoleViewName, { readonly kind: "whole" }> => {
	const level =
		levels[relation.level] ?? missing(`physical: no installed level for relation ${relation.name}`)
	return {
		kind: "whole",
		schema: wholeSchemaIdentity(
			level,
			`the whole views' schema of ${level.display}, which ${reader} reads ${relation.name} through`,
			at
		),
		name: wholeViewOf(relation),
		relation: relation.name
	}
}

/** `role` named under the installation's `levels`, its refusal thrown (namedRole). */
const nameRole = (
	role: OwnedRole,
	levels: NonEmptyReadonlyArray<Identity<"schema">>
): NamedRole => {
	const theory = roleIdentity(levelIn(levels, role.base), role.name, role.loc)
	const schema = identity.roleSchema(theory)
	const views = new Map<string, RoleViewName>()
	/** The whole view of `relation`, declared at `at`, in its level's schema of whole views. */
	const whole = (relation: OwnedRelation, at: SourceLoc): RoleViewName =>
		wholeViewName(levels, relation, `role ${role.name}`, at)
	for (const [relation, e] of Object.entries(role.relations)) {
		views.set(
			relation,
			e.kind === "world"
				? { kind: "query", schema, name: roleView(theory, e) }
				: whole(e.relation, e.loc)
		)
	}
	for (const relation of role.wholeDerived) {
		const r =
			role.base.relations[relation] ??
			missing(`physical: the derived relation ${relation} of role ${role.name}'s base`)
		views.set(relation, whole(r, r.loc))
	}
	return { owned: role, theory, views }
}

/** `role` named under the installation's `levels`: its PostgreSQL role embeds its base's level, refused as
 * IdentifierTooLong when it does not fit with that level's name, and each relation it holds whole is read through its
 * whole view in its level's schema of whole views, `__<level>`, refused alike when that does not fit (fitted). */
export const namedRole = (
	role: OwnedRole,
	levels: NonEmptyReadonlyArray<Identity<"schema">>
): Result.Result<NamedRole, CompileError> => catchCompileError(() => nameRole(role, levels))

/** `login`'s roles named under the installation's `levels` (namedRole), the first refusal among them, in the login's
 * order. */
export const namedLogin = (
	login: OwnedLogin,
	levels: NonEmptyReadonlyArray<Identity<"schema">>
): Result.Result<NamedLogin, CompileError> =>
	catchCompileError((): NamedLogin => ({
		owned: login,
		roles: login.roles.map((role) => nameRole(role, levels))
	}))

/** A role's query entry's view in its role's schema, by the name role ownership declared (schema/own.ts ownRole). */
export const roleView = (role: Identity<"role">, e: OwnedWorldEntry): Identity<"roleView"> =>
	identity.roleView(role, e.name)

/**
 * The column a reference to a view's field names, a derived relation's or a role query entry's, its name parsed where
 * the reference resolves. Every field a heading names was declared, by its analysis (analysis/derived/analyze.ts
 * declaredHeading), so a reference that does not parse resolves to nothing, refused as MalformedDescription.
 */
const viewColumn = (field: string): Identity<"column"> => {
	const parsed = parseDeclaredName(field)
	if (!parsed.ok) {
		missing(
			`physical: the view field ${JSON.stringify(field)}, a name ${nameFaultText(parsed.error)}`
		)
	}
	return identity.column(parsed.value)
}

/** The installed names of one role: its theory role, each relation's view (NamedRole views), each writable entry's
 * filter function and each of its probes, by their argument types: a filter function's T's fields the membership reads,
 * a probe's its parameters (write/insert/unique.ts probeParams), each at its base type. A probe is named by its identity
 * (`probe`, write/insert/unique.ts probeIdentity), the one the installation creates it by; a key probe is also named by
 * its key's fields (`keyProbe`) and a unique probe by its object's installed name (`uniqueProbe`), which is that
 * identity. */
export interface WorldNames {
	readonly role: string
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

/**
 * The PostgreSQL schema of the level a role or a login is over, its base, among an installation's `levels`: a base's
 * levels are the installation's lowest ones, so its own is the installation's level at its count. Its PostgreSQL role
 * embeds that schema's name.
 */
export const levelIn = (
	levels: NonEmptyReadonlyArray<Identity<"schema">>,
	base: Owned
): Identity<"schema"> =>
	levels[base.levels.length - 1] ??
	missing(`physical: schema ${base.name} is no level of the installation`)

/** The names of a role, installed in the installation `names` names: its theory role, fitted when the role was named
 * (namedRole), embeds its level's schema, each of its relations' views was named there, a whole entry's its relation's
 * one whole view and a query entry's its own in the role's schema, and its filter functions and probes live in the
 * root's, as every function of the installation does. */
export const worldNames = (named: NamedRole, names: InstallNames): WorldNames => {
	const { owned: role, theory } = named
	const schema = names.schema
	return {
		role: identifierOf(theory),
		view: (relation) => {
			const view =
				named.views.get(relation) ??
				(Object.hasOwn(role.base.relations, relation)
					? missing(`physical: no view of relation ${relation} in role ${role.name}`)
					: names.canonicalWholeView(relation))
			return { schema: identifierOf(view.schema), name: identifierOf(view.name) }
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

/** What a role reads its relations through: every relation of it is its view (`world`, the role's names, worldNames), a
 * whole entry's, and a stored derived relation's it reads in full (schema/own.ts OwnedRole `wholeDerived`), its
 * relation's whole view, whose columns are its table's (or its stored table's), and a query
 * entry's its own in the role's schema, whose columns are its definition's head fields, each a field's column; an
 * anonymous canonical relation's table the role reads (analysis/schema.ts CheckedSchema serves, schema/own.ts
 * roleSeesWhole) its whole view (InstallNames canonicalWholeView, worldNames); domains, constants and the vector
 * extension stay the base's. A view
 * holds its heading's columns and no law column (physical/ddl/roles.ts wholeView, worldView), so it holds no selection
 * key a read could probe. Each member is stated here, none carried from the installation's names, so none of what a
 * table holds is read off a view. */
export const roleReadNames = (
	names: InstallNames,
	world: WorldNames,
	role: OwnedRole
): PhysicalNames => ({
	relation: world.view,
	column: (relation, field) => {
		const e = role.relations[relation]
		if (e?.kind === "world") {
			return identifierOf(viewColumn(field))
		}
		if (
			e === undefined &&
			!role.wholeDerived.includes(relation) &&
			Object.hasOwn(role.base.relations, relation)
		) {
			missing(`physical: no relation ${relation} in role ${role.name}`)
		}
		return names.column(relation, field)
	},
	selectionKeys: () => [],
	rosterDomain: names.rosterDomain,
	bitsDomain: names.bitsDomain,
	rosterNames: names.rosterNames,
	digestDomain: names.digestDomain,
	variantRow: names.variantRow,
	variantDomain: names.variantDomain,
	contractDomain: names.contractDomain,
	textDomain: names.textDomain,
	paramDomain: names.paramDomain,
	vectorSchema: names.vectorSchema,
	installed: names.installed,
	codes: names.codes,
	spellings: names.spellings,
	closed: names.closed,
	library: names.library,
	closedRelations: names.closedRelations,
	closedIndex: names.closedIndex,
	refusal: names.refusal,
	declaredFunction: names.declaredFunction,
	suffixed: names.suffixed
})

const relationOf = (owned: Owned, relation: string) => {
	const r = owned.relations[relation]
	if (r === undefined) {
		missing(`physical: no relation ${relation} in the owned schema`)
	}
	return r
}

/**
 * What a relation's name reads in the installation (`installedOf`): an owned relation, or the canonical relation a
 * derived relation's name or an anonymous canonical relation's names (analysis/derived/canonical.ts).
 */
type Installable =
	| {
			readonly kind: "owned"
			readonly relation: Exclude<OwnedRelation, { readonly kind: "derived" }>
	  }
	| { readonly kind: "canonical"; readonly relation: CanonicalRelation }

/** What `relation` names in the installation (Installable). */
const installableOf = (
	owned: Owned,
	canonical: NamesInput["canonical"],
	relation: string
): Installable => {
	const r = owned.relations[relation]
	return r === undefined || r.kind === "derived"
		? { kind: "canonical", relation: canonical(relation) }
		: { kind: "owned", relation: r }
}

/**
 * A relation the installation installs an object of its own for, by name: a table, a roster's domain, or a canonical
 * relation's table, named by its form (core/identity.ts view), whichever name reads it.
 */
const installedOf = (
	owned: Owned,
	canonical: NamesInput["canonical"],
	relation: string
): {
	readonly named: Identity<"table" | "rosterDomain" | "view">
	readonly ident: RelationIdent
} => {
	const at = installableOf(owned, canonical, relation)
	if (at.kind === "canonical") {
		const named = identity.view(at.relation.digest)
		return { named, ident: identifierOf(named) }
	}
	const r = at.relation
	switch (r.kind) {
		case "closedRelation":
			return missing(`physical: the closed relation ${relation} installs no relation of its own`)
		case "relation":
		case "closed":
			return r
	}
}

/**
 * The level of the schema `relation` installs in: an owned relation's own; a canonical relation's, the level of the
 * derived relation it names where it names one, otherwise the highest of the relations its definition reads, the lowest
 * level whose schema holds all of them.
 */
const installedLevel = (
	owned: Owned,
	canonical: NamesInput["canonical"],
	relation: string
): number => {
	const at = installableOf(owned, canonical, relation)
	if (at.kind === "owned") {
		return at.relation.level
	}
	const subject = at.relation.subject
	return (
		owned.relations[subject.name]?.level ??
		subject.reads.reduce((most, r) => Math.max(most, owned.relations[r]?.level ?? 0), 0)
	)
}

/** A roster the owned schema declares, by name, with its domain's identity, which ownership minted. */
const rosterOf = (owned: Owned, roster: string) => {
	const r = relationOf(owned, roster)
	return r.kind === "closed" ? r : missing(`physical: ${roster} is no roster of the owned schema`)
}

/** The installed names of one schema, gathered under the PostgreSQL schema the installation targets, so the installer,
 * the grants and the query lowerings (`PhysicalNames`) address one set of objects. Every name is minted at the naming
 * door (core/identity.ts) from the identity of what it names: ownership mints the relations', fields', contracts',
 * keys' and checks', the law model those of the objects it specializes, and the installer every other
 * one, a structural text domain by its pattern key's digest.
 *
 * The worlds' names (`worldNames`) are minted from declared names under the installation's identity: a login's
 * PostgreSQL role and a role's, its theory role (roles are cluster-wide); a relation's whole view, in its level's schema
 * of whole views, which every role holding the relation whole reads; a role's schema, and in it one view per query
 * entry, whose columns are its fields'; a role's policy on a table it writes; a writable entry's filter function, key
 * probes and unique probes in the base schema.
 *
 * Column types: a contract column is typed by its domain, a refined text column by its structural domain, a wildcard
 * text column is `text COLLATE pg_catalog.pg_c_utf8`, a closed id by its roster's domain over smallint, a set by its
 * roster's bits domain, a span by int4range or int8range, a vector by the extension's vector(N), and every other scalar
 * by the native type of its name. The base type, which drops every refinement but a set's, is the lowering's. */
/**
 * A cast to `domain`, which the installation does not install, refused as UninstalledDomain where the statement is
 * compiled, never by PostgreSQL where it runs. A function declaration, so that control flow knows a call never returns.
 */
export function uninstalled(domain: UninstalledType): never {
	throw new Refusal(
		CompileError.make({ _tag: "UninstalledDomain", at: SourceLoc("physical names", []), domain })
	)
}

/**
 * A call of the library function `fn`, which the installation does not install, refused as UninstalledFunction where
 * the statement is compiled, never by PostgreSQL where it runs. A function declaration, so that control flow knows a
 * call never returns.
 */
function uninstalledFunction(fn: LibraryFn): never {
	throw new Refusal(
		CompileError.make({ _tag: "UninstalledFunction", at: SourceLoc("physical names", []), fn })
	)
}

/**
 * The codes the names of `owned` hold (InstallNames codes): the installation's codes `codes`, which hold every level's
 * rosters, of the rosters `owned` declares, its level's and those below it, in the codebook's order. A level below the
 * installation's top declares none of the rosters of the levels above it, and its names name no domain of theirs, so
 * every roster the names hold codes for is one whose domains they name (rosterDomain, bitsDomain), and nothing that
 * reads a level's names meets a roster above it (docs/schema.md "Levels").
 */
const levelCodes = (codes: Codebook, owned: Owned): Codebook => {
	const declared = new Set(rostersOf(owned).map((r) => r.closed))
	return Object.freeze({
		rosters: new Map([...codes.rosters].filter(([roster]) => declared.has(roster))),
		spellings: codes.spellings
	})
}

/**
 * The identities a head's objects are named by (physical/ddl/stamps.ts), by its name (ir/instant.ts HeadName): its
 * table's, its table's primary key's and its stamp function's, and the relation whose level's schema they stand in. A
 * unit's scope is named by its unit, in the root's schema, as a sealed unit's founding is (physical/ddl/seal.ts), since
 * every level over the unit stamps it alike; a place, and a clock no unit holds, by its relation and field, in that
 * relation's level's schema.
 */
export const headIdentities = (
	named: HeadName
): {
	readonly table: Identity<"head" | "unitHead">
	readonly key: Identity<"headKey" | "unitHeadKey">
	readonly stamp: Identity<"stamp" | "unitStamp">
	/** The relation whose level's schema holds its objects, none for a unit's head, which the root's schema holds. */
	readonly relation: string | undefined
} => {
	switch (named.kind) {
		case "field":
			return {
				table: identity.head(named.relation, named.field),
				key: identity.headKey(named.relation, named.field),
				stamp: identity.stamp(named.relation, named.field),
				relation: named.relation
			}
		case "unit":
			return {
				table: identity.unitHead(named.unit),
				key: identity.unitHeadKey(named.unit),
				stamp: identity.unitStamp(named.unit),
				relation: undefined
			}
	}
}

export const installNames = (input: NamesInput): InstallNames => {
	const { owned, levels } = input
	const codes = levelCodes(input.codes, owned)
	const installation = levels[0]
	const schema = identifierOf(installation)
	const types = installationTypes(installation)
	const levelOf = (relation: string): Identity<"schema"> =>
		levels[installedLevel(owned, input.canonical, relation)] ??
		missing(`physical: no installed level for ${relation}`)
	/** The schema a head's objects stand in (headIdentities): its relation's level's, or the root's. */
	const headSchema = (relation: string | undefined): string =>
		identifierOf(relation === undefined ? installation : levelOf(relation))
	/**
	 * Each contract's domain, minted once from its definition's digest: an inner contract's is read while an outer one's
	 * is spelled.
	 */
	const domains = new Map<DeclaredName, Identity<"contractDomain">>()
	const contractNamed = (contract: DeclaredName): Identity<"contractDomain"> => {
		const known = domains.get(contract)
		if (known !== undefined) {
			return known
		}
		const source = input.contracts.get(contract)
		const recorded = input.recordedContracts.get(contract)
		const named = identity.contractDomain(
			source !== undefined
				? input.define(names, contract, source)
				: (recorded ?? uninstalled({ kind: "contract", contract }))
		)
		domains.set(contract, named)
		return named
	}
	const { textNamed } = input
	const rosterNamed = (roster: HeldName): Identity<"rosterDomain"> => rosterOf(owned, roster).named
	/** Each roster's bits domain at its width in the codes, minted once as the names are built. */
	const bits = new Map(
		Array.from(
			codes.rosters,
			([roster, codec]) => [roster, identity.bitsDomain(roster, codec.width)] as const
		)
	)
	const bitsNamed = (roster: HeldName): Identity<"bitsDomain"> =>
		bits.get(roster) ?? missing(`physical: no codes for roster ${roster}`)
	const library: ReadonlySet<LibraryFn> = new Set(input.library)
	const canonicalWholeView = (
		relation: string
	): Extract<RoleViewName, { readonly kind: "whole" }> => {
		const level = levelOf(relation)
		return {
			kind: "whole",
			schema: wholeSchemaIdentity(
				level,
				`the whole views' schema of ${level.display}, which a role reads ${relation} through`,
				SourceLoc(`stored canonical relation ${relation}`, [])
			),
			name: identity.canonicalWholeView(input.canonical(relation).digest),
			relation
		}
	}
	const names: InstallNames = {
		installation,
		schema,
		types,
		levels,
		levelOf,
		vectorSchema: vectorTypes(input.vectorSchema),
		installed: new Set(levels.map(identifierOf)),
		refusal: refusalRef(schema),
		declaredFunction: (name) => {
			const fn = owned.functions[name] ?? missing(`physical: no declared function ${name}`)
			const level = levels[fn.level] ?? missing(`physical: no installed level for function ${name}`)
			return {
				ref: {
					kind: "qualified",
					schema: identifierOf(level),
					name: identifierOf(fn.named),
					volatility: volatilityClause[fn.desc.volatility]
				},
				types: installationTypes(level)
			}
		},
		relation: (relation) => ({
			schema: identifierOf(levelOf(relation)),
			name: installedOf(owned, input.canonical, relation).ident
		}),
		column: (relation, field) => {
			const at = installableOf(owned, input.canonical, relation)
			if (at.kind === "canonical") {
				return identifierOf(viewColumn(field))
			}
			const f = at.relation.fields[field]
			if (f === undefined) {
				missing(`physical: no field ${relation}.${field}`)
			}
			return f.column
		},
		rosterDomain: (roster) => ({
			schema: installationTypes(levelOf(roster)),
			name: identifierOf(rosterNamed(roster))
		}),
		digestDomain: { schema: types, name: identifierOf(identity.digestDomain()) },
		variantRow: (variant) => ({ schema: types, name: identifierOf(identity.variantRow(variant)) }),
		variantDomain: (variant) => ({
			schema: types,
			name: identifierOf(identity.variantDomain(variant))
		}),
		bitsDomain: (roster) => ({
			schema: installationTypes(levelOf(roster)),
			name: identifierOf(bitsNamed(roster))
		}),
		rosterNames: (roster) => ({
			kind: "qualified",
			schema,
			volatility: "IMMUTABLE",
			name: identifierOf(
				rosterConstants(
					codes.rosters.get(roster) ?? missing(`physical: no codes for roster ${roster}`)
				).names
			)
		}),
		codes,
		spellings: input.spellings,
		closed: (relation) =>
			input.closed.get(relation) ?? missing(`physical: no closed relation ${relation}`),
		library: (fn) => (library.has(fn) ? libraryRef(schema, fn) : uninstalledFunction(fn)),
		closedRelations: input.closedRelations,
		closedIndex: closedIndexOf(input.closedTable),
		selectionKeys: (relation) => input.selectionKeys.get(relation) ?? [],
		suffixed: storedColumns([]),
		/** A contract's domain by its name, whether the base declares it, a context field or a served parameter, named by
		 * its definition. */
		contractDomain: (contract) => ({ schema: types, name: identifierOf(contractNamed(contract)) }),
		contractNamed,
		textDomain: (regex) => ({ schema: types, name: identifierOf(textNamed(regex)) }),
		textNamed,
		paramDomain: (place, regex) => ({
			schema: types,
			name: identifierOf(input.paramNamed(place, regex))
		}),
		rosterNamed,
		bitsNamed,
		head: (head) => {
			const named = headIdentities(head)
			return { schema: headSchema(named.relation), name: identifierOf(named.table) }
		},
		stamp: (head) => {
			const named = headIdentities(head)
			return { schema: headSchema(named.relation), name: identifierOf(named.stamp) }
		},
		primaryKey: (relation) => {
			const key = relationOf(owned, relation).keys.find((k) => k.primary)
			if (key === undefined) {
				missing(`physical: ${relation} has no primary key`)
			}
			return key.constraint
		},
		relationNamed: (relation) => installedOf(owned, input.canonical, relation).named,
		canonicalWholeView,
		wholeView: (relation) => {
			const declared = owned.relations[relation]
			const view =
				declared === undefined
					? canonicalWholeView(relation)
					: wholeViewName(levels, declared, "a role", declared.loc)
			return { schema: identifierOf(view.schema), name: identifierOf(view.name) }
		}
	}
	return names
}

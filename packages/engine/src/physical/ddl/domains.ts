import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, compareText, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { type DomainDigest, domainDigest } from "#compiler/core/fingerprint.ts"
import {
	conversionOf,
	type DeclaredName,
	DeclaredNamespace,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { ConstraintName, DomainName, Identifier } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	flatMapNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { descText, type FieldDesc } from "#compiler/ir/desc.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import type { DomainCheck, DomainCheckTerm, LawField, TableRelation } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import {
	type ContractInfo,
	contractOf,
	patternsText,
	type RegexRef,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { domainCheck, type LawModel } from "#compiler/laws/model/model.ts"
import { domainKey, type InstallBuilder, isVectorRef } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent, noPersistentClosed } from "#compiler/physical/ddl/expr.ts"
import { type ContractSource, domainBase, missing } from "#compiler/physical/ddl/names.ts"
import { enforcement, lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import type { Owned, OwnedRelation } from "#compiler/schema/own.ts"
import type { CreateDomain, Expr, ObjectName } from "#compiler/sql/ast.ts"
import { and } from "#compiler/sql/build.ts"
import { domainValue, membershipTerms, textDomainDdl } from "#compiler/text/refinement.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"

const unwrap = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/** The regex of a column that a structural text domain types: refined text outside any contract. */
export const structuralRegex = (t: ScalarType): RegexRef | undefined =>
	t.carrier === "text" && t.contract === undefined && t.text.regex !== "wildcard"
		? t.text.regex
		: undefined

/** A domain columns are typed by: its name, the identity it was minted from, and its object, when the installation
 * creates one. */
export interface UsedType {
	readonly name: ObjectName
	readonly identity: Identity<"contractDomain" | "textDomain" | "rosterDomain" | "bitsDomain">
	readonly node: Node<"setup"> | undefined
}

/** The domains columns are typed by, by name, and whether one is a vector. */
export interface TypeUse {
	readonly domains: Map<string, UsedType>
	vector: boolean
}

export const emptyUse = (): TypeUse => ({ domains: new Map(), vector: false })

/** The domains a column of type `t` names, down a contract's base chain and a span's endpoint: a contract's, a text
 * refinement's, a closed id's roster domain and a set's bits domain. */
const typeDomains = (b: InstallBuilder, t: ScalarType, use: TypeUse): void => {
	const contract = contractOf(t)
	if (contract !== undefined) {
		const name = b.names.contractDomain(contract.name)
		use.domains.set(domainKey(name), {
			name,
			identity: b.names.contractNamed(contract.name),
			node: b.typeNamed(name)
		})
		typeDomains(b, contract.base, use)
		return
	}
	if (t.carrier === "code") {
		const name = b.names.rosterDomain(t.roster.closed)
		use.domains.set(domainKey(name), {
			name,
			identity: b.names.rosterNamed(t.roster.closed),
			node: b.typeNamed(name)
		})
	}
	if (t.carrier === "bits") {
		const name = b.names.bitsDomain(t.roster.closed)
		use.domains.set(domainKey(name), {
			name,
			identity: b.names.bitsNamed(t.roster.closed),
			node: b.typeNamed(name)
		})
	}
	const span = spanOf(t)
	if (span !== undefined) {
		typeDomains(b, span.endpoint, use)
	}
	if (t.carrier === "vector") {
		use.vector = true
	}
	const regex = structuralRegex(t)
	if (regex !== undefined) {
		const name = b.names.textDomain(regex)
		const named = b.names.textNamed(regex)
		if (name !== undefined && named !== undefined) {
			use.domains.set(domainKey(name), { name, identity: named, node: b.typeNamed(name) })
		}
	}
}

/** The types of every column of `heading`. */
export const columnDomains = (
	b: InstallBuilder,
	heading: ReadonlyArray<HeadingColumn>,
	use: TypeUse
): void => {
	for (const c of heading) {
		typeDomains(b, c.type, use)
	}
}

/** The objects of the domains `use` holds, each the installation creates. */
export const usedNodes = (use: TypeUse): ReadonlyArray<Node<"setup">> =>
	[...use.domains.values()].flatMap((t) => (t.node === undefined ? [] : [t.node]))

/** A stored field whose patterns state a law: its relation, the field, its refinement, and the law, spelled as the
 * field declares its patterns. */
export interface FieldPatternLaw {
	readonly relation: TableRelation
	readonly field: LawField
	readonly regex: RegexRef
	readonly law: Extract<Law, { readonly kind: "pattern" }>
}

/**
 * The pattern laws of a schema's law model: one per field of a stored relation that a structural text domain types
 * (structuralRegex), by relation name, each relation's fields in declared order. A tautology erases (text/refinement.ts),
 * a contract's pattern is its contract's law, and a closed relation, a derived relation or a context field stores no
 * field, so none of them states one. The installation lists its text domains' laws from these
 * (physical/install/compile.ts) and lawsOf lists their laws (program/laws.ts), so the two can never disagree.
 */
export const fieldPatternLaws = (model: LawModel): ReadonlyArray<FieldPatternLaw> =>
	[...model.relations.values()].flatMap(({ relation }) =>
		relation.fields.flatMap((field): ReadonlyArray<FieldPatternLaw> => {
			const regex = structuralRegex(field.type)
			return regex === undefined
				? []
				: [
						Object.freeze({
							relation,
							field,
							regex,
							law: Object.freeze({
								kind: "pattern",
								relation: relation.name,
								field: field.name,
								patterns: regex.patterns
							})
						})
					]
		})
	)

/**
 * The identity of the pattern law of `p`'s field under `domain`, the text domain its pattern's key is planned as
 * (planTextDomains): what a violation of that domain's CHECK on the field's column reports, what lawIdsOf gives the law
 * and the one place it is minted.
 */
export const patternLawId = (
	domain: Identity<"textDomain">,
	p: Pick<FieldPatternLaw, "relation" | "field">
): Identifier<"patternLaw"> =>
	identifierOf(identity.patternLaw(domain, p.relation.name, p.field.name))

/** A column outside the stored relations that an installer extension types by a text refinement: a derived relation's
 * view column, a role view's, or a context field a role reads. It is planned before any domain is installed, so its
 * pattern has a domain however the view comes by it, and USAGE on that domain can be granted. `table` and `column` are
 * its place in canonical use order (`TextDomainUse`). */
export interface TextColumnUse {
	readonly regex: RegexRef
	readonly table: string
	readonly column: string
}

/** The text column uses of an installer extension whose objects type no column by a refinement of their own. */
export const noTextDomainUses = (): Result.Result<ReadonlyArray<TextColumnUse>, CompileError> =>
	Result.ok([])

/** A column a structural text domain types, by its place in canonical use order: its table's and column's identifiers,
 * a context field's context and field names as their conversions. Nothing is named by them. */
interface TextDomainUse {
	readonly table: string
	readonly column: string
}

/** Canonical use order: table identifier, then column identifier. */
const compareUses = (a: TextDomainUse, b: TextDomainUse): number =>
	a.table < b.table
		? -1
		: a.table > b.table
			? 1
			: a.column < b.column
				? -1
				: a.column > b.column
					? 1
					: 0

/**
 * A domain's physical definition, its CREATE DOMAIN but for the names it is created and checked under: its base type,
 * its collation and its CHECKs' predicates. Its digest is what the domain is named by, so two contracts or
 * refinements of one definition share one domain, and a changed definition is a new domain.
 */
export const definitionDigest = (
	ddl: Pick<CreateDomain, "base" | "collation" | "constraints">
): DomainDigest =>
	domainDigest(
		{
			base: ddl.base,
			collation: ddl.collation,
			checks: ddl.constraints.map((c) => c.predicate)
		},
		everyProperty
	)

/** The identity of the structural text domain of `regex`: the digest of its definition, text in pg_c_utf8 under the
 * pattern's membership, so every pattern that compiles to one membership shares one domain. */
export const textDomainIdentity = (regex: RegexRef): Identity<"textDomain"> =>
	identity.textDomain(
		definitionDigest(textDomainDdl(regex.check, { schema: "", name: "", constraint: "" }))
	)

/**
 * A structural text domain of the installation: the digest of its physical definition, its identity at the naming door
 * and its one CHECK's, their identifiers, and the columns it types in canonical order (table identifier, then column
 * identifier).
 */
export interface TextDomain {
	readonly digest: DomainDigest
	readonly named: Identity<"textDomain">
	readonly check: Identity<"domainCheck">
	readonly name: DomainName
	readonly constraint: ConstraintName
	readonly uses: ReadonlyArray<TextDomainUse>
}

/** A structural text domain as planned: it types every column whose pattern has its key. */
export interface TextDomainPlan {
	/** The canonical pattern key of the regex it types. */
	readonly key: string
	readonly domain: TextDomain
	/** The refinement of the domain's first use, whose enforcement its CHECK spells. */
	readonly regex: RegexRef
}

/** Every structural text domain of the schema, each named at the naming door by its definition's digest
 * (textDomainIdentity), whatever columns use it, so no use renames a domain, every compilation names a pattern alike,
 * and patterns of one membership share one domain. `extra` are the other columns an installation types by a pattern (an extension's view columns, a world's view
 * columns and context fields); a pattern only they carry has a domain too.
 *
 * A text refinement that is neither a tautology nor wrapped in a contract is a structural domain shared by every field
 * whose pattern recognizes the same values: `CREATE DOMAIN <schema>.<domain> AS text COLLATE pg_catalog.pg_c_utf8
 * CONSTRAINT <check> CHECK (VALUE IS NULL OR (<membership>) IS TRUE)`. A closed relation's refined text payload counts
 * as a use, which the closed facts' validation casts to its domain. A column an installer extension types by a
 * pattern, a derived relation's view column, is a use too (`TextColumnUse`). A context field an installed role reads
 * has the domain of its refined type whether a column carries it or not, since Db.open's admission validates each
 * claim against it. The domains come in the order of their first use in canonical order, a stored column's before an
 * extra's, and each CHECK is spelled from that first use, so it follows one rule whatever order the relations are met
 * in. */
/** The installed relation a theory relation's columns are of: a closed relation's conversion, a stored one's table. */
const theoryTable = (o: OwnedRelation): string => {
	switch (o.kind) {
		case "closedRelation":
			return conversionOf(o.name)
		case "derived":
			return missing(`physical: the derived relation ${o.name} is no relation of the theory`)
		case "relation":
		case "closed":
			return o.ident
	}
}

export const planTextDomains = (
	owned: Owned,
	theory: Theory,
	/** The view columns an extension types by a refinement no stored column carries. */
	extra: ReadonlyArray<TextColumnUse>
): ReadonlyArray<TextDomainPlan> => {
	/** Each pattern key's regex, its uses, and whether a stored column carries it. */
	const keys = new Map<
		string,
		{
			readonly regex: RegexRef
			readonly uses: [TextDomainUse, ...Array<TextDomainUse>]
			readonly stored: boolean
		}
	>()
	const use = (regex: RegexRef, u: TextDomainUse, stored: boolean): void => {
		const known = keys.get(regex.key)
		if (known === undefined) {
			keys.set(regex.key, { regex, uses: [u], stored })
		} else {
			known.uses.push(u)
		}
	}
	for (const [name, r] of Object.entries(theory.relations).toSorted(([a], [b]) =>
		compareStrings(a, b)
	)) {
		const o = defined(owned.relations[name], "ownership holds every relation of the theory")
		const table = theoryTable(o)
		for (const c of r.fields) {
			const regex = structuralRegex(c.type)
			if (regex === undefined) {
				continue
			}
			const field = defined(
				o.fields[c.name],
				"ownership holds every field of the theory's relations"
			)
			use(regex, { table, column: field.column }, true)
		}
	}
	for (const e of extra) {
		const known = keys.get(e.regex.key)
		if (known === undefined || !known.stored) {
			use(e.regex, { table: e.table, column: e.column }, false)
		}
	}
	return [...keys]
		.map(([digest, k]) => ({ digest, ...k, uses: sortNonEmpty(k.uses, compareUses) }))
		.toSorted((a, b) =>
			a.stored !== b.stored
				? a.stored
					? -1
					: 1
				: a.stored
					? compareUses(a.uses[0], b.uses[0])
					: compareText(a.digest, b.digest)
		)
		.map(({ regex, uses }): TextDomainPlan => {
			const named = textDomainIdentity(regex)
			const check = identity.domainCheck(named)
			return {
				key: regex.key,
				domain: {
					digest: definitionDigest(
						textDomainDdl(regex.check, { schema: "", name: "", constraint: "" })
					),
					named,
					check,
					name: identifierOf(named),
					constraint: identifierOf(check),
					uses
				},
				regex
			}
		})
}

/**
 * Each structural text domain an installation's stored fields declare, by its pattern language's key (RegexRef.key),
 * with the digest of its domain's definition, which names it (textDomainIdentity): what every compile over the
 * installation names a refined text's domain by, whatever relations its slice reads.
 */
export type TextDomainNames = ReadonlyMap<string, DomainDigest>

/** The names of planned text domains (planTextDomains), each by its pattern language's key. */
export const textDomainNames = (plans: ReadonlyArray<TextDomainPlan>): TextDomainNames =>
	new Map(plans.map((p) => [p.key, p.domain.digest] as const))

/** The text domain names the stored fields of `theory`'s relations declare, with no other column's: the installation's
 * own over its whole schema's theory, which generate records in snapshot.json (deploy/snapshot/types.ts
 * SnapshotDerived) and a Db reads there. */
export const storedTextDomains = (owned: Owned, theory: Theory): TextDomainNames =>
	textDomainNames(planTextDomains(owned, theory, []))

/** The structural text domains as objects in Setup, each after the schema, each definition once: their names, in
 * order. A pattern whose definition another's domain already holds adds its reason to that domain. */
export const addTextDomains = (
	b: InstallBuilder,
	plans: ReadonlyArray<TextDomainPlan>
): ReadonlyArray<ObjectName> =>
	plans.flatMap(({ domain, regex }) => {
		const reasons = [enforcement(`text refinement ${patternsText(regex.patterns)}`)]
		const known = b.typeNamed({ schema: b.schema, name: domain.name })
		if (known !== undefined) {
			b.graph.addReasons(known, reasons)
			return []
		}
		const ddl = textDomainDdl(regex.check, {
			schema: b.schema,
			name: b.name(domain.named),
			constraint: b.name(domain.check)
		})
		b.addType("domain", b.names.installation, domain.named, { ddl: [ddl], reasons }, [b.schemaNode])
		return [ddl.name]
	})

/**
 * A contract's domain's CREATE DOMAIN, under `target`'s names: over the domain of the contract its base is, a closed
 * id's roster domain, or the unrefined base type, with its CHECK, the pattern test and the predicate as one conjunction,
 * or none. Read with placeholder names, it is the contract's definition (`definitionDigest`), which its domain is named
 * by, so the one statement both names and installs it.
 */
const contractDomainDdl = (
	names: PhysicalNames,
	contract: { readonly name: string; readonly base: ScalarType; readonly check: DomainCheck },
	target: { readonly schema: string; readonly name: string; readonly constraint: string }
): CreateDomain => {
	const terms = (t: DomainCheckTerm): NonEmptyReadonlyArray<Expr> => {
		switch (t.kind) {
			case "pattern":
				return membershipTerms(t.regex.check, domainValue)
			case "predicate":
				return [
					lowerPersistent(names, unwrap(predicateTree(t.predicate)), {
						reads: { kind: "domain" },
						closed: noPersistentClosed,
						loc: SourceLoc(`the predicate of contract ${contract.name}`, [])
					})
				]
		}
	}
	const { type, collation } = domainBase(names, contract.base)
	const check = contract.check
	return {
		kind: "createDomain",
		name: { schema: target.schema, name: target.name },
		base: type,
		collation,
		constraints:
			check.kind === "unchecked"
				? []
				: [{ name: target.constraint, predicate: and(flatMapNonEmpty(check.terms, terms)) }]
	}
}

/** One contract's domain as an object in Setup, named by its definition (InstallNames.contractNamed), after the schema
 * and after the type its base names, which is added before it: an inner contract's domain, a roster's domain, or the
 * vector extension. A contract of a definition another's domain holds adds its reasons to that domain. Its name. */
const addContractDomain = (
	b: InstallBuilder,
	contract: { readonly name: DeclaredName; readonly base: ScalarType; readonly check: DomainCheck },
	reasons: ReadonlyArray<PhysicalReason>
): ObjectName => {
	const named = b.names.contractNamed(contract.name)
	const name: ObjectName = { schema: b.schema, name: identifierOf(named) }
	const known = b.typeNamed(name)
	if (known !== undefined) {
		b.graph.addReasons(known, reasons)
		return name
	}
	const ddl = contractDomainDdl(b.names, contract, {
		schema: b.schema,
		name: b.name(named),
		constraint: contract.check.kind === "unchecked" ? "" : b.name(identity.domainCheck(named))
	})
	const baseNode = b.typeNode(ddl.base)
	b.addType("domain", b.names.installation, named, { ddl: [ddl], reasons }, [
		b.schemaNode,
		...(baseNode === undefined ? [] : [baseNode]),
		...(isVectorRef(b, ddl.base) ? [b.provider("vector")] : [])
	])
	return name
}

/** The contract domains, in contract name order, each after the schema and after the types its base names, each
 * definition once: two contracts of one definition share one domain. Every contract is a law, and the law
 * model's domain native holds its base and decides its CHECK.
 *
 * A contract is `CREATE DOMAIN <schema>.<domain> AS <base>`, named by its definition's digest. Its base is an inner
 * contract's domain, a closed id's roster domain, or the unrefined base type, `text COLLATE pg_catalog.pg_c_utf8` for a
 * text base. Its CHECK is the law model's (`DomainCheck`): `check`, the pattern test and the predicate as one
 * conjunction, or none for a brand-only contract over an unrefined base. No domain carries NOT NULL; every column does.
 * The CHECK's wrapper, `VALUE IS NULL OR (...) IS TRUE`, is the printer's, so the domain admits NULL. */
export const addContractDomains = (b: InstallBuilder): ReadonlyArray<ObjectName> => {
	const domains = b.natives
		.flatMap((n) => (n.namespace === "domain" ? [n] : []))
		.toSorted((x, y) => compareText(x.object.name, y.object.name))
	const byName = new Map(domains.map((d) => [d.object.name, d] as const))
	const added = new Map<string, ObjectName>()
	/** A contract's domain, after the domain of the contract its base is. */
	const add = (domain: (typeof domains)[number]): ObjectName => {
		const { object } = domain
		const known = added.get(object.name)
		if (known !== undefined) {
			return known
		}
		const baseContract = contractOf(object.base)
		const inner = baseContract === undefined ? undefined : byName.get(baseContract.name)
		if (inner !== undefined) {
			add(inner)
		}
		const name = addContractDomain(
			b,
			{ name: object.name, base: object.base, check: object.check },
			lawReasons(object.lawIds)
		)
		added.set(object.name, name)
		return name
	}
	return domains.map(add)
}

/** A contract a context field's type names that the base does not declare: its declared name (which names its law,
 * analysis/theory/theory.ts contractLawIdentity), its type, and its CHECK. Its domain is named by its definition, as a
 * base contract's is (InstallNames.contractNamed). */
export interface ContextContract {
	readonly name: DeclaredName
	readonly contract: ContractInfo
	readonly check: DomainCheck
}

/** The digest of a contract's domain's definition over `names`: what InstallNames names the domain by. */
export const contractDigest = (
	names: PhysicalNames,
	contract: DeclaredName,
	source: ContractSource
): DomainDigest =>
	definitionDigest(
		contractDomainDdl(
			names,
			{ name: contract, base: source.base, check: source.check },
			{ schema: "", name: "", constraint: "" }
		)
	)

type ContractFieldDesc = Extract<FieldDesc, { readonly kind: "contract" }>

/** The contracts the context fields of `contexts` name, down each contract's base chain, that the base does not declare,
 * each once with its domain and its CHECK's name, in base-first order (a contract after the contracts its
 * base chain names). A context field's contract the base declares is the base's: its definition must be the base's, or
 * the context is refused, as two context fields' contracts of one name must be one definition: one contract name has
 * one domain. Each gets its domain whether a column carries it or not, since Db.open's admission validates each claim
 * against it, named by the contract's name as a base contract's is: a declared name of the schema's one namespace of
 * relations, rosters and contracts, so one the declared-name rule refuses, or one converting as a base relation's,
 * roster's or contract's does, is refused (core/identity.ts DeclaredNamespace). */
export const contextContracts = (
	owned: Owned,
	fields: ReadonlyArray<{
		readonly context: string
		readonly field: string
		readonly desc: FieldDesc
		readonly type: ScalarType
		readonly loc: SourceLoc
	}>
): Result.Result<ReadonlyArray<ContextContract>, CompileError> =>
	catchRefusal(() => {
		const out: Array<ContextContract> = []
		const planned = new Map<string, string>()
		const types = new DeclaredNamespace("relation, roster and contract")
		for (const r of Object.values(owned.relations)) {
			unwrap(types.declare(r.name, r.kind === "closed" ? "closed relation" : "relation", r.loc))
		}
		for (const c of Object.values(owned.contracts)) {
			unwrap(types.declare(c.name, "contract", c.loc))
		}
		const plan = (
			desc: ContractFieldDesc,
			info: ContractInfo,
			loc: SourceLoc,
			what: string
		): void => {
			const baseContract = contractOf(info.base)
			if (desc.base.kind === "contract" && baseContract !== undefined) {
				plan(desc.base, baseContract, loc, what)
			}
			const text = unwrap(descText(desc))
			const declared = owned.contracts[info.name]
			const prior =
				declared === undefined ? planned.get(info.name) : unwrap(descText(declared.desc))
			if (prior !== undefined) {
				if (prior !== text) {
					throw new Refusal(
						malformedDescription(
							loc,
							`${what}: one definition per contract name; contract ${info.name} is defined otherwise ${declared === undefined ? "by another context field" : "by the base"}`
						)
					)
				}
				return
			}
			planned.set(info.name, text)
			out.push({
				name: unwrap(types.declare(info.name, "contract", loc)),
				contract: info,
				check: domainCheck(info)
			})
		}
		for (const f of fields) {
			const info = contractOf(f.type)
			if (f.desc.kind === "contract" && info !== undefined) {
				plan(f.desc, info, f.loc, `context field ${f.context}.${f.field}`)
			}
		}
		return out
	})

/** The context contracts' domains as objects in Setup, base first, each after the domain of a contract its base is. */
export const addContextContractDomains = (
	b: InstallBuilder,
	contracts: ReadonlyArray<ContextContract>
): ReadonlyArray<ObjectName> =>
	contracts.map((c) =>
		addContractDomain(b, { name: c.name, base: c.contract.base, check: c.check }, [
			enforcement(`contract ${c.name} of a context field`)
		])
	)

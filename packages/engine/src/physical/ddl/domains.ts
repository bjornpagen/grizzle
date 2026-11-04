import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, compareText, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import {
	DeclaredNamespace,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { ConstraintName, DomainName } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, sortNonEmpty } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { descText, type FieldDesc } from "#compiler/ir/desc.ts"
import { predicateTree } from "#compiler/ir/expr.ts"
import type { DomainCheck, DomainCheckTerm } from "#compiler/ir/law.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import {
	type ContractInfo,
	contractOf,
	type RegexRef,
	type ScalarType,
	type ValueType
} from "#compiler/ir/scalar.ts"
import { domainCheck } from "#compiler/laws/model/model.ts"
import { type InstallBuilder, isVectorRef } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import { domainBase } from "#compiler/physical/ddl/names.ts"
import { enforcement, lawReasons } from "#compiler/physical/obligations/graph.ts"
import type { Owned } from "#compiler/schema/own.ts"
import type { CreateDomain, Expr, ObjectName } from "#compiler/sql/ast.ts"
import { and } from "#compiler/sql/build.ts"
import {
	domainValue,
	membership,
	type NontrivialRefinement,
	refinementOf,
	textDomainDdl
} from "#compiler/text/refinement.ts"

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
 * A structural text domain of the installation: the digest of its canonical pattern key, its identity at the naming
 * door and its one CHECK's, their identifiers, and the columns it types in canonical order (table identifier, then
 * column identifier).
 */
export interface TextDomain {
	readonly digest: string
	readonly named: Identity<"textDomain">
	readonly check: Identity<"domainCheck">
	readonly name: DomainName
	readonly constraint: ConstraintName
	readonly uses: ReadonlyArray<TextDomainUse>
}

interface TextDomainPlan {
	readonly domain: TextDomain
	readonly refinement: NontrivialRefinement
}

/** Every structural text domain of the schema, each named at the naming door by its canonical pattern key's digest
 * (identity.textDomain), whatever columns use it, so no use renames a domain and every compilation names a pattern
 * alike. `extra` are the other columns an installation types by a pattern (an extension's view columns, a world's view
 * columns and context fields); a pattern only they carry has a domain too.
 *
 * A text refinement that is neither a tautology nor wrapped in a contract is a structural domain shared by every field
 * whose pattern recognizes the same values: `CREATE DOMAIN <schema>.<domain> AS text COLLATE pg_catalog.pg_c_utf8
 * CONSTRAINT <check> CHECK ((<membership>) IS TRUE)`. A closed relation's text payload counts as a use: its typed VALUES
 * template casts the payload to the field's type. A column an installer extension types by a pattern, a derived
 * relation's view column, is a use too (`TextColumnUse`). A context field an installed role reads has the domain of its
 * refined type whether a column carries it or not, since Db.open's admission validates each claim against it. The
 * domains come in the order of their first use in canonical order, a stored column's before an extra's, and each CHECK
 * is spelled from that first use, so it follows one rule whatever order the relations are met in. */
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
	for (const name of Object.keys(theory.relations).toSorted(compareStrings)) {
		const r = theory.relations[name]
		const o = owned.relations[name]
		if (r === undefined || o === undefined) {
			continue
		}
		for (const c of r.fields) {
			const regex = structuralRegex(c.type)
			const field = o.fields[c.name]
			if (regex === undefined || field === undefined) {
				continue
			}
			use(regex, { table: o.ident, column: field.column }, true)
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
		.map(({ digest, regex, uses }): TextDomainPlan => {
			const named = identity.textDomain(digest)
			const check = identity.domainCheck(named)
			return {
				domain: {
					digest,
					named,
					check,
					name: identifierOf(named),
					constraint: identifierOf(check),
					uses
				},
				refinement: refinementOf(regex)
			}
		})
}

/** The structural text domains as objects in Setup, each after the schema: their names, in order. */
export const addTextDomains = (
	b: InstallBuilder,
	plans: ReadonlyArray<TextDomainPlan>
): ReadonlyArray<ObjectName> =>
	plans.map(({ domain, refinement }) => {
		const ddl = textDomainDdl(refinement.check, {
			schema: b.schema,
			name: b.name(domain.named),
			constraint: b.name(domain.check)
		})
		b.addType(
			"domain",
			domain.named,
			{
				ddl: [ddl],
				reasons: [enforcement(`text refinement /${refinement.source}/${refinement.flags}`)]
			},
			[b.schemaNode]
		)
		return ddl.name
	})

/** A contract's domain CHECK, named: none, or its terms under its constraint's name. */
type NamedDomainCheck =
	| { readonly kind: "unchecked" }
	| {
			readonly kind: "checked"
			readonly ident: ConstraintName
			readonly terms: Extract<DomainCheck, { readonly kind: "checked" }>["terms"]
	  }

/** One contract's domain as an object in Setup, named by `named`: over the domain of the contract its base is, or the
 * unrefined base type, with its CHECK. It comes after the schema and after the type its base names, which is added
 * before it: an inner contract's domain, an enum, or the vector extension. Its name. */
const addContractDomain = (
	b: InstallBuilder,
	contract: {
		readonly name: string
		readonly named: Identity<"contractDomain">
		readonly base: ValueType
	},
	check: NamedDomainCheck,
	reasons: ReadonlyArray<PhysicalReason>
): ObjectName => {
	const { name, named, base } = contract
	const term = (t: DomainCheckTerm): Expr => {
		switch (t.kind) {
			case "pattern":
				return membership(refinementOf(t.regex).check, domainValue)
			case "predicate":
				return lowerPersistent(b.names, unwrap(predicateTree(t.predicate)), {
					reads: { kind: "domain" },
					loc: SourceLoc(`the predicate of contract ${name}`, [])
				})
		}
	}
	const { type, collation } = domainBase(b.names, base)
	const ddl: CreateDomain = {
		kind: "createDomain",
		name: { schema: b.schema, name: identifierOf(named) },
		base: type,
		collation,
		constraints:
			check.kind === "unchecked"
				? []
				: [{ name: check.ident, predicate: and(mapNonEmpty(check.terms, (t) => term(t))) }]
	}
	const baseNode = b.typeNode(type)
	b.addType("domain", named, { ddl: [ddl], reasons }, [
		b.schemaNode,
		...(baseNode === undefined ? [] : [baseNode]),
		...(isVectorRef(b, type) ? [b.provider("vector")] : [])
	])
	return ddl.name
}

/** The contract domains, in contract name order, each after the schema and after the types its base names. Every
 * contract is a law, and the law model's domain native holds its base and decides its CHECK.
 *
 * A contract is `CREATE DOMAIN <schema>.<contract> AS <base>`. Its base is an inner contract's domain, or the
 * unrefined base type, `text COLLATE pg_catalog.pg_c_utf8` for a text base. Its CHECK is the law model's
 * (`DomainCheck`): `<contract>__check`, the pattern test and the predicate as one conjunction, or none for a brand-only
 * contract over an unrefined base. No domain carries NOT NULL; every column does. The CHECK's IS TRUE wrapper is the
 * printer's. */
export const addContractDomains = (b: InstallBuilder): ReadonlyArray<ObjectName> => {
	const domains = b.natives
		.flatMap((n) => (n.namespace === "domain" ? [n] : []))
		.toSorted((x, y) => compareText(x.object.name, y.object.name))
	const byName = new Map(domains.map((d) => [d.object.name, d] as const))
	const added = new Map<string, ObjectName>()
	/** A contract's domain, after the domain of the contract its base is. */
	const add = (domain: (typeof domains)[number]): ObjectName => {
		const { object, check } = domain
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
			{ name: object.name, named: object.named, base: object.base },
			check,
			lawReasons(object.lawIds)
		)
		added.set(object.name, name)
		return name
	}
	return domains.map(add)
}

/** A contract a context field's type names that the base does not declare: its name (which names its law,
 * analysis/theory/theory.ts contractLawIdentity), its type, its domain's identity and identifier, and its CHECK's name,
 * when it has a CHECK. */
export interface ContextContract {
	readonly name: string
	readonly contract: ContractInfo
	readonly named: Identity<"contractDomain">
	readonly owner: DomainName
	readonly check: NamedDomainCheck
}

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
			const named = identity.contractDomain(unwrap(types.declare(info.name, "contract", loc)))
			const check = domainCheck(info)
			out.push({
				name: info.name,
				contract: info,
				named,
				owner: identifierOf(named),
				check:
					check.kind === "unchecked"
						? check
						: {
								kind: "checked",
								ident: identifierOf(identity.domainCheck(named)),
								terms: check.terms
							}
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
	contracts.map((c) => {
		b.name(c.named)
		if (c.check.kind === "checked") {
			b.name(identity.domainCheck(c.named))
		}
		return addContractDomain(b, { name: c.name, named: c.named, base: c.contract.base }, c.check, [
			enforcement(`contract ${c.name} of a context field`)
		])
	})

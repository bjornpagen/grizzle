import { nominal } from "#compiler/core/brand.ts"

/**
 * Branded identifiers of the owned graph.
 *
 * Every identifier is a string with a nominal brand, so a NodeId never stands where a VarId is expected. Brands carry
 * no runtime behavior. Two families exist:
 *
 * - Derived identities, computed from declared names: FieldId (relation identity plus logical field), ParamId (the
 *   parameter's declared name), the installed identifiers (Identifier of a kind, LawId among them), which the naming
 *   door (core/identity.ts) alone mints, and the content digests ProgramFingerprint and SchemaFingerprint.
 * - Allocated identities, fresh per construction: NodeId, ExprId, VarId, OccurrenceId and ScopeId. Their spelling is
 *   allocation order and carries no meaning; fingerprints rename them canonically (fingerprint.ts), so semantic
 *   identity never depends on allocation order.
 */
declare const fieldIdBrand: unique symbol
declare const occurrenceIdBrand: unique symbol
declare const varIdBrand: unique symbol
declare const scopeIdBrand: unique symbol
declare const paramIdBrand: unique symbol
declare const nodeIdBrand: unique symbol
declare const exprIdBrand: unique symbol
declare const programFingerprintBrand: unique symbol
declare const schemaFingerprintBrand: unique symbol

export type FieldId = string & { readonly [fieldIdBrand]: true }
export type OccurrenceId = string & { readonly [occurrenceIdBrand]: true }
export type VarId = string & { readonly [varIdBrand]: true }
export type ScopeId = string & { readonly [scopeIdBrand]: true }
export type ParamId = string & { readonly [paramIdBrand]: true }
export type NodeId = string & { readonly [nodeIdBrand]: true }
export type ExprId = string & { readonly [exprIdBrand]: true }
/**
 * The kinds of identity the naming door mints an identifier for (core/identity.ts), one per kind of catalog object
 * grizzle installs, declared or derived.
 */
export type IdentityKind =
	| "schema"
	| "table"
	| "view"
	| "column"
	| "decodedColumn"
	| "lawColumn"
	| "contractDomain"
	| "textDomain"
	| "rosterDomain"
	| "rosterConstant"
	| "rosterLive"
	| "bitsDomain"
	| "closedConstant"
	| "sequence"
	| "advance"
	| "primaryKey"
	| "key"
	| "check"
	| "generatedCheck"
	| "spanCheck"
	| "normCheck"
	| "dateCheck"
	| "domainCheck"
	| "foreignKey"
	| "accessIndex"
	| "statistics"
	| "derivedKey"
	| "law"
	| "patternLaw"
	| "login"
	| "role"
	| "roleSchema"
	| "roleView"
	| "filter"
	| "keyProbe"
	| "uniqueProbe"
	| "policy"
	| "ledger"
	| "ledgerKey"
	| "ledgerCheck"
	| "isolationGuard"
	| "isolationTrigger"
	| "refusal"
	| "snapshotGuard"
	| "aside"
	| "swap"

declare const identifierBrand: unique symbol
/**
 * An installed PostgreSQL identifier of an identity of kind K: minted by the naming door alone (core/identity.ts
 * identifierOf), or admitted at a decode boundary. An identifier of one kind stands where a union of kinds is expected.
 */
export type Identifier<K extends IdentityKind> = string & { readonly [identifierBrand]: K }

/** The kinds of law identity: a theory law's or a text pattern's, each of which a law function or a refusal raises. */
type RaisedLawKind = "law" | "patternLaw"
/**
 * A law's identifier, the snapshot's, its constraints' and its law function's: a theory law's or a text pattern's,
 * which a law function or a write statement's refusal raises. An outcome names the law by its description instead
 * (types/changeset Law).
 */
export type LawId = Identifier<RaisedLawKind>
/**
 * The table of a stored relation, the domain of a roster, the materialized view of a derived relation, or a role
 * relation's view, which a role reads it through.
 */
export type RelationIdent = Identifier<"table" | "rosterDomain" | "view" | "roleView">
/** The column of a field, a derived view's head name, or a law column. */
export type ColumnIdent = Identifier<"column" | "lawColumn">
/**
 * What a violation reports as its constraint: a table constraint, a derived relation's unique index, a domain
 * constraint, or the law identity a law function or a write statement's refusal raises (LawId).
 */
export type ConstraintName = Identifier<
	| "primaryKey"
	| "key"
	| "check"
	| "generatedCheck"
	| "spanCheck"
	| "normCheck"
	| "dateCheck"
	| "domainCheck"
	| "foreignKey"
	| "derivedKey"
	| RaisedLawKind
>
/** A non-unique access index the index engine creates. */
export type IndexName = Identifier<"accessIndex">
/** A contract's domain, a structural text domain, a roster's domain, or a set's domain over a roster. */
export type DomainName = Identifier<"contractDomain" | "textDomain" | "rosterDomain" | "bitsDomain">
export type ProgramFingerprint = string & { readonly [programFingerprintBrand]: true }
export type SchemaFingerprint = string & { readonly [schemaFingerprintBrand]: true }

/** Unchecked brand constructors: the caller asserts the spelling is already an identifier of that kind. */
export const OccurrenceId = nominal<string, OccurrenceId>()
export const VarId = nominal<string, VarId>()
export const ScopeId = nominal<string, ScopeId>()
export const ParamId = nominal<string, ParamId>()
export const NodeId = nominal<string, NodeId>()
export const ExprId = nominal<string, ExprId>()
export const ProgramFingerprint = nominal<string, ProgramFingerprint>()
export const SchemaFingerprint = nominal<string, SchemaFingerprint>()

/**
 * A FieldId is the injective pair (relation, field): '%' and '.' are percent-escaped in each component, so the one
 * unescaped '.' separates them and distinct pairs never share a spelling: a stable canonical field ID from the
 * relation identity and the logical field identity.
 */
const escapeComponent = (component: string): string =>
	component.replaceAll("%", "%25").replaceAll(".", "%2E")

/** One left-to-right pass; src/ uses no RegExp at all. */
const unescapeComponent = (component: string): string => {
	let out = ""
	let i = 0
	while (i < component.length) {
		const code = component.startsWith("%25", i)
			? "%"
			: component.startsWith("%2E", i)
				? "."
				: undefined
		if (code === undefined) {
			out += component[i]
			i += 1
		} else {
			out += code
			i += 3
		}
	}
	return out
}

/** A FieldId from its spelling, as a decoder admits one. */
const spelledFieldId = nominal<string, FieldId>()
export const FieldId = (relation: string, field: string): FieldId =>
	spelledFieldId(`${escapeComponent(relation)}.${escapeComponent(field)}`)

/** The components of a FieldId's spelling where a description carries it as plain text. */
export const fieldIdSpellingParts = (
	spelling: string
): { readonly relation: string; readonly field: string } => {
	const dot = spelling.indexOf(".")
	return {
		relation: unescapeComponent(spelling.slice(0, dot)),
		field: unescapeComponent(spelling.slice(dot + 1))
	}
}

/**
 * The allocated kinds and the prefix of their spelling. A prefix is not a classifier: user text can spell "n1" too,
 * so fingerprinting classifies allocated identifiers by position, never by pattern (fingerprint.ts).
 */
export const allocatedKinds = {
	node: "n",
	expr: "e",
	var: "v",
	occurrence: "o",
	scope: "s"
} as const
type AllocatedKind = keyof typeof allocatedKinds

export interface IdSupply {
	readonly node: () => NodeId
	readonly expr: () => ExprId
	readonly var: () => VarId
	readonly occurrence: () => OccurrenceId
	readonly scope: () => ScopeId
	/** How many identifiers of each kind have been handed out. */
	readonly issued: () => Readonly<Record<AllocatedKind, number>>
}

/**
 * A fresh supply per construction. Each kind counts from 1 independently; the supply is local mutable state owned
 * by one builder or pass run, never shared through module scope.
 */
export const makeIdSupply = (): IdSupply => {
	const counts: Record<AllocatedKind, number> = {
		node: 0,
		expr: 0,
		var: 0,
		occurrence: 0,
		scope: 0
	}
	const next = (kind: AllocatedKind): string => {
		counts[kind] += 1
		return `${allocatedKinds[kind]}${counts[kind]}`
	}
	return {
		node: () => NodeId(next("node")),
		expr: () => ExprId(next("expr")),
		var: () => VarId(next("var")),
		occurrence: () => OccurrenceId(next("occurrence")),
		scope: () => ScopeId(next("scope")),
		issued: () => ({ ...counts })
	}
}

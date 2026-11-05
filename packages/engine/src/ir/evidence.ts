import type { DeclaredName } from "#compiler/core/identity.ts"
import type { ConstraintName, NodeId, ParamId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/** The validity contexts evidence can hold in, from strongest to weakest scope. */
export const evidenceContexts = [
	"immediate",
	"committedSnapshot",
	"validatedTx",
	"queryLocal"
] as const
export type EvidenceContext = (typeof evidenceContexts)[number]

/**
 * The execution contexts a template is compiled for: `snapshot` for Db reads, `transaction` for reads inside a write
 * transaction, as read-backs are.
 */
const templateContexts = ["snapshot", "transaction"] as const
export type TemplateContext = (typeof templateContexts)[number]

/**
 * The installed constraint families a premise can name. A "deferred" family holds only at commit; "uniqueIndex" is
 * a derived relation's inherited key, immediate on its materialized view.
 */
export const constraintKinds = [
	"primaryKey",
	"unique",
	"check",
	"domain",
	"rosterDomain",
	"foreignKey",
	"deferredForeignKey",
	"withoutOverlaps",
	"periodForeignKey",
	"uniqueIndex"
] as const
export type ConstraintKind = (typeof constraintKinds)[number]

/**
 * An installed uniqueness constraint backing a declared key: immediate and validated, as grizzle installs every key.
 */
export interface KeyConstraint {
	readonly relation: string
	readonly columns: KeySet
	/**
	 * The key's span columns, compared WITHOUT OVERLAPS: a stored relation's key with span fields holds at most one
	 * fact whose spans hold given points for each value of its other columns. None for an equality key, a derived
	 * relation's unique index among them, which compares its spans as values.
	 */
	readonly spans: KeySet
	readonly constraint: ConstraintName
	readonly kind: Extract<ConstraintKind, "primaryKey" | "unique" | "uniqueIndex">
}

/**
 * What enforces a containment: an installed constraint, or the roster's domain itself, which types the field, so every
 * value is a live code of the roster, whose handles the schema fingerprint covers: no premise.
 */
export type Enforcement =
	| { readonly kind: "constraint"; readonly name: ConstraintName }
	| { readonly kind: "type"; readonly roster: DeclaredName }

/** An installed containment proving that a referencing fact has a referenced one. */
export interface ExistenceConstraint {
	readonly from: { readonly relation: string; readonly fields: ReadonlyArray<string> }
	readonly to: { readonly relation: string; readonly fields: ReadonlyArray<string> }
	readonly kind: Extract<
		ConstraintKind,
		"foreignKey" | "deferredForeignKey" | "periodForeignKey" | "rosterDomain" | "check"
	>
	readonly enforcement: Enforcement
	/** The theory's validity context for the containment (theory/theory.ts ContainmentEvidence). */
	readonly context: EvidenceContext
}

/**
 * A declared closed relation as a query reads it whole (ir/rel.ts Closed, as the checker builds it), and what answers
 * a membership of it without its facts: a roster, whose domain types every value of its closed id, so it holds every
 * value a column of its type can hold; or a relation keyed by closed ids, whose installed key set (ir/physical.ts
 * ClosedConstant keys) holds one bit per point of its key space. Its key fields in key order, then its payload fields,
 * are its heading, and `facts` counts its facts.
 */
export interface ClosedEvidence {
	readonly kind: "roster" | "relation"
	readonly key: NonEmptyReadonlyArray<string>
	readonly payload: ReadonlyArray<string>
	readonly facts: number
}

/** Resolves declared keys, containments and closed relations to their installed constraints and constants. */
export interface EvidenceCatalog {
	/**
	 * The constraint backing a declared key of a relation (its primary key, an additional key, or a derived
	 * relation's inherited key), or undefined when none is installed.
	 */
	readonly keyConstraint: (
		relation: string,
		columns: KeySet,
		role: { readonly primary: boolean; readonly derived: boolean }
	) => KeyConstraint | undefined
	/** The containments the schema installs. */
	readonly containments: ReadonlyArray<ExistenceConstraint>
	/** A declared closed relation by its name, or undefined when the schema declares none of that name. */
	readonly closed: (relation: string) => ClosedEvidence | undefined
}

/**
 * Evidence: the premises a proof rests on and the contexts they are valid in.
 *
 * A proof names the premises it rests on and the context in which they hold. Unknown evidence means no rewrite, never
 * a guessed default. Only the constraints the schema installs create evidence, every one of them immediate and
 * validated as grizzle installs it: SQL statistics, TypeScript assertions, approximate results and ordinary nonunique
 * indexes are none, and a deferred containment proves nothing inside a transaction (analysis/physical/evidence.ts).
 * This module fixes the vocabulary and the one rule every consumer shares: which validity contexts an execution
 * context admits.
 */
export type Premise =
	| {
			readonly kind: "constraint"
			readonly constraint: ConstraintName
			readonly constraintKind: ConstraintKind
	  }
	| { readonly kind: "node"; readonly node: NodeId }
	| { readonly kind: "param"; readonly param: ParamId }

/**
 * What a claim rests on: the premises, and the context they all hold in. A key proof (ir/keys.ts KeyProof), a key a
 * lowering rewrite relies on (lower/shapes/catalog/context.ts KeyGrounds), a physical key's justification
 * (analysis/physical/fds.ts Justification), a view's key (ir/keys.ts ViewKey) and an installed constraint's evidence
 * (analysis/physical/evidence.ts) each rest on grounds.
 */
export interface Grounds {
	readonly premises: ReadonlyArray<Premise>
	readonly context: EvidenceContext
}

/** The canonical text of a premise, which orders and deduplicates premises. */
export const premiseText = (p: Premise): string => {
	switch (p.kind) {
		case "constraint":
			return `c\u0000${p.constraint}\u0000${p.constraintKind}`
		case "node":
			return `n\u0000${p.node}`
		case "param":
			return `p\u0000${p.param}`
	}
}

/** Whether two premises name the same thing. */
export const samePremise = (a: Premise, b: Premise): boolean => {
	switch (a.kind) {
		case "constraint":
			return (
				b.kind === "constraint" &&
				a.constraint === b.constraint &&
				a.constraintKind === b.constraintKind
			)
		case "node":
			return b.kind === "node" && a.node === b.node
		case "param":
			return b.kind === "param" && a.param === b.param
	}
}

/**
 * The validity contexts an execution context admits. A snapshot read may rely on lawful committed-snapshot facts; a
 * transaction (a read-back) relies only on immediate constraints, because every deferred law may
 * still be false before COMMIT. Validated-transaction evidence needs a defined validation point,
 * which no execution context provides, so neither admits it.
 */
const admits: Readonly<Record<TemplateContext, ReadonlyArray<EvidenceContext>>> = {
	snapshot: ["immediate", "committedSnapshot", "queryLocal"],
	transaction: ["immediate", "queryLocal"]
}

export const contextAdmits = (execution: TemplateContext, item: EvidenceContext): boolean =>
	admits[execution].includes(item)

const contextRank: Readonly<Record<EvidenceContext, number>> = {
	queryLocal: 0,
	immediate: 1,
	validatedTx: 2,
	committedSnapshot: 3
}

/** The most demanding of several evidence contexts: what a claim resting on all of them needs. */
export const strongest = (contexts: ReadonlyArray<EvidenceContext>): EvidenceContext =>
	contexts.reduce<EvidenceContext>(
		(a, b) => (contextRank[b] > contextRank[a] ? b : a),
		"queryLocal"
	)

/** Whether a claim resting on context `a` holds wherever one resting on `b` does, and somewhere more. */
export const lessDemanding = (a: EvidenceContext, b: EvidenceContext): boolean =>
	contextRank[a] < contextRank[b]

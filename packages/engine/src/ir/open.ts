import type { SourceLoc } from "#compiler/core/loc.ts"
import type {
	BindingsDesc,
	BindTermDesc,
	ExprDesc,
	HeadTermDesc,
	Located,
	MatchDesc,
	Refs,
	RuleDesc,
	SourceDesc,
	Spelled,
	VarDesc
} from "#compiler/ir/desc.ts"

/**
 * A scope of the query builder, compared by identity: a build, a rule callback or an attachment child, active while it
 * runs.
 */
export interface BuilderScope {
	readonly active: boolean
}

/**
 * One call to v: the scope name it was given and where it was called. Its identity is the object: a rule holds one
 * scope of each name (query/build/rule.ts finishRule).
 */
export interface VarScope {
	readonly name: string
	readonly loc: SourceLoc
}

/**
 * A variable v minted, until its rule finishes and spells it: the build and the rule callback it was minted in, or
 * `adopted` for one minted in an attachment child outside its rules, which the child's rules adopt; the call to v that
 * minted it, its scope; the heading field v took it from; its origin; and where v was called. Its identity is the
 * object, one per field of its scope.
 */
export interface VarRef {
	readonly build: BuilderScope
	readonly owner: BuilderScope | "adopted"
	readonly scope: VarScope
	readonly field: string
	readonly origin: VarDesc["origin"]
	readonly loc: SourceLoc
}

/** A parent variable of an attachment child: the child's scope, and the parent's column it reads. */
export interface ParentRef {
	readonly scope: BuilderScope
	readonly column: string
}

/** An interior stage: the rule callback that describes it, and its id in that rule. */
export interface InteriorRef {
	readonly owner: BuilderScope
	readonly id: string
}

/**
 * The references of an open expression, one the builder is still building: each names the scope it belongs to, so a
 * rule spells it only when it is its own (query/build/rule.ts finishRule).
 */
interface Open extends Refs {
	readonly var: VarRef
	readonly parent: ParentRef
	readonly interior: InteriorRef
	readonly leaf:
		| { readonly kind: "var"; readonly var: VarRef }
		| { readonly kind: "field"; readonly field: string }
		| { readonly kind: "value" }
		| { readonly kind: "parent"; readonly column: ParentRef }
	readonly param: Spelled["param"]
	readonly paramType: Spelled["paramType"]
	readonly literalType: Spelled["literalType"]
	readonly nested: Spelled
}

/** A term's or predicate's expression, as the term protocol records it (scalar/compute/term.ts). */
export type OpenExpr = ExprDesc<Located, Open>

export type OpenBindings = BindingsDesc<Located, Open>

export type OpenBound = BindTermDesc<Located, Open>

export type OpenSource = SourceDesc<Located, Open>

export type OpenMatch = MatchDesc<Located, Open>

export type OpenHead = HeadTermDesc<Located, Open>

/** A rule's clauses as the rule builder records them, before find spells them. */
export type OpenRule = RuleDesc<Located, Open>

/** A literal: the expression that holds no reference, so it is both a Description's and an open one. */
export type LiteralExpr = Extract<ExprDesc, { readonly kind: "literal" }>

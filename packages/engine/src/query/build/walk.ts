import {
	type BindingsDesc,
	type ExprDesc,
	type HeadTermDesc,
	type MatchDesc,
	mapBindingTerms,
	mapExpr,
	mapHeadTerms,
	type RuleDesc,
	type SourceDesc
} from "#compiler/ir/desc.ts"
import type {
	InteriorRef,
	OpenBindings,
	OpenExpr,
	OpenHead,
	OpenMatch,
	OpenRule,
	OpenSource,
	ParentRef,
	VarRef
} from "#compiler/ir/open.ts"

/** How an open rule's references are spelled: a variable, a parent variable and an interior stage. */
interface Spellings {
	readonly var: (ref: VarRef) => string
	readonly parent: (ref: ParentRef) => string
	readonly interior: (ref: InteriorRef) => string
}

const spellBindings = (b: OpenBindings, s: Spellings): BindingsDesc =>
	mapBindingTerms(b, (e) => spellExpr(e, s))

const spellSource = (source: OpenSource, s: Spellings): SourceDesc => {
	switch (source.kind) {
		case "interior":
			return { kind: "interior", id: s.interior(source.id) }
		case "query":
		case "step":
			return {
				kind: source.kind,
				query: source.query,
				bind: Object.fromEntries(
					Object.entries(source.bind).map(([k, b]) => [
						k,
						b.kind === "relationParam" ? b : spellExpr(b, s)
					])
				)
			}
		case "param":
		case "paramOf":
		case "relation":
		case "self":
		case "delta":
		case "context":
		case "row":
			return source
	}
}

/** An open expression with every reference spelled. */
export const spellExpr = (e: OpenExpr, s: Spellings): ExprDesc =>
	mapExpr(e, {
		leaf: (x) =>
			x.kind === "var"
				? { kind: "var", var: s.var(x.var) }
				: x.kind === "parent"
					? { kind: "parent", column: s.parent(x.column) }
					: x,
		term: (x) => spellExpr(x, s),
		source: (x) => spellSource(x, s)
	})

/** A head term spelled: an aggregate's argument, a producer's arguments, or the scalar expression. */
const spellHead = (h: OpenHead, s: Spellings): HeadTermDesc =>
	mapHeadTerms(h, (a) => spellExpr(a, s))

const spellMatch = (m: OpenMatch, s: Spellings): MatchDesc => ({
	...m,
	source: spellSource(m.source, s),
	bindings: spellBindings(m.bindings, s)
})

/**
 * An open rule with its own clauses spelled: its matches (each source's bind map and the bindings), its where
 * predicates and its head. Its interior stages, its attachments' children and the queries its sources import are
 * nested scopes, already spelled, and are kept as they are; a relational negation (`absent`) is part of the clause it
 * appears in, its bindings and its source's bind map clause terms, the query it reads nested.
 *
 * The clauses are visited in the order they were written: the matches, then the predicates, then the head, so a
 * spelling that numbers first uses numbers them in reading order.
 */
export const spellRule = (rule: OpenRule, s: Spellings): RuleDesc => {
	const matches = rule.matches.map((m) => spellMatch(m, s))
	const where = rule.where.map((w) => spellExpr(w, s))
	const head: Record<string, HeadTermDesc> = {}
	for (const [k, h] of Object.entries(rule.head)) {
		head[k] = spellHead(h, s)
	}
	return { ...rule, matches, where, head }
}
